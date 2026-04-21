import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import { hydrateAssets } from "../lib/assets";
import { placeholders, queryRows, withConnection, type DbConnection } from "../lib/db";
import { success } from "../lib/response";
import {
  deleteTypesenseDocument,
  getTypesenseCollectionInfo,
  getTypesenseHealth,
  importTypesenseDocuments,
  searchTypesenseDocuments,
} from "../lib/typesense";

interface AssetIdRow extends RowDataPacket {
  id: string;
}

interface CountRow extends RowDataPacket {
  count: number;
}

function toTypesenseDocument(asset: Awaited<ReturnType<typeof hydrateAssets>>[number]) {
  const metadataMap = new Map(asset.metadata.map((entry) => [entry.type, entry.content]));
  const createdIn =
    asset.created_in instanceof Date
      ? Math.floor(asset.created_in.getTime() / 1000)
      : Math.floor(new Date(asset.created_in).getTime() / 1000);

  const allTags = [
    ...asset.keywords.genre,
    ...asset.keywords.mood,
    ...asset.keywords.instrument,
    ...asset.keywords.scene,
  ];

  return {
    id: asset.id,
    title: metadataMap.get("title") || "",
    tags: allTags,
    tags_genre: asset.keywords.genre,
    tags_mood: asset.keywords.mood,
    tags_instrument: asset.keywords.instrument,
    tags_scene: asset.keywords.scene,
    created_in: createdIn,
    metadata_title: metadataMap.get("title") || undefined,
    metadata_subtitle: metadataMap.get("subtitle") || undefined,
    metadata_description: metadataMap.get("description") || undefined,
    metadata_duration: Number(metadataMap.get("duration") || 0),
    metadata_bitrate: Number(metadataMap.get("bitrate") || 0),
    metadata_samplerate: Number(metadataMap.get("samplerate") || 0),
    metadata_arranger: metadataMap.get("arranger") || undefined,
    metadata_artist: metadataMap.get("artist") || undefined,
    metadata_composer: metadataMap.get("composer") || undefined,
    metadata_bpm: metadataMap.get("bpm") || undefined,
    metadata_comment: metadataMap.get("comment") || undefined,
    metadata_prompt: metadataMap.get("prompt") || undefined,
  };
}

async function listVisibleAssetIds(connection: DbConnection) {
  const rows = await queryRows<AssetIdRow>(
    connection,
    "SELECT id FROM musics WHERE is_hide = 0 ORDER BY created_in DESC",
  );
  return rows.map((row) => row.id);
}

async function loadTypesenseIds(env: Bindings) {
  const ids: string[] = [];
  let page = 1;
  const perPage = 250;

  while (true) {
    const response = await searchTypesenseDocuments<{ id: string }>(env, {
      q: "*",
      query_by: "title",
      per_page: perPage,
      page,
      include_fields: "id",
    });

    const hits = response.hits || [];
    ids.push(...hits.map((hit) => hit.document.id));
    if (hits.length < perPage) {
      break;
    }
    page += 1;
  }

  return ids;
}

async function getConsistencyReport(env: Bindings, connection: DbConnection) {
  const [dbCountRows, dbIds, typesenseIds] = await Promise.all([
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM musics WHERE is_hide = 0",
    ),
    listVisibleAssetIds(connection),
    loadTypesenseIds(env),
  ]);

  const dbIdSet = new Set(dbIds);
  const typesenseIdSet = new Set(typesenseIds);
  const missing = dbIds.filter((id) => !typesenseIdSet.has(id));
  const orphaned = typesenseIds.filter((id) => !dbIdSet.has(id));

  return {
    db_count: dbCountRows[0]?.count || 0,
    typesense_count: typesenseIds.length,
    is_consistent: missing.length === 0 && orphaned.length === 0,
    missing_count: missing.length,
    orphaned_count: orphaned.length,
    missing_sample: missing.slice(0, 25),
    orphaned_sample: orphaned.slice(0, 25),
  };
}

async function incrementalSyncAssets(env: Bindings, connection: DbConnection, assetIds: string[]) {
  if (assetIds.length === 0) {
    return {
      mode: "incremental",
      requested: 0,
      indexed: 0,
      removed: 0,
      failed: 0,
      errors: [] as string[],
    };
  }

  const visibleIds = await queryRows<AssetIdRow>(
    connection,
    `SELECT id
     FROM musics
     WHERE is_hide = 0
       AND id IN (${placeholders(assetIds.length)})`,
    assetIds,
  );
  const existingIds = visibleIds.map((row) => row.id);
  const assets = await hydrateAssets(connection, existingIds);
  const documents = assets.map(toTypesenseDocument);
  const importResult = documents.length > 0 ? await importTypesenseDocuments(env, documents, "upsert") : [];

  let removed = 0;
  const missingIds = assetIds.filter((id) => !existingIds.includes(id));
  for (const id of missingIds) {
    const result = await deleteTypesenseDocument(env, id);
    if (result.found) {
      removed += 1;
    }
  }

  const failed = importResult.filter((row) => row.success === false).length;
  const errors = importResult.flatMap((row) => (row.success === false && row.error ? [row.error] : []));

  return {
    mode: "incremental",
    requested: assetIds.length,
    indexed: importResult.filter((row) => row.success !== false).length,
    removed,
    failed,
    errors,
  };
}

export const syncRoutes = new Hono<{ Bindings: Bindings }>();

syncRoutes.get("/sync/typesense/status", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const [health, collection, dbCount] = await Promise.all([
    getTypesenseHealth(c.env).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
    getTypesenseCollectionInfo(c.env).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
    withConnection(c.env, async (connection) => {
      const rows = await queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM musics WHERE is_hide = 0",
      );
      return rows[0]?.count || 0;
    }).catch(() => 0),
  ]);

  return c.json(
    success({
      health,
      collection,
      dbVisibleAssets: dbCount,
      runtime: "worker",
      queue: {
        supported: false,
        reason: "Node in-memory queue is not carried into the Worker runtime",
      },
      timestamp: new Date().toISOString(),
    }, "Typesense sync status retrieved"),
  );
});

syncRoutes.get("/sync/typesense/consistency", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const report = await withConnection(c.env, async (connection) => getConsistencyReport(c.env, connection));
  return c.json(success(report, "Typesense consistency report retrieved"));
});

syncRoutes.post("/sync/typesense/incremental", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    assetIds?: string[];
  };

  if (!Array.isArray(body.assetIds) || body.assetIds.length === 0) {
    throw new HTTPException(400, { message: "assetIds 배열이 필요합니다." });
  }
  if (body.assetIds.length > 10000) {
    throw new HTTPException(400, { message: "한 번에 최대 10,000개의 자산만 동기화할 수 있습니다." });
  }

  const result = await withConnection(c.env, async (connection) =>
    incrementalSyncAssets(c.env, connection, body.assetIds || []),
  );

  return c.json(success(result, "증분 동기화가 완료되었습니다."));
});

syncRoutes.post("/sync/typesense/full", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const result = await withConnection(c.env, async (connection) => {
    const assetIds = await listVisibleAssetIds(connection);
    const syncResult = await incrementalSyncAssets(c.env, connection, assetIds);
    return {
      mode: "full-current-collection",
      requested: syncResult.requested,
      indexed: syncResult.indexed,
      removed: syncResult.removed,
      failed: syncResult.failed,
      errors: syncResult.errors,
      total: assetIds.length,
    };
  });

  return c.json(success(result, "현재 컬렉션 기준 전체 동기화가 완료되었습니다."));
});

syncRoutes.post("/sync/typesense/fix", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const result = await withConnection(c.env, async (connection) => {
    const report = await getConsistencyReport(c.env, connection);
    let removed = 0;
    for (const id of report.orphaned_sample) {
      const deleteResult = await deleteTypesenseDocument(c.env, id);
      if (deleteResult.found) {
        removed += 1;
      }
    }

    const syncResult = await incrementalSyncAssets(c.env, connection, report.missing_sample);
    return {
      checked: {
        db_count: report.db_count,
        typesense_count: report.typesense_count,
        missing_count: report.missing_count,
        orphaned_count: report.orphaned_count,
      },
      removed_orphaned_sample_count: removed,
      indexed_missing_sample_count: syncResult.indexed,
      sync_result: syncResult,
      note: "Worker fix currently processes sampled IDs first to stay safe in edge runtime.",
    };
  });

  return c.json(success(result, "정합성 수정이 완료되었습니다."));
});

syncRoutes.get("/sync/typesense/export", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const jsonl = await withConnection(c.env, async (connection) => {
    const assetIds = await listVisibleAssetIds(connection);
    const assets = await hydrateAssets(connection, assetIds);
    return assets.map((asset) => JSON.stringify(toTypesenseDocument(asset))).join("\n");
  });

  c.header("Content-Type", "application/jsonl; charset=utf-8");
  return c.body(jsonl);
});
