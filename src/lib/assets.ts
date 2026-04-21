import type { RowDataPacket } from "mysql2/promise";
import { placeholders, queryRows, type DbConnection } from "./db";

export const VALID_TAG_TYPES = ["genre", "mood", "instrument", "scene"] as const;
export type ValidTagType = (typeof VALID_TAG_TYPES)[number];

interface MusicRow extends RowDataPacket {
  id: string;
  created_in: Date;
  last_modified: Date;
}

interface MetadataRow extends RowDataPacket {
  parent: string;
  type: string;
  content: string;
}

interface KeywordRow extends RowDataPacket {
  parent: string;
  type: string;
  content: string;
}

interface FileRow extends RowDataPacket {
  parent: string;
  type: string;
}

export interface AssetListItem {
  id: string;
  created_in: Date;
  last_modified: Date;
  metadata: Array<{ type: string; content: string }>;
  keywords: Record<string, string[]>;
  files: string[];
}

export interface AssetSearchOptions {
  q?: string;
  genre?: string[];
  mood?: string[];
  instrument?: string[];
  scene?: string[];
  excludeGenre?: string[];
  excludeMood?: string[];
  excludeInstrument?: string[];
  excludeScene?: string[];
  durationMin?: number;
  durationMax?: number;
  page: number;
  limit: number;
}

function createKeywordGroup(): Record<string, string[]> {
  return {
    genre: [],
    mood: [],
    instrument: [],
    scene: [],
  };
}

export async function hydrateAssets(connection: DbConnection, ids: string[]): Promise<AssetListItem[]> {
  if (ids.length === 0) {
    return [];
  }

  const inList = placeholders(ids.length);
  const musicRows = await queryRows<MusicRow>(
    connection,
    `SELECT id, created_in, last_modified
     FROM musics
     WHERE id IN (${inList})`,
    ids,
  );

  const metadataRows = await queryRows<MetadataRow>(
    connection,
    `SELECT m.parent, mm.name AS type, m.content
     FROM music_metadata m
     JOIN metadata_type mm ON m.type = mm.id
     WHERE m.parent IN (${inList})`,
    ids,
  );

  const keywordRows = await queryRows<KeywordRow>(
    connection,
    `SELECT mt.parent, t.type, t.content
     FROM music_tags mt
     JOIN tags_list t ON mt.tag_id = t.id
     WHERE mt.parent IN (${inList})`,
    ids,
  );

  const fileRows = await queryRows<FileRow>(
    connection,
    `SELECT parent, type
     FROM music_files
     WHERE parent IN (${inList})
       AND type != 'origin'`,
    ids,
  );

  const metadataMap = new Map<string, Array<{ type: string; content: string }>>();
  const keywordMap = new Map<string, Record<string, string[]>>();
  const fileMap = new Map<string, string[]>();

  for (const row of metadataRows) {
    const list = metadataMap.get(row.parent) || [];
    list.push({ type: row.type, content: row.content });
    metadataMap.set(row.parent, list);
  }

  for (const row of keywordRows) {
    const grouped = keywordMap.get(row.parent) || createKeywordGroup();
    const key = row.type as ValidTagType;
    if (VALID_TAG_TYPES.includes(key)) {
      grouped[key].push(row.content);
    } else {
      if (!grouped[row.type]) {
        grouped[row.type] = [];
      }
      grouped[row.type].push(row.content);
    }
    keywordMap.set(row.parent, grouped);
  }

  for (const row of fileRows) {
    const list = fileMap.get(row.parent) || [];
    list.push(row.type);
    fileMap.set(row.parent, list);
  }

  const order = new Map(ids.map((id, index) => [id, index]));

  return musicRows
    .map((row) => ({
      id: row.id,
      created_in: row.created_in,
      last_modified: row.last_modified,
      metadata: metadataMap.get(row.id) || [],
      keywords: keywordMap.get(row.id) || createKeywordGroup(),
      files: fileMap.get(row.id) || [],
    }))
    .sort((left, right) => (order.get(left.id) || 0) - (order.get(right.id) || 0));
}

function buildTypedTagClause(
  alias: string,
  type: ValidTagType,
  values: string[] | undefined,
  negate = false,
): { clause: string; params: string[] } | null {
  if (!values || values.length === 0) {
    return null;
  }

  const valuePlaceholders = placeholders(values.length);
  const operator = negate ? "NOT EXISTS" : "EXISTS";

  return {
    clause: `${operator} (
      SELECT 1
      FROM music_tags mt
      JOIN tags_list t ON mt.tag_id = t.id
      WHERE mt.parent = ${alias}.id
        AND t.type = ?
        AND t.content IN (${valuePlaceholders})
    )`,
    params: [type, ...values],
  };
}

export function buildAssetSearchWhere(options: AssetSearchOptions, alias = "m"): { clause: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.q && options.q.trim()) {
    const like = `%${options.q.trim()}%`;
    clauses.push(`(
      EXISTS (
        SELECT 1
        FROM music_metadata mm2
        JOIN metadata_type mt2 ON mm2.type = mt2.id
        WHERE mm2.parent = ${alias}.id
          AND mt2.name IN ('title', 'subtitle', 'description', 'artist', 'composer', 'arranger', 'prompt', 'comment')
          AND mm2.content LIKE ?
      )
      OR EXISTS (
        SELECT 1
        FROM music_tags mt
        JOIN tags_list t ON mt.tag_id = t.id
        WHERE mt.parent = ${alias}.id
          AND t.content LIKE ?
      )
    )`);
    params.push(like, like);
  }

  const includeClauses = [
    buildTypedTagClause(alias, "genre", options.genre),
    buildTypedTagClause(alias, "mood", options.mood),
    buildTypedTagClause(alias, "instrument", options.instrument),
    buildTypedTagClause(alias, "scene", options.scene),
    buildTypedTagClause(alias, "genre", options.excludeGenre, true),
    buildTypedTagClause(alias, "mood", options.excludeMood, true),
    buildTypedTagClause(alias, "instrument", options.excludeInstrument, true),
    buildTypedTagClause(alias, "scene", options.excludeScene, true),
  ].filter(Boolean) as Array<{ clause: string; params: string[] }>;

  for (const item of includeClauses) {
    clauses.push(item.clause);
    params.push(...item.params);
  }

  if (options.durationMin !== undefined || options.durationMax !== undefined) {
    if (options.durationMin !== undefined) {
      clauses.push(`EXISTS (
        SELECT 1
        FROM music_metadata mm3
        JOIN metadata_type mt3 ON mm3.type = mt3.id
        WHERE mm3.parent = ${alias}.id
          AND mt3.name = 'duration'
          AND CAST(mm3.content AS DECIMAL(10,2)) >= ?
      )`);
      params.push(options.durationMin);
    }

    if (options.durationMax !== undefined) {
      clauses.push(`EXISTS (
        SELECT 1
        FROM music_metadata mm4
        JOIN metadata_type mt4 ON mm4.type = mt4.id
        WHERE mm4.parent = ${alias}.id
          AND mt4.name = 'duration'
          AND CAST(mm4.content AS DECIMAL(10,2)) <= ?
      )`);
      params.push(options.durationMax);
    }
  }

  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
