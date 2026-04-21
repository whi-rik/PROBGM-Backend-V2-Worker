import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { optionalSessionFromRequest, requireSessionFromRequest } from "../lib/auth";
import { placeholders, queryRows, withConnection, type DbConnection } from "../lib/db";
import { success } from "../lib/response";

interface PlaylistRow extends RowDataPacket {
  id: string;
  user_id: string;
  title: string;
  description: string;
  created_in: Date;
  updated_at: Date | null;
  is_hide: number;
  is_default: number;
  is_public: number;
  category: string | null;
  like_count: number;
  music_count: number;
}

interface PermissionRow extends RowDataPacket {
  user_id: string;
  permission_type: "read" | "write" | "admin";
}

interface MusicOrderRow extends RowDataPacket {
  music_id: string;
  sort_order: number;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

async function getMetadataForPlaylists(connection: DbConnection, ids: string[]) {
  if (ids.length === 0) {
    return {};
  }

  const rows = await queryRows<RowDataPacket & { playlist_id: string; meta_key: string; meta_value: string }>(
    connection,
    `SELECT playlist_id, meta_key, meta_value
     FROM playlist_metadata
     WHERE playlist_id IN (${placeholders(ids.length)})`,
    ids,
  );

  const map: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (!map[row.playlist_id]) {
      map[row.playlist_id] = {};
    }
    try {
      map[row.playlist_id][row.meta_key] = JSON.parse(row.meta_value);
    } catch {
      map[row.playlist_id][row.meta_key] = row.meta_value;
    }
  }
  return map;
}

async function mapPlaylistRows(connection: DbConnection, rows: PlaylistRow[], likedByUserId?: string | null) {
  const metadata = await getMetadataForPlaylists(connection, rows.map((row) => row.id));
  const likedMap = new Map<string, boolean>();

  if (likedByUserId && rows.length > 0) {
    const likedRows = await queryRows<RowDataPacket & { playlist_id: string }>(
      connection,
      `SELECT playlist_id
       FROM playlist_likes
       WHERE user_id = ?
         AND playlist_id IN (${placeholders(rows.length)})`,
      [likedByUserId, ...rows.map((row) => row.id)],
    );
    for (const row of likedRows) {
      likedMap.set(row.playlist_id, true);
    }
  }

  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    description: row.description,
    created_in: row.created_in,
    updated_at: row.updated_at,
    is_hide: Boolean(row.is_hide),
    is_default: Boolean(row.is_default),
    is_public: Boolean(row.is_public),
    category: row.category,
    like_count: row.like_count ?? 0,
    music_count: row.music_count,
    liked: likedMap.get(row.id) || false,
    thumbnail: metadata[row.id]?.thumbnail || null,
    cover_image_url: metadata[row.id]?.cover_image_url || null,
    metadata: metadata[row.id] || {},
  }));
}

async function listPlaylists(
  connection: DbConnection,
  query: string,
  params: Array<string | number>,
  likedByUserId?: string | null,
) {
  const rows = await queryRows<PlaylistRow>(connection, query, params);
  return mapPlaylistRows(connection, rows, likedByUserId);
}

async function getPlaylistOwnership(connection: DbConnection, playlistId: string, userId: string) {
  const rows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     WHERE p.id = ? AND p.is_hide = 0
     GROUP BY p.id`,
    [playlistId],
  );
  const playlist = rows[0];
  if (!playlist) {
    throw new HTTPException(404, { message: "Playlist not found" });
  }

  if (playlist.user_id === userId) {
    return playlist;
  }

  const permissions = await queryRows<PermissionRow>(
    connection,
    `SELECT user_id, permission_type
     FROM playlist_permissions
     WHERE playlist_id = ?
       AND user_id = ?
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [playlistId, userId],
  );

  const level = permissions[0]?.permission_type;
  if (level === "write" || level === "admin") {
    return playlist;
  }

  throw new HTTPException(403, { message: "Playlist write access denied" });
}

async function getPlaylistMusicIds(connection: DbConnection, playlistId: string) {
  const rows = await queryRows<MusicOrderRow>(
    connection,
    `SELECT music_id, sort_order
     FROM playlist_music
     WHERE playlist_id = ?
     ORDER BY sort_order ASC, added_at ASC`,
    [playlistId],
  );
  return rows;
}

async function reorderMusics(connection: DbConnection, playlistId: string, musicIds: string[]) {
  const existingRows = await getPlaylistMusicIds(connection, playlistId);
  const existingIds = existingRows.map((row) => row.music_id);

  if (existingIds.length !== musicIds.length) {
    throw new HTTPException(400, { message: "musicIds must include every track in the playlist" });
  }

  const existingSet = new Set(existingIds);
  const incomingSet = new Set(musicIds);
  if (incomingSet.size !== musicIds.length) {
    throw new HTTPException(400, { message: "musicIds contains duplicates" });
  }
  for (const id of musicIds) {
    if (!existingSet.has(id)) {
      throw new HTTPException(400, { message: `Music ${id} is not in the playlist` });
    }
  }

  for (const [index, musicId] of musicIds.entries()) {
    await queryRows(
      connection,
      `UPDATE playlist_music
       SET sort_order = ?
       WHERE playlist_id = ? AND music_id = ?`,
      [index, playlistId, musicId],
    );
  }

  await queryRows(connection, "UPDATE playlist SET updated_at = NOW() WHERE id = ?", [playlistId]);
}

async function updateMusicOrder(connection: DbConnection, playlistId: string, musicId: string, newOrder: number) {
  const rows = await getPlaylistMusicIds(connection, playlistId);
  const ids = rows.map((row) => row.music_id);
  const currentIndex = ids.indexOf(musicId);
  if (currentIndex === -1) {
    throw new HTTPException(404, { message: "Music not found in playlist" });
  }

  const boundedOrder = Math.max(0, Math.min(ids.length - 1, newOrder));
  if (boundedOrder === currentIndex) {
    return;
  }

  ids.splice(currentIndex, 1);
  ids.splice(boundedOrder, 0, musicId);
  await reorderMusics(connection, playlistId, ids);
}

async function toggleLike(connection: DbConnection, userId: string, playlistId: string) {
  const playlistRows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, 0 AS music_count
     FROM playlist p
     WHERE p.id = ? AND p.is_hide = 0
     LIMIT 1`,
    [playlistId],
  );
  if (!playlistRows[0]) {
    throw new HTTPException(404, { message: "Playlist not found" });
  }

  const likedRows = await queryRows<RowDataPacket & { playlist_id: string }>(
    connection,
    "SELECT playlist_id FROM playlist_likes WHERE user_id = ? AND playlist_id = ?",
    [userId, playlistId],
  );

  let liked = false;
  if (likedRows[0]) {
    await queryRows(
      connection,
      "DELETE FROM playlist_likes WHERE user_id = ? AND playlist_id = ?",
      [userId, playlistId],
    );
    await queryRows(
      connection,
      "UPDATE playlist SET like_count = GREATEST(COALESCE(like_count, 0) - 1, 0) WHERE id = ?",
      [playlistId],
    );
    liked = false;
  } else {
    await queryRows(
      connection,
      "INSERT INTO playlist_likes (user_id, playlist_id) VALUES (?, ?)",
      [userId, playlistId],
    );
    await queryRows(
      connection,
      "UPDATE playlist SET like_count = COALESCE(like_count, 0) + 1 WHERE id = ?",
      [playlistId],
    );
    liked = true;
  }

  const countRows = await queryRows<RowDataPacket & { like_count: number }>(
    connection,
    "SELECT COALESCE(like_count, 0) AS like_count FROM playlist WHERE id = ?",
    [playlistId],
  );

  return { liked, likeCount: countRows[0]?.like_count || 0 };
}

async function duplicatePlaylist(connection: DbConnection, playlistId: string, userId: string) {
  const rows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     WHERE p.id = ? AND p.is_hide = 0
     GROUP BY p.id`,
    [playlistId],
  );
  const source = rows[0];
  if (!source) {
    throw new HTTPException(404, { message: "Playlist not found" });
  }

  await queryRows(
    connection,
    `INSERT INTO playlist (id, user_id, title, description, created_in, is_hide, is_default, is_public)
     VALUES (?, ?, ?, ?, NOW(), 0, 0, 0)`,
    [crypto.randomUUID(), userId, `${source.title} (copy)`, source.description],
  );

  const createdRows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, 0 AS music_count
     FROM playlist p
     WHERE p.user_id = ?
     ORDER BY p.created_in DESC
     LIMIT 1`,
    [userId],
  );
  const created = createdRows[0];
  if (!created) {
    throw new HTTPException(500, { message: "Duplicate failed" });
  }

  await queryRows(
    connection,
    `INSERT INTO playlist_music (playlist_id, music_id, added_at, sort_order, custom_title)
     SELECT ?, music_id, NOW(), sort_order, custom_title
     FROM playlist_music
     WHERE playlist_id = ?
     ORDER BY sort_order ASC`,
    [created.id, playlistId],
  );

  const metadata = await getMetadataForPlaylists(connection, [playlistId]);
  const sourceMetadata = metadata[playlistId] || {};
  for (const [key, value] of Object.entries(sourceMetadata)) {
    await queryRows(
      connection,
      `INSERT INTO playlist_metadata (id, playlist_id, meta_key, meta_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [crypto.randomUUID(), created.id, key, typeof value === "string" ? value : JSON.stringify(value)],
    );
  }

  return created.id;
}

export const v2PlaylistRoutes = new Hono<{ Bindings: Bindings }>();

v2PlaylistRoutes.put("/playlist/:id/reorder", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = await c.req.json().catch(() => ({} as { musicIds?: string[] }));
  const musicIds = Array.isArray(body.musicIds) ? body.musicIds : [];
  if (musicIds.length === 0) {
    throw new HTTPException(400, { message: "musicIds array is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    await getPlaylistOwnership(connection, playlistId, session.user.id);
    await reorderMusics(connection, playlistId, musicIds);
    return { reordered: musicIds.length };
  });

  return c.json(success(data));
});

v2PlaylistRoutes.patch("/playlist/:id/music/:musicId/order", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const musicId = c.req.param("musicId");
  const body = await c.req.json().catch(() => ({} as { newOrder?: number }));
  const newOrder = Number(body.newOrder);
  if (!Number.isFinite(newOrder) || newOrder < 0) {
    throw new HTTPException(400, { message: "newOrder must be a non-negative number" });
  }

  const data = await withConnection(c.env, async (connection) => {
    await getPlaylistOwnership(connection, playlistId, session.user.id);
    await updateMusicOrder(connection, playlistId, musicId, Math.floor(newOrder));
    return { musicId, newOrder: Math.floor(newOrder) };
  });

  return c.json(success(data));
});

v2PlaylistRoutes.post("/playlist/:id/like", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const data = await withConnection(c.env, (connection) => toggleLike(connection, session.user.id, playlistId));
  return c.json(success(data));
});

v2PlaylistRoutes.get("/playlists/liked", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 20, 100);
  const offset = (page - 1) * limit;

  const data = await withConnection(c.env, (connection) =>
    listPlaylists(
      connection,
      `SELECT p.*, COUNT(pm.music_id) AS music_count
       FROM playlist_likes pl
       JOIN playlist p ON pl.playlist_id = p.id
       LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
       WHERE pl.user_id = ? AND p.is_hide = 0
       GROUP BY p.id
       ORDER BY pl.created_at DESC
       LIMIT ? OFFSET ?`,
      [session.user.id, limit, offset],
      session.user.id,
    ),
  );

  return c.json(success(data));
});

v2PlaylistRoutes.get("/playlists/popular", async (c) => {
  const session = await optionalSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 20, 100);
  const offset = (page - 1) * limit;

  const data = await withConnection(c.env, (connection) =>
    listPlaylists(
      connection,
      `SELECT p.*, COUNT(pm.music_id) AS music_count
       FROM playlist p
       LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
       WHERE p.is_public = 1 AND p.is_hide = 0
       GROUP BY p.id
       ORDER BY COALESCE(p.like_count, 0) DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
      session?.user.id || null,
    ),
  );

  return c.json(success(data));
});

v2PlaylistRoutes.get("/playlists/category/:category", async (c) => {
  const session = await optionalSessionFromRequest(c.env, c.req.header("Authorization"));
  const category = c.req.param("category");
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 20, 100);
  const offset = (page - 1) * limit;

  const data = await withConnection(c.env, (connection) =>
    listPlaylists(
      connection,
      `SELECT p.*, COUNT(pm.music_id) AS music_count
       FROM playlist p
       LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
       WHERE p.category = ? AND p.is_public = 1 AND p.is_hide = 0
       GROUP BY p.id
       ORDER BY COALESCE(p.like_count, 0) DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`,
      [category, limit, offset],
      session?.user.id || null,
    ),
  );

  return c.json(success(data));
});

v2PlaylistRoutes.post("/playlist/:id/duplicate", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const id = await duplicatePlaylist(connection, playlistId, session.user.id);
    return { id };
  });

  return c.json(success(data), 201);
});

v2PlaylistRoutes.put("/playlist/:id/cover", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = await c.req.json().catch(() => ({} as { cover_image_url?: string }));

  if (!body.cover_image_url || typeof body.cover_image_url !== "string") {
    throw new HTTPException(400, { message: "cover_image_url is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistOwnership(connection, playlistId, session.user.id);
    if (playlist.user_id !== session.user.id) {
      throw new HTTPException(403, { message: "Only the owner can update cover image" });
    }

    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      `SELECT id FROM playlist_metadata WHERE playlist_id = ? AND meta_key = 'cover_image_url' LIMIT 1`,
      [playlistId],
    );
    if (existing[0]) {
      await queryRows(
        connection,
        `UPDATE playlist_metadata SET meta_value = ?, updated_at = NOW() WHERE id = ?`,
        [body.cover_image_url, existing[0].id],
      );
    } else {
      await queryRows(
        connection,
        `INSERT INTO playlist_metadata (id, playlist_id, meta_key, meta_value, created_at, updated_at)
         VALUES (?, ?, 'cover_image_url', ?, NOW(), NOW())`,
        [crypto.randomUUID(), playlistId, body.cover_image_url],
      );
    }

    return { cover_image_url: body.cover_image_url };
  });

  return c.json(success(data));
});
