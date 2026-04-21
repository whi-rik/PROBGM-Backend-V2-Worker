import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { withConnection, placeholders, queryRows, type DbConnection } from "../lib/db";
import { buildAssetSearchWhere, hydrateAssets, VALID_TAG_TYPES, type ValidTagType } from "../lib/assets";
import { success } from "../lib/response";
import { searchTagsInTypesense } from "../lib/typesense";

interface TagRow extends RowDataPacket {
  id: number;
  type: string;
  content: string;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface AssetIdRow extends RowDataPacket {
  id: string;
}

function parseListParam(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return list.length > 0 ? list : undefined;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseNonNegativeInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(max, Math.floor(parsed)));
}

async function getAllTags(connection: DbConnection) {
  const rows = await queryRows<TagRow>(
    connection,
    `SELECT type, content
     FROM tags_list
     WHERE content IS NOT NULL
     ORDER BY type ASC, content ASC`,
  );

  const grouped: Record<string, string[]> = {};
  for (const type of VALID_TAG_TYPES) {
    grouped[type] = [];
  }

  for (const row of rows) {
    if (!grouped[row.type]) {
      grouped[row.type] = [];
    }
    grouped[row.type].push(row.content);
  }

  return grouped;
}

async function getTagStats(connection: DbConnection) {
  const totalRows = await queryRows<CountRow>(
    connection,
    `SELECT COUNT(*) AS count FROM tags_list WHERE content IS NOT NULL`,
  );
  const typeRows = await queryRows<(RowDataPacket & { type: string; count: number })>(
    connection,
    `SELECT type, COUNT(*) AS count
     FROM tags_list
     WHERE content IS NOT NULL
     GROUP BY type
     ORDER BY type ASC`,
  );

  return {
    totalTags: totalRows[0]?.count || 0,
    totalTypes: typeRows.length,
    tagsByType: Object.fromEntries(typeRows.map((row) => [row.type, row.count])),
  };
}

async function searchTagsFallback(
  connection: DbConnection,
  query: string,
  types: string[] | undefined,
  limit: number,
) {
  const params: Array<string | number> = [`%${query}%`];
  let sql = `
    SELECT id, type, content
    FROM tags_list
    WHERE content LIKE ?
  `;

  if (types && types.length > 0) {
    sql += ` AND type IN (${placeholders(types.length)})`;
    params.push(...types);
  }

  sql += ` ORDER BY content ASC LIMIT ?`;
  params.push(limit);

  return queryRows<TagRow>(connection, sql, params);
}

async function searchAssets(connection: DbConnection, queryString: URLSearchParams) {
  const page = parsePositiveInt(queryString.get("page"), 1, 10000);
  const limit = parsePositiveInt(queryString.get("limit"), 20, 100);

  const options = {
    q: queryString.get("q") || undefined,
    genre: parseListParam(queryString.get("genre")),
    mood: parseListParam(queryString.get("mood")),
    instrument: parseListParam(queryString.get("instrument")),
    scene: parseListParam(queryString.get("scene")),
    excludeGenre: parseListParam(queryString.get("exclude_genre")),
    excludeMood: parseListParam(queryString.get("exclude_mood")),
    excludeInstrument: parseListParam(queryString.get("exclude_instrument")),
    excludeScene: parseListParam(queryString.get("exclude_scene")),
    durationMin: queryString.get("duration_min") ? Number(queryString.get("duration_min")) : undefined,
    durationMax: queryString.get("duration_max") ? Number(queryString.get("duration_max")) : undefined,
    page,
    limit,
  };

  const { clause, params } = buildAssetSearchWhere(options, "m");
  const countRows = await queryRows<CountRow>(
    connection,
    `SELECT COUNT(*) AS count
     FROM musics m
     ${clause}`,
    params,
  );

  const idRows = await queryRows<AssetIdRow>(
    connection,
    `SELECT m.id
     FROM musics m
     ${clause}
     ORDER BY m.created_in DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );

  const items = await hydrateAssets(
    connection,
    idRows.map((row) => row.id),
  );

  let facets: Record<string, { counts: Array<{ value: string; count: number }>; total_values: number; sampled: boolean }> | undefined;
  if (queryString.get("facet") === "1" || queryString.get("facet") === "true") {
    const facetRows = await queryRows<(RowDataPacket & { type: string; content: string; count: number })>(
      connection,
      `SELECT t.type, t.content, COUNT(DISTINCT mt.parent) AS count
       FROM musics m
       JOIN music_tags mt ON mt.parent = m.id
       JOIN tags_list t ON mt.tag_id = t.id
       ${clause}
       GROUP BY t.type, t.content
       ORDER BY t.type ASC, count DESC, t.content ASC`,
      params,
    );

    facets = {};
    for (const row of facetRows) {
      const fieldName = `tags_${row.type}`;
      if (!facets[fieldName]) {
        facets[fieldName] = {
          counts: [],
          total_values: 0,
          sampled: false,
        };
      }
      facets[fieldName].counts.push({ value: row.content, count: row.count });
      facets[fieldName].total_values += 1;
    }
  }

  return {
    items: items.map((item) => ({
      id: item.id,
      metadata: item.metadata,
      keywords: item.keywords,
      files: item.files,
      relevance_score: 1,
    })),
    pagination: {
      page,
      limit,
      total: countRows[0]?.count || 0,
      total_pages: Math.ceil((countRows[0]?.count || 0) / limit),
    },
    ...(facets ? { facets } : {}),
    source: "mysql_fallback",
  };
}

async function listAssets(connection: DbConnection, queryString: URLSearchParams) {
  const page = parseNonNegativeInt(queryString.get("p") || queryString.get("page"), 0, 10000);
  const limit = parsePositiveInt(queryString.get("limit"), 30, 100);
  const assetType = queryString.get("assetType");

  const params: Array<string | number> = [];
  let sql = `SELECT id FROM musics`;

  if (assetType) {
    sql += ` WHERE asset_type = ?`;
    params.push(assetType);
  }

  sql += ` ORDER BY created_in DESC LIMIT ? OFFSET ?`;
  params.push(limit, page * limit);

  const idRows = await queryRows<AssetIdRow>(connection, sql, params);
  return hydrateAssets(
    connection,
    idRows.map((row) => row.id),
  );
}

export const v3Routes = new Hono<{ Bindings: Bindings }>();

v3Routes.get("/tags", async (c) => {
  const data = await withConnection(c.env, (connection) => getAllTags(connection));
  return c.json(success(data));
});

v3Routes.get("/tags/stats", async (c) => {
  const data = await withConnection(c.env, (connection) => getTagStats(connection));
  return c.json(success(data));
});

v3Routes.get("/tags/search", async (c) => {
  const q = c.req.query("q")?.trim();
  if (!q) {
    throw new HTTPException(400, { message: "Search query (q) is required" });
  }

  const typesParam = c.req.query("types");
  const types = typesParam
    ? typesParam
        .split(",")
        .map((item) => item.trim())
        .filter((item) => VALID_TAG_TYPES.includes(item as ValidTagType))
    : undefined;
  const limit = parsePositiveInt(c.req.query("limit") || null, 15, 50);

  try {
    const typesenseResult = await searchTagsInTypesense(c.env, q, types, limit);
    if (typesenseResult) {
      return c.json(success(typesenseResult));
    }
  } catch (error) {
    console.warn("[v2-worker] Typesense tag search failed, falling back to SQL", error);
  }

  const data = await withConnection(c.env, (connection) => searchTagsFallback(connection, q, types, limit));
  return c.json(success(data));
});

v3Routes.get("/tags/:type", async (c) => {
  const type = c.req.param("type");
  if (!VALID_TAG_TYPES.includes(type as ValidTagType)) {
    throw new HTTPException(400, {
      message: `Invalid tag type: '${type}'. Must be one of: ${VALID_TAG_TYPES.join(", ")}`,
    });
  }

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<TagRow>(
      connection,
      `SELECT DISTINCT content
       FROM tags_list
       WHERE type = ?
         AND content IS NOT NULL
       ORDER BY content ASC`,
      [type],
    );
    return rows.map((row) => row.content);
  });

  return c.json(success(data));
});

v3Routes.get("/assets/list", async (c) => {
  const data = await withConnection(c.env, (connection) =>
    listAssets(connection, new URL(c.req.url).searchParams),
  );
  return c.json(success(data));
});

v3Routes.get("/assets/search", async (c) => {
  const data = await withConnection(c.env, (connection) =>
    searchAssets(connection, new URL(c.req.url).searchParams),
  );
  return c.json(success(data));
});

v3Routes.get("/assets/:id", async (c) => {
  const id = c.req.param("id");
  const item = await withConnection(c.env, async (connection) => {
    const data = await hydrateAssets(connection, [id]);
    return data[0] || null;
  });

  if (!item) {
    throw new HTTPException(404, { message: "Asset not found" });
  }

  return c.json(
    success({
      id: item.id,
      metadata: item.metadata,
      keywords: item.keywords,
      files: item.files,
    }),
  );
});
