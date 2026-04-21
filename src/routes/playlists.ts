import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import {
  withConnection,
  placeholders,
  queryRows,
  type DbConnection,
} from "../lib/db";
import { hydrateAssets } from "../lib/assets";
import { success } from "../lib/response";
import {
  optionalSessionFromRequest,
  requireSessionFromRequest,
  type AuthSession,
} from "../lib/auth";

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
  music_count: number;
}

interface PlaylistMetadataRow extends RowDataPacket {
  playlist_id: string;
  meta_key: string;
  meta_value: string;
}

interface MusicIdRow extends RowDataPacket {
  music_id: string;
}

interface PermissionRow extends RowDataPacket {
  id?: string;
  playlist_id: string;
  user_id: string;
  permission_type: "read" | "write" | "admin";
  granted_by?: string | null;
  granted_at?: Date;
  expires_at?: Date | null;
}

interface PlaylistCreateBody {
  title?: string;
  description?: string;
  is_public?: boolean;
  metadata?: Record<string, string>;
}

interface PlaylistMusicBody {
  playlist_id?: string;
  music_id?: string;
}

interface PlaylistUpdateBody {
  title?: string;
  description?: string;
  is_public?: boolean;
  is_hide?: boolean;
  metadata?: Record<string, string>;
}

interface CustomTitleBody {
  custom_title?: string | null;
}

interface GrantPermissionBody {
  user_id?: string;
  permission_type?: "read" | "write" | "admin";
  expires_at?: string;
}

interface CoverBody {
  cover_image_url?: string;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function normalizeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value === "true" || value === "1";
  }
  return fallback;
}

async function getMetadataForPlaylists(connection: DbConnection, ids: string[]) {
  if (ids.length === 0) {
    return {};
  }

  const rows = await queryRows<PlaylistMetadataRow>(
    connection,
    `SELECT playlist_id, meta_key, meta_value
     FROM playlist_metadata
     WHERE playlist_id IN (${placeholders(ids.length)})`,
    ids,
  );

  const result: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (!result[row.playlist_id]) {
      result[row.playlist_id] = {};
    }

    try {
      result[row.playlist_id][row.meta_key] = JSON.parse(row.meta_value);
    } catch {
      result[row.playlist_id][row.meta_key] = row.meta_value;
    }
  }

  return result;
}

async function getPlaylistsByQuery(
  connection: DbConnection,
  query: string,
  params: Array<string | number>,
) {
  const rows = await queryRows<PlaylistRow>(connection, query, params);
  const metadataMap = await getMetadataForPlaylists(
    connection,
    rows.map((row) => row.id),
  );

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
    music_count: row.music_count,
    thumbnail: metadataMap[row.id]?.thumbnail || null,
    cover_image_url: metadataMap[row.id]?.cover_image_url || null,
    metadata: metadataMap[row.id] || {},
  }));
}

async function getPublicPlaylists(connection: DbConnection, page: number, limit: number) {
  const offset = (page - 1) * limit;
  return getPlaylistsByQuery(
    connection,
    `SELECT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     WHERE p.is_public = 1 AND p.is_hide = 0
     GROUP BY p.id
     ORDER BY p.updated_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset],
  );
}

async function getOwnedPlaylists(connection: DbConnection, userId: string) {
  return getPlaylistsByQuery(
    connection,
    `SELECT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     WHERE p.user_id = ? AND p.is_hide = 0
     GROUP BY p.id
     ORDER BY p.is_default DESC, p.created_in DESC`,
    [userId],
  );
}

async function getOwnedPlaylistsPage(
  connection: DbConnection,
  userId: string,
  page: number,
  limit: number,
) {
  const items = await getOwnedPlaylists(connection, userId);
  const offset = (page - 1) * limit;
  return {
    items: items.slice(offset, offset + limit),
    total_count: items.length,
    page,
    limit,
  };
}

async function getAccessiblePlaylists(connection: DbConnection, userId: string, includePublic: boolean) {
  const params: Array<string | number> = [userId, userId];
  let publicClause = "";
  if (includePublic) {
    publicClause = " OR p.is_public = 1";
  }

  return getPlaylistsByQuery(
    connection,
    `SELECT DISTINCT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     LEFT JOIN playlist_permissions pp ON p.id = pp.playlist_id
     WHERE p.is_hide = 0
       AND (
         p.user_id = ?
         OR pp.user_id = ?
         ${publicClause}
       )
     GROUP BY p.id
     ORDER BY p.is_default DESC, p.updated_at DESC`,
    params,
  );
}

async function getFavoritePlaylistId(connection: DbConnection, userId: string): Promise<string | null> {
  const rows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, 0 AS music_count
     FROM playlist p
     WHERE p.user_id = ? AND p.is_default = 1 AND p.is_hide = 0
     ORDER BY p.created_in DESC
     LIMIT 1`,
    [userId],
  );

  return rows[0]?.id || null;
}

async function hasPlaylistPermission(
  connection: DbConnection,
  playlistId: string,
  userId: string | null,
  requiredPermission: "read" | "write" | "admin" = "read",
) {
  const playlistRows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, COUNT(pm.music_id) AS music_count
     FROM playlist p
     LEFT JOIN playlist_music pm ON p.id = pm.playlist_id
     WHERE p.id = ? AND p.is_hide = 0
     GROUP BY p.id`,
    [playlistId],
  );

  const playlist = playlistRows[0];
  if (!playlist) {
    return { allowed: false, playlist: null };
  }

  if (userId && playlist.user_id === userId) {
    return { allowed: true, playlist };
  }

  if (playlist.is_public && requiredPermission === "read") {
    return { allowed: true, playlist };
  }

  if (!userId) {
    return { allowed: false, playlist };
  }

  const permissions = await queryRows<PermissionRow>(
    connection,
    `SELECT playlist_id, user_id, permission_type
     FROM playlist_permissions
     WHERE playlist_id = ?
       AND user_id = ?
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [playlistId, userId],
  );

  const granted = permissions[0];
  if (!granted) {
    return { allowed: false, playlist };
  }

  const levels = { read: 1, write: 2, admin: 3 };
  return {
    allowed: levels[granted.permission_type] >= levels[requiredPermission],
    playlist,
  };
}

async function getPlaylistById(
  connection: DbConnection,
  playlistId: string,
  session: AuthSession | null,
  requiredPermission: "read" | "write" | "admin" = "read",
) {
  const permission = await hasPlaylistPermission(
    connection,
    playlistId,
    session?.user.id || null,
    requiredPermission,
  );

  if (!permission.playlist) {
    return null;
  }

  if (!permission.allowed) {
    throw new HTTPException(403, { message: "Playlist access denied" });
  }

  const metadataMap = await getMetadataForPlaylists(connection, [playlistId]);
  return {
    id: permission.playlist.id,
    user_id: permission.playlist.user_id,
    title: permission.playlist.title,
    description: permission.playlist.description,
    created_in: permission.playlist.created_in,
    updated_at: permission.playlist.updated_at,
    is_hide: Boolean(permission.playlist.is_hide),
    is_default: Boolean(permission.playlist.is_default),
    is_public: Boolean(permission.playlist.is_public),
    music_count: permission.playlist.music_count,
    thumbnail: metadataMap[playlistId]?.thumbnail || null,
    cover_image_url: metadataMap[playlistId]?.cover_image_url || null,
    metadata: metadataMap[playlistId] || {},
  };
}

async function getPlaylistMusics(
  connection: DbConnection,
  playlistId: string,
  page: number,
  limit: number,
  session: AuthSession | null,
) {
  const playlist = await getPlaylistById(connection, playlistId, session, "read");
  if (!playlist) {
    return null;
  }

  const offset = (page - 1) * limit;
  const rows = await queryRows<MusicIdRow>(
    connection,
    `SELECT music_id
     FROM playlist_music
     WHERE playlist_id = ?
     ORDER BY sort_order ASC, added_at ASC
     LIMIT ? OFFSET ?`,
    [playlistId, limit, offset],
  );

  const ids = rows.map((row) => row.music_id);
  const items = await hydrateAssets(connection, ids);
  return { playlist, items };
}

async function setPlaylistMetadata(
  connection: DbConnection,
  playlistId: string,
  metadata: Record<string, string>,
) {
  const entries = Object.entries(metadata);
  for (const [key, value] of entries) {
    const metaValue = typeof value === "string" ? value : JSON.stringify(value);
    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      `SELECT id FROM playlist_metadata WHERE playlist_id = ? AND meta_key = ? LIMIT 1`,
      [playlistId, key],
    );
    if (existing[0]) {
      await queryRows(
        connection,
        `UPDATE playlist_metadata SET meta_value = ?, updated_at = NOW() WHERE id = ?`,
        [metaValue, existing[0].id],
      );
    } else {
      await queryRows(
        connection,
        `INSERT INTO playlist_metadata (id, playlist_id, meta_key, meta_value, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [crypto.randomUUID(), playlistId, key, metaValue],
      );
    }
  }
}

async function touchPlaylist(connection: DbConnection, playlistId: string) {
  await queryRows(
    connection,
    "UPDATE playlist SET updated_at = NOW() WHERE id = ?",
    [playlistId],
  );
}

async function setCustomTitle(
  connection: DbConnection,
  playlistId: string,
  musicId: string,
  customTitle: string | null,
) {
  const normalized =
    customTitle === null || customTitle === undefined || customTitle === ""
      ? null
      : String(customTitle).slice(0, 255);

  const rows = await queryRows<RowDataPacket & { count: number }>(
    connection,
    "SELECT COUNT(*) AS count FROM playlist_music WHERE playlist_id = ? AND music_id = ?",
    [playlistId, musicId],
  );
  if ((rows[0]?.count || 0) === 0) {
    throw new HTTPException(404, { message: "Music not found in playlist" });
  }

  await queryRows(
    connection,
    "UPDATE playlist_music SET custom_title = ? WHERE playlist_id = ? AND music_id = ?",
    [normalized, playlistId, musicId],
  );
  await touchPlaylist(connection, playlistId);

  return normalized;
}

async function getPlaylistPermissions(connection: DbConnection, playlistId: string) {
  return queryRows<PermissionRow>(
    connection,
    `SELECT id, playlist_id, user_id, permission_type, granted_by, granted_at, expires_at
     FROM playlist_permissions
     WHERE playlist_id = ?
     ORDER BY granted_at DESC`,
    [playlistId],
  );
}

async function grantPlaylistPermission(
  connection: DbConnection,
  playlistId: string,
  targetUserId: string,
  permissionType: "read" | "write" | "admin",
  grantedBy: string,
  expiresAt?: string,
) {
  const existing = await queryRows<PermissionRow>(
    connection,
    `SELECT id, playlist_id, user_id, permission_type, granted_by, granted_at, expires_at
     FROM playlist_permissions
     WHERE playlist_id = ? AND user_id = ?
     LIMIT 1`,
    [playlistId, targetUserId],
  );

  const expiresValue = expiresAt ? new Date(expiresAt) : null;

  if (existing[0]) {
    await queryRows(
      connection,
      `UPDATE playlist_permissions
       SET permission_type = ?, granted_by = ?, granted_at = NOW(), expires_at = ?
       WHERE playlist_id = ? AND user_id = ?`,
      [permissionType, grantedBy, expiresValue, playlistId, targetUserId],
    );
    return existing[0].id || null;
  }

  await queryRows(
    connection,
    `INSERT INTO playlist_permissions
     (id, playlist_id, user_id, permission_type, granted_by, granted_at, expires_at)
     VALUES (?, ?, ?, ?, ?, NOW(), ?)`,
    [crypto.randomUUID(), playlistId, targetUserId, permissionType, grantedBy, expiresValue],
  );

  const created = await queryRows<PermissionRow>(
    connection,
    `SELECT id, playlist_id, user_id, permission_type, granted_by, granted_at, expires_at
     FROM playlist_permissions
     WHERE playlist_id = ? AND user_id = ?
     LIMIT 1`,
    [playlistId, targetUserId],
  );
  return created[0]?.id || null;
}

async function revokePlaylistPermission(
  connection: DbConnection,
  playlistId: string,
  targetUserId: string,
) {
  await queryRows(
    connection,
    "DELETE FROM playlist_permissions WHERE playlist_id = ? AND user_id = ?",
    [playlistId, targetUserId],
  );
}

async function createPlaylist(
  connection: DbConnection,
  userId: string,
  body: PlaylistCreateBody,
) {
  const title = normalizeString(body.title, 100) || "New Playlist";
  const description = normalizeString(body.description, 500);
  const isPublic = parseBoolean(body.is_public, false);

  await queryRows(
    connection,
    `INSERT INTO playlist (id, user_id, title, description, created_in, is_hide, is_default, is_public)
     VALUES (?, ?, ?, ?, NOW(), 0, 0, ?)`,
    [crypto.randomUUID(), userId, title, description, isPublic ? 1 : 0],
  );

  const rows = await queryRows<PlaylistRow>(
    connection,
    `SELECT p.*, 0 AS music_count
     FROM playlist p
     WHERE p.user_id = ?
     ORDER BY p.created_in DESC
     LIMIT 1`,
    [userId],
  );

  const created = rows[0];
  if (!created) {
    throw new HTTPException(500, { message: "Playlist creation failed" });
  }

  if (body.metadata && Object.keys(body.metadata).length > 0) {
    await setPlaylistMetadata(connection, created.id, body.metadata);
  }

  return created.id;
}

async function clearFavoritePlaylist(connection: DbConnection, userId: string) {
  await queryRows(
    connection,
    "UPDATE playlist SET is_default = 0, updated_at = NOW() WHERE user_id = ? AND is_default = 1",
    [userId],
  );
}

async function updatePlaylist(
  connection: DbConnection,
  playlistId: string,
  body: PlaylistUpdateBody,
) {
  const updates: string[] = [];
  const params: Array<string | number> = [];

  if (body.title !== undefined) {
    updates.push("title = ?");
    params.push(normalizeString(body.title, 100) || "Untitled Playlist");
  }

  if (body.description !== undefined) {
    updates.push("description = ?");
    params.push(normalizeString(body.description, 500));
  }

  if (body.is_public !== undefined) {
    updates.push("is_public = ?");
    params.push(parseBoolean(body.is_public) ? 1 : 0);
  }

  if (body.is_hide !== undefined) {
    updates.push("is_hide = ?");
    params.push(parseBoolean(body.is_hide) ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push("updated_at = NOW()");
    params.push(playlistId);
    await queryRows(
      connection,
      `UPDATE playlist SET ${updates.join(", ")} WHERE id = ?`,
      params,
    );
  }

  if (body.metadata && Object.keys(body.metadata).length > 0) {
    await setPlaylistMetadata(connection, playlistId, body.metadata);
  }

  await touchPlaylist(connection, playlistId);
}

async function deletePlaylist(connection: DbConnection, playlistId: string) {
  await queryRows(
    connection,
    "UPDATE playlist SET is_hide = 1, updated_at = NOW() WHERE id = ?",
    [playlistId],
  );
}

async function addMusicToPlaylist(connection: DbConnection, playlistId: string, musicId: string) {
  const existing = await queryRows<{ count: number } & RowDataPacket>(
    connection,
    "SELECT COUNT(*) AS count FROM playlist_music WHERE playlist_id = ? AND music_id = ?",
    [playlistId, musicId],
  );

  if ((existing[0]?.count || 0) > 0) {
    await touchPlaylist(connection, playlistId);
    return true;
  }

  const orderRows = await queryRows<{ max_order: number | null } & RowDataPacket>(
    connection,
    "SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM playlist_music WHERE playlist_id = ?",
    [playlistId],
  );
  const nextOrder = (orderRows[0]?.max_order ?? -1) + 1;

  await queryRows(
    connection,
    "INSERT INTO playlist_music (playlist_id, music_id, added_at, sort_order) VALUES (?, ?, NOW(), ?)",
    [playlistId, musicId, nextOrder],
  );

  await touchPlaylist(connection, playlistId);
  return true;
}

async function removeMusicFromPlaylist(connection: DbConnection, playlistId: string, musicId: string) {
  await queryRows(
    connection,
    "DELETE FROM playlist_music WHERE playlist_id = ? AND music_id = ?",
    [playlistId, musicId],
  );
  await touchPlaylist(connection, playlistId);
  return true;
}

export const playlistRoutes = new Hono<{ Bindings: Bindings }>();

playlistRoutes.get("/playlists/public", async (c) => {
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 20, 100);

  const data = await withConnection(c.env, (connection) => getPublicPlaylists(connection, page, limit));
  return c.json(success(data));
});

playlistRoutes.get("/playlists/mine", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, (connection) => getOwnedPlaylists(connection, session.user.id));
  return c.json(success({ items: data, total_count: data.length }));
});

playlistRoutes.get("/playlists", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 24, 100);

  const data = await withConnection(c.env, (connection) =>
    getOwnedPlaylistsPage(connection, session.user.id, page, limit),
  );
  return c.json(success(data));
});

playlistRoutes.get("/playlists/accessible", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const includePublic = c.req.query("include_public") === "true";
  const data = await withConnection(c.env, (connection) =>
    getAccessiblePlaylists(connection, session.user.id, includePublic),
  );
  return c.json(success({ items: data, total_count: data.length }));
});

playlistRoutes.get("/favoriteId", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = await withConnection(c.env, (connection) => getFavoritePlaylistId(connection, session.user.id));
  return c.json(success({ id }));
});

playlistRoutes.post("/playlist", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = (await c.req.json().catch(() => ({}))) as PlaylistCreateBody;

  const id = await withConnection(c.env, (connection) => createPlaylist(connection, session.user.id, body));
  return c.json(success({ id }, "Playlist created"), 201);
});

playlistRoutes.post("/playlist/add", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = (await c.req.json().catch(() => ({}))) as PlaylistMusicBody;
  if (!body.playlist_id || !body.music_id) {
    throw new HTTPException(400, { message: "playlist_id and music_id are required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const permission = await hasPlaylistPermission(connection, body.playlist_id!, session.user.id, "write");
    if (!permission.playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (!permission.allowed) {
      throw new HTTPException(403, { message: "Playlist write access denied" });
    }

    await addMusicToPlaylist(connection, body.playlist_id!, body.music_id!);
    return { playlist_id: body.playlist_id, music_id: body.music_id, added: true };
  });

  return c.json(success(data, "Music added to playlist"));
});

playlistRoutes.post("/playlist/remove", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = (await c.req.json().catch(() => ({}))) as PlaylistMusicBody;
  if (!body.playlist_id || !body.music_id) {
    throw new HTTPException(400, { message: "playlist_id and music_id are required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const permission = await hasPlaylistPermission(connection, body.playlist_id!, session.user.id, "write");
    if (!permission.playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (!permission.allowed) {
      throw new HTTPException(403, { message: "Playlist write access denied" });
    }

    await removeMusicFromPlaylist(connection, body.playlist_id!, body.music_id!);
    return { playlist_id: body.playlist_id, music_id: body.music_id, removed: true };
  });

  return c.json(success(data, "Music removed from playlist"));
});

playlistRoutes.post("/playlist/:id/favorite", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistById(connection, playlistId, session, "write");
    if (!playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (playlist.user_id !== session.user.id) {
      throw new HTTPException(403, { message: "Only the owner can set favorite playlist" });
    }

    if (playlist.is_default) {
      await queryRows(
        connection,
        "UPDATE playlist SET is_default = 0, updated_at = NOW() WHERE id = ?",
        [playlistId],
      );
      return { id: playlistId, is_favorite: false };
    }

    await clearFavoritePlaylist(connection, session.user.id);
    await queryRows(
      connection,
      "UPDATE playlist SET is_default = 1, updated_at = NOW() WHERE id = ?",
      [playlistId],
    );
    return { id: playlistId, is_favorite: true };
  });

  return c.json(success(data, "Favorite playlist updated"));
});

playlistRoutes.put("/playlist/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as PlaylistUpdateBody;

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistById(connection, playlistId, session, "write");
    if (!playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (playlist.user_id !== session.user.id) {
      throw new HTTPException(403, { message: "Only the owner can update playlist" });
    }

    await updatePlaylist(connection, playlistId, body);
    const refreshed = await getPlaylistById(connection, playlistId, session, "read");
    return refreshed;
  });

  return c.json(success(data, "Playlist updated"));
});

playlistRoutes.delete("/playlist/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistById(connection, playlistId, session, "write");
    if (!playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (playlist.user_id !== session.user.id) {
      throw new HTTPException(403, { message: "Only the owner can delete playlist" });
    }

    await deletePlaylist(connection, playlistId);
    return { id: playlistId, deleted: true };
  });

  return c.json(success(data, "Playlist deleted"));
});

playlistRoutes.put("/playlist/:id/music/:musicId/custom-title", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const musicId = c.req.param("musicId");
  const body = (await c.req.json().catch(() => ({}))) as CustomTitleBody;

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistById(connection, playlistId, session, "write");
    if (!playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }

    const customTitle = await setCustomTitle(
      connection,
      playlistId,
      musicId,
      body.custom_title ?? null,
    );

    return {
      playlist_id: playlistId,
      music_id: musicId,
      custom_title: customTitle,
    };
  });

  return c.json(success(data, data.custom_title ? "Custom title updated" : "Custom title reset"));
});

playlistRoutes.get("/playlist/:id/permissions", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    await getPlaylistById(connection, playlistId, session, "admin");
    const items = await getPlaylistPermissions(connection, playlistId);
    return { items };
  });

  return c.json(success(data));
});

playlistRoutes.post("/playlist/:id/permissions", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as GrantPermissionBody;

  if (!body.user_id || !body.permission_type) {
    throw new HTTPException(400, { message: "user_id and permission_type are required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    await getPlaylistById(connection, playlistId, session, "admin");
    const permissionId = await grantPlaylistPermission(
      connection,
      playlistId,
      body.user_id!,
      body.permission_type!,
      session.user.id,
      body.expires_at,
    );
    return { permission_id: permissionId };
  });

  return c.json(success(data, "Permission granted"));
});

playlistRoutes.delete("/playlist/:id/permissions", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { user_id?: string };

  if (!body.user_id) {
    throw new HTTPException(400, { message: "user_id is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    await getPlaylistById(connection, playlistId, session, "admin");
    await revokePlaylistPermission(connection, playlistId, body.user_id!);
    return null;
  });

  return c.json(success(data, "Permission revoked"));
});

playlistRoutes.put("/v2/playlist/:id/cover", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const playlistId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as CoverBody;

  if (!body.cover_image_url || typeof body.cover_image_url !== "string") {
    throw new HTTPException(400, { message: "cover_image_url is required" });
  }
  const coverImageUrl = body.cover_image_url;

  const data = await withConnection(c.env, async (connection) => {
    const playlist = await getPlaylistById(connection, playlistId, session, "write");
    if (!playlist) {
      throw new HTTPException(404, { message: "Playlist not found" });
    }
    if (playlist.user_id !== session.user.id) {
      throw new HTTPException(403, { message: "Only the owner can update cover image" });
    }

    await setPlaylistMetadata(connection, playlistId, {
      cover_image_url: coverImageUrl,
    });

    return { cover_image_url: coverImageUrl };
  });

  return c.json(success(data, "Cover image updated"));
});

playlistRoutes.get("/playlist/:id", async (c) => {
  const id = c.req.param("id");
  const session = await optionalSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, (connection) => getPlaylistById(connection, id, session));
  if (!data) {
    throw new HTTPException(404, { message: "Playlist not found" });
  }

  return c.json(success(data));
});

playlistRoutes.get("/playlist/:id/musics", async (c) => {
  const id = c.req.param("id");
  const page = parsePositiveInt(c.req.query("page") ?? null, 1, 10000);
  const limit = parsePositiveInt(c.req.query("limit") ?? null, 20, 100);
  const session = await optionalSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, (connection) =>
    getPlaylistMusics(connection, id, page, limit, session),
  );
  if (!data) {
    throw new HTTPException(404, { message: "Playlist not found" });
  }

  return c.json(success(data));
});
