import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireSessionFromRequest } from "../lib/auth";
import { queryRows, withConnection, type DbConnection } from "../lib/db";
import { MembershipTier } from "../lib/membership";
import { success } from "../lib/response";

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  email: string | null;
  password_hash: string | null;
  provider: string;
  social_id: string | null;
  is_active: number;
  is_newbie_confirmed: number;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface BalanceRow extends RowDataPacket {
  balance: number | null;
  bonus_credits: number | null;
  bonus_credits_expires_at: Date | string | null;
  download_point: number | null;
  bonus_download_points: number | null;
  bonus_download_points_expires_at: Date | string | null;
}

interface MembershipRow extends RowDataPacket {
  tier: number;
  started_at: Date | string | null;
  renewal_interval_days: number | null;
  last_renewed_at: Date | string | null;
  is_active: number;
}

interface LabelRow extends RowDataPacket {
  org_id: string;
  name: string;
  name_en: string | null;
  logo: string | null;
  logo_tailwind: string | null;
  tailwind: string | null;
  background_tailwind: string | null;
  css_code: string | null;
  description: string | null;
  expires_at: Date | string | null;
  is_expired: number;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface LastActivityRow extends RowDataPacket {
  last_activity: Date | string | null;
}

interface ChannelRow extends RowDataPacket {
  id: string;
  platform: string;
  name: string;
  url: string;
  reg_in: Date | string | null;
  auto_renewal: number;
  is_expired: number;
  last_renewal_at: Date | string | null;
  next_renewal_at: Date | string | null;
  renewal_cost: number | null;
  is_disabled: number;
  is_verified: number;
  verification_url: string | null;
  verification_requested_at: Date | string | null;
  verified_at: Date | string | null;
  verification_keyword: string | null;
}

const CHANNEL_REGISTRATION_COST = 20;
const FIRST_CHANNEL_BONUS = 2;
const MAX_DOWNLOAD_POINTS = 10;
const SUPPORTED_SOCIAL_PROVIDERS = new Set(["google", "facebook", "kakao"]);

function normalizeString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function ensureHttpUrl(value: string, fieldName: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid");
    }
  } catch {
    throw new HTTPException(400, { message: `${fieldName} must be a valid URL` });
  }
}

function normalizeSocialProvider(value: unknown) {
  const provider = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SUPPORTED_SOCIAL_PROVIDERS.has(provider)) {
    throw new HTTPException(400, { message: "Invalid provider. Must be google, facebook, or kakao" });
  }
  return provider;
}

function tierToName(tier: number): string {
  switch (tier) {
    case MembershipTier.BASIC:
      return "basic";
    case MembershipTier.PRO:
      return "pro";
    case MembershipTier.MASTER:
      return "master";
    case MembershipTier.EDU:
      return "edu";
    case MembershipTier.DEV:
      return "dev";
    default:
      return "free";
  }
}

function mapChannel(row: ChannelRow) {
  return {
    id: row.id,
    platform: row.platform,
    name: row.name,
    url: row.url,
    auto_renewal: Boolean(row.auto_renewal),
    is_disabled: Boolean(row.is_disabled),
    is_verified: Boolean(row.is_verified),
    is_expired: Boolean(row.is_expired),
    next_renewal_at: row.next_renewal_at,
    renewal_cost: row.renewal_cost ?? CHANNEL_REGISTRATION_COST,
    verification_url: row.verification_url,
    verification_requested_at: row.verification_requested_at,
    verified_at: row.verified_at,
    verification_keyword: row.verification_keyword || "PROBGM",
    created_at: row.reg_in,
    reg_in: row.reg_in,
  };
}

async function ensureUserBalanceRow(connection: DbConnection, userId: string) {
  const rows = await queryRows<RowDataPacket & { user: string }>(
    connection,
    "SELECT user FROM users_balance WHERE user = ? LIMIT 1",
    [userId],
  );
  if (!rows[0]) {
    await queryRows(
      connection,
      `INSERT INTO users_balance (user, balance, download_point)
       VALUES (?, 20, 3)`,
      [userId],
    );
  }
}

async function getUserRow(connection: DbConnection, userId: string) {
  const rows = await queryRows<UserRow>(
    connection,
    `SELECT id, username, email, password_hash, provider, social_id, is_active, is_newbie_confirmed, created_at, updated_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId],
  );

  const user = rows[0];
  if (!user || !user.is_active) {
    throw new HTTPException(404, { message: "User not found" });
  }

  return user;
}

async function getBalanceRow(connection: DbConnection, userId: string) {
  await ensureUserBalanceRow(connection, userId);
  const rows = await queryRows<BalanceRow>(
    connection,
    `SELECT balance, bonus_credits, bonus_credits_expires_at, download_point, bonus_download_points, bonus_download_points_expires_at
     FROM users_balance
     WHERE user = ?
     LIMIT 1`,
    [userId],
  );

  return rows[0] || null;
}

async function getMembershipRow(connection: DbConnection, userId: string) {
  const rows = await queryRows<MembershipRow>(
    connection,
    `SELECT tier, started_at, renewal_interval_days, last_renewed_at, is_active
     FROM users_membership
     WHERE user = ?
     ORDER BY is_active DESC, started_at DESC
     LIMIT 1`,
    [userId],
  );

  return rows[0] || null;
}

async function getUserChannels(connection: DbConnection, userId: string) {
  const rows = await queryRows<ChannelRow>(
    connection,
    `SELECT channel_id AS id, platform, name, url, reg_in, auto_renewal, is_expired,
            last_renewal_at, next_renewal_at, renewal_cost, is_disabled, is_verified,
            verification_url, verification_requested_at, verified_at, verification_keyword
     FROM users_channels
     WHERE user_id = ? AND is_deleted = 0
     ORDER BY reg_in DESC`,
    [userId],
  );

  return rows.map(mapChannel);
}

async function getUserChannel(connection: DbConnection, userId: string, channelId: string) {
  const rows = await queryRows<ChannelRow>(
    connection,
    `SELECT channel_id AS id, platform, name, url, reg_in, auto_renewal, is_expired,
            last_renewal_at, next_renewal_at, renewal_cost, is_disabled, is_verified,
            verification_url, verification_requested_at, verified_at, verification_keyword
     FROM users_channels
     WHERE user_id = ? AND channel_id = ? AND is_deleted = 0
     LIMIT 1`,
    [userId, channelId],
  );

  return rows[0] ? mapChannel(rows[0]) : null;
}

async function getUserStats(connection: DbConnection, userId: string, joinDate: Date | string | null) {
  const [downloadsRows, playlistsRows, favoritesRows, channelsRows, lastActivityRows] = await Promise.all([
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM users_permission WHERE user_id = ? AND is_expired = 0",
      [userId],
    ).catch(() => [{ count: 0 }] as CountRow[]),
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM playlist WHERE user_id = ? AND is_hide = 0",
      [userId],
    ).catch(() => [{ count: 0 }] as CountRow[]),
    queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM playlist_music pm
       JOIN playlist p ON p.id = pm.playlist_id
       WHERE p.user_id = ? AND p.is_default = 1 AND p.is_hide = 0`,
      [userId],
    ).catch(() => [{ count: 0 }] as CountRow[]),
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM users_channels WHERE user_id = ? AND is_deleted = 0",
      [userId],
    ).catch(() => [{ count: 0 }] as CountRow[]),
    queryRows<LastActivityRow>(
      connection,
      `SELECT COALESCE(MAX(last_activity), MAX(issued_in)) AS last_activity
       FROM users_tokens
       WHERE user_id = ?`,
      [userId],
    ).catch(() => [{ last_activity: null }] as LastActivityRow[]),
  ]);

  return {
    downloads_count: downloadsRows[0]?.count || 0,
    playlists_count: playlistsRows[0]?.count || 0,
    favorite_songs_count: favoritesRows[0]?.count || 0,
    total_listening_time: 0,
    last_activity: lastActivityRows[0]?.last_activity || null,
    join_date: joinDate || null,
    channels_count: channelsRows[0]?.count || 0,
  };
}

async function getActiveUserLabel(connection: DbConnection, userId: string) {
  const rows = await queryRows<LabelRow>(
    connection,
    `SELECT
        l.id AS org_id,
        l.name,
        l.name_en,
        l.logo_url AS logo,
        l.logo_tailwind,
        l.tailwind_classes AS tailwind,
        l.background_tailwind,
        l.css_code,
        l.description,
        ul.expires_at,
        CASE WHEN ul.expires_at IS NOT NULL AND ul.expires_at <= NOW() THEN 1 ELSE 0 END AS is_expired
     FROM users_labels ul
     JOIN labels l ON ul.org_id = l.id
     WHERE ul.user_id = ?
     ORDER BY
       CASE WHEN ul.expires_at IS NULL OR ul.expires_at > NOW() THEN 0 ELSE 1 END ASC,
       ul.expires_at DESC,
       ul.created_at DESC
     LIMIT 1`,
    [userId],
  ).catch(() => []);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    org_id: row.org_id,
    name: row.name,
    name_en: row.name_en,
    logo: row.logo,
    logo_tailwind: row.logo_tailwind,
    tailwind: row.tailwind,
    background_tailwind: row.background_tailwind,
    css_code: row.css_code,
    description: row.description,
    expires_at: row.expires_at,
    is_expired: Boolean(row.is_expired),
  };
}

async function createChannel(
  connection: DbConnection,
  userId: string,
  payload: { platform: string; name: string; url: string },
) {
  const balance = await getBalanceRow(connection, userId);
  if ((balance?.balance || 0) < CHANNEL_REGISTRATION_COST) {
    throw new HTTPException(400, { message: `Insufficient credits. ${CHANNEL_REGISTRATION_COST} credits required.` });
  }

  const existingRows = await queryRows<CountRow>(
    connection,
    "SELECT COUNT(*) AS count FROM users_channels WHERE user_id = ? AND url = ? AND is_deleted = 0",
    [userId, payload.url],
  );
  if ((existingRows[0]?.count || 0) > 0) {
    throw new HTTPException(400, { message: "Channel with this URL already exists" });
  }

  await connection.beginTransaction();

  try {
    await queryRows(
      connection,
      "UPDATE users_balance SET balance = balance - ? WHERE user = ?",
      [CHANNEL_REGISTRATION_COST, userId],
    );

    const now = new Date();
    const nextRenewal = new Date(now);
    nextRenewal.setDate(nextRenewal.getDate() + 30);
    const channelId = crypto.randomUUID();

    await queryRows(
      connection,
      `INSERT INTO users_channels
       (channel_id, user_id, platform, name, url, reg_in, auto_renewal, is_expired, is_deleted,
        last_renewal_at, next_renewal_at, renewal_cost, is_disabled)
       VALUES (?, ?, ?, ?, ?, NOW(), 1, 0, 0, NOW(), ?, ?, 0)`,
      [channelId, userId, payload.platform, payload.name, payload.url, nextRenewal, CHANNEL_REGISTRATION_COST],
    );

    const countRows = await queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM users_channels WHERE user_id = ? AND is_deleted = 0",
      [userId],
    );

    if ((countRows[0]?.count || 0) === 1) {
      const currentBalance = await getBalanceRow(connection, userId);
      const currentPoints = currentBalance?.download_point || 0;
      if (currentPoints < MAX_DOWNLOAD_POINTS) {
        const pointsToGrant = Math.min(FIRST_CHANNEL_BONUS, MAX_DOWNLOAD_POINTS - currentPoints);
        await queryRows(
          connection,
          "UPDATE users_balance SET download_point = download_point + ? WHERE user = ?",
          [pointsToGrant, userId],
        );
      }
    }

    await connection.commit();
    const created = await getUserChannel(connection, userId, channelId);
    if (!created) {
      throw new HTTPException(500, { message: "Channel creation failed" });
    }
    return created;
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

export const userRoutes = new Hono<{ Bindings: Bindings }>();

userRoutes.get("/user/info", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
      is_active: Boolean(user.is_active),
      created_at: user.created_at,
      updated_at: user.updated_at,
      display_name: null,
      avatar_url: null,
      bio: null,
    };
  });

  return c.json(success(data));
});

userRoutes.get("/user/balance", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const balance = await getBalanceRow(connection, session.user.id);
    if (!balance) {
      throw new HTTPException(404, { message: "User balance information not found" });
    }

    return {
      balance: balance.balance || 0,
      bonus_credits: balance.bonus_credits || 0,
      bonus_credits_expires_at: balance.bonus_credits_expires_at,
      download_point: balance.download_point || 0,
      bonus_download_points: balance.bonus_download_points || 0,
      bonus_download_points_expires_at: balance.bonus_download_points_expires_at,
    };
  });

  return c.json(success(data));
});

userRoutes.get("/user/credits", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const balance = await getBalanceRow(connection, session.user.id);
    if (!balance) {
      throw new HTTPException(404, { message: "User credit information not found" });
    }

    return {
      balance: balance.balance || 0,
      bonus_credits: balance.bonus_credits || 0,
      bonus_credits_expires_at: balance.bonus_credits_expires_at,
      download_point: balance.download_point || 0,
      bonus_download_points: balance.bonus_download_points || 0,
      bonus_download_points_expires_at: balance.bonus_download_points_expires_at,
    };
  });

  return c.json(success(data));
});

userRoutes.get("/user/membership", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const membership = await getMembershipRow(connection, session.user.id);
    if (!membership) {
      throw new HTTPException(404, { message: "User membership information not found" });
    }

    return {
      tier: membership.tier,
      started_at: membership.started_at,
      renewal_interval_days: membership.renewal_interval_days,
      last_renewed_at: membership.last_renewed_at,
      membership_type: tierToName(membership.tier),
      status: membership.is_active ? "active" : "expired",
    };
  });

  return c.json(success(data));
});

userRoutes.get("/user/downloadPoint", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const balance = await getBalanceRow(connection, session.user.id);
    if (!balance) {
      throw new HTTPException(404, { message: "User download points not found" });
    }

    return balance.download_point || 0;
  });

  return c.json(success(data));
});

userRoutes.get("/user/label", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, (connection) => getActiveUserLabel(connection, session.user.id));
  return c.json(success(data, data ? "OK" : "No active label found for user"));
});

userRoutes.get("/user/stats", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    return getUserStats(connection, session.user.id, user.created_at);
  });

  return c.json(success(data, "사용자 통계를 성공적으로 가져왔습니다."));
});

userRoutes.get("/user/channels", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, (connection) => getUserChannels(connection, session.user.id));
  return c.json(success(data));
});

userRoutes.get("/user/channel/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");
  const data = await withConnection(c.env, (connection) => getUserChannel(connection, session.user.id, channelId));
  if (!data) {
    throw new HTTPException(404, { message: "채널을 찾을 수 없습니다." });
  }
  return c.json(success(data));
});

userRoutes.post("/user/channel", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    name?: string;
    url?: string;
    platform?: string;
  };
  const name = normalizeString(body.name, 100);
  const url = normalizeString(body.url, 500);
  const platform = normalizeString(body.platform, 50);

  if (!name || !url || !platform) {
    throw new HTTPException(400, { message: "name, url, and platform are required" });
  }

  ensureHttpUrl(url, "url");
  const data = await withConnection(c.env, (connection) =>
    createChannel(connection, session.user.id, { name, url, platform }),
  );
  return c.json(success(data, "채널이 성공적으로 생성되었습니다.", 201), 201);
});

userRoutes.put("/user/channel/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    name?: string;
    description?: string;
    auto_renewal?: boolean;
  };
  const name = body.name === undefined ? undefined : normalizeString(body.name, 100);

  const data = await withConnection(c.env, async (connection) => {
    const existing = await getUserChannel(connection, session.user.id, channelId);
    if (!existing) {
      throw new HTTPException(404, { message: "채널을 찾을 수 없습니다." });
    }

    const updates: string[] = [];
    const values: Array<string | number | boolean> = [];

    if (name !== undefined) {
      if (!name) {
        throw new HTTPException(400, { message: "Channel name is required" });
      }
      updates.push("name = ?");
      values.push(name);
    }

    if (body.auto_renewal !== undefined) {
      updates.push("auto_renewal = ?");
      values.push(body.auto_renewal ? 1 : 0);
    }

    if (updates.length === 0) {
      return existing;
    }

    await queryRows(
      connection,
      `UPDATE users_channels SET ${updates.join(", ")} WHERE user_id = ? AND channel_id = ? AND is_deleted = 0`,
      [...values, session.user.id, channelId],
    );

    const updated = await getUserChannel(connection, session.user.id, channelId);
    if (!updated) {
      throw new HTTPException(500, { message: "Channel update failed" });
    }

    return updated;
  });

  return c.json(success(data, "채널이 성공적으로 수정되었습니다."));
});

userRoutes.put("/user/channel/:id/auto-renewal", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const existing = await queryRows<RowDataPacket & { auto_renewal: number; is_disabled: number }>(
      connection,
      `SELECT auto_renewal, is_disabled
       FROM users_channels
       WHERE user_id = ? AND channel_id = ? AND is_deleted = 0
       LIMIT 1`,
      [session.user.id, channelId],
    );

    const row = existing[0];
    if (!row) {
      throw new HTTPException(404, { message: "채널을 찾을 수 없습니다." });
    }

    const nextValue = !Boolean(row.auto_renewal);
    if (Boolean(row.is_disabled) && nextValue) {
      throw new HTTPException(400, {
        message: "크레딧 부족으로 비활성화된 채널입니다. 자동 갱신을 활성화할 수 없습니다.",
      });
    }

    await queryRows(
      connection,
      "UPDATE users_channels SET auto_renewal = ? WHERE user_id = ? AND channel_id = ?",
      [nextValue ? 1 : 0, session.user.id, channelId],
    );

    return { auto_renewal: nextValue };
  });

  return c.json(success(data, "자동 갱신 설정이 변경되었습니다."));
});

userRoutes.delete("/user/channel/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");

  await withConnection(c.env, async (connection) => {
    const existing = await queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM users_channels WHERE user_id = ? AND channel_id = ? AND is_deleted = 0",
      [session.user.id, channelId],
    );
    if ((existing[0]?.count || 0) === 0) {
      throw new HTTPException(404, { message: "삭제할 채널을 찾을 수 없습니다." });
    }

    await queryRows(
      connection,
      "UPDATE users_channels SET is_deleted = 1 WHERE user_id = ? AND channel_id = ? AND is_deleted = 0",
      [session.user.id, channelId],
    );
  });

  return c.json(success(null, "채널이 성공적으로 삭제되었습니다."));
});

userRoutes.post("/user/channel/:id/verify", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    verification_url?: string;
  };
  const verificationUrl = normalizeString(body.verification_url, 500);

  if (!verificationUrl) {
    throw new HTTPException(400, { message: "verification_url is required" });
  }

  ensureHttpUrl(verificationUrl, "verification_url");

  const data = await withConnection(c.env, async (connection) => {
    const existing = await getUserChannel(connection, session.user.id, channelId);
    if (!existing) {
      throw new HTTPException(404, { message: "채널을 찾을 수 없습니다." });
    }

    await queryRows(
      connection,
      `UPDATE users_channels
       SET verification_url = ?, verification_requested_at = NOW()
       WHERE user_id = ? AND channel_id = ? AND is_deleted = 0`,
      [verificationUrl, session.user.id, channelId],
    );

    const updated = await getUserChannel(connection, session.user.id, channelId);
    if (!updated) {
      throw new HTTPException(500, { message: "Channel verification update failed" });
    }

    return updated;
  });

  return c.json(success(data, "채널 인증 요청이 접수되었습니다."));
});

userRoutes.put("/user/profile", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    username?: string;
    email?: string;
  };

  const username = body.username === undefined ? undefined : normalizeString(body.username, 50);
  const email = body.email === undefined ? undefined : normalizeString(body.email, 255).toLowerCase();

  if (username === undefined && email === undefined) {
    throw new HTTPException(400, { message: "수정할 프로필 정보가 필요합니다." });
  }

  const data = await withConnection(c.env, async (connection) => {
    if (username !== undefined) {
      if (!username) {
        throw new HTTPException(400, { message: "유효한 username이 필요합니다." });
      }
      const existing = await queryRows<RowDataPacket & { id: string }>(
        connection,
        "SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1",
        [username, session.user.id],
      );
      if (existing[0]) {
        throw new HTTPException(400, { message: "Username is already taken" });
      }
    }

    if (email !== undefined) {
      if (!email) {
        throw new HTTPException(400, { message: "유효한 email이 필요합니다." });
      }
      const existing = await queryRows<RowDataPacket & { id: string }>(
        connection,
        "SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1",
        [email, session.user.id],
      );
      if (existing[0]) {
        throw new HTTPException(400, { message: "Email is already taken" });
      }
    }

    const updates: string[] = [];
    const values: Array<string> = [];
    if (username !== undefined) {
      updates.push("username = ?");
      values.push(username);
    }
    if (email !== undefined) {
      updates.push("email = ?");
      values.push(email);
    }
    updates.push("updated_at = NOW()");

    await queryRows(
      connection,
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
      [...values, session.user.id],
    );

    const user = await getUserRow(connection, session.user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      provider: user.provider,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };
  });

  return c.json(success(data, "프로필이 성공적으로 업데이트되었습니다."));
});

userRoutes.get("/api/user/profile", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    const [balance, membership] = await Promise.all([
      getBalanceRow(connection, session.user.id),
      getMembershipRow(connection, session.user.id),
    ]);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        provider: user.provider,
        hasSocialAccount: Boolean(user.social_id),
        isActive: Boolean(user.is_active),
        isNewbie: !Boolean(user.is_newbie_confirmed),
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
      balance: balance
        ? {
            credits: balance.balance || 0,
            downloadPoints: balance.download_point || 0,
          }
        : null,
      membership: membership
        ? {
            tier: membership.tier,
            isActive: Boolean(membership.is_active),
            lastRenewedAt: membership.last_renewed_at,
          }
        : null,
    };
  });

  return c.json(success(data, "User profile retrieved successfully"));
});

userRoutes.put("/api/user/username", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    username?: string;
  };
  const username = normalizeString(body.username, 50);

  if (!username) {
    throw new HTTPException(400, { message: "Username is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE username = ? AND id != ? LIMIT 1",
      [username, session.user.id],
    );
    if (existing[0]) {
      throw new HTTPException(400, { message: "Username is already taken" });
    }

    await queryRows(
      connection,
      "UPDATE users SET username = ?, updated_at = NOW() WHERE id = ?",
      [username, session.user.id],
    );

    return { username };
  });

  return c.json(success(data, "Username updated successfully"));
});

userRoutes.post("/api/user/check-social-binding", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    provider?: string;
    socialId?: string;
  };
  const socialId = normalizeString(body.socialId, 255);
  if (!body.provider || !socialId) {
    throw new HTTPException(400, { message: "Provider and social ID are required" });
  }
  const provider = normalizeSocialProvider(body.provider);


  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    if (user.social_id) {
      return {
        canBind: false,
        reason: "already_bound",
        message: "A social account is already bound to this account",
      };
    }

    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE provider = ? AND social_id = ? LIMIT 1",
      [provider, socialId],
    );
    if (existing[0]) {
      return {
        canBind: false,
        reason: "already_used",
        message: "This social account is already linked to another user",
      };
    }

    return {
      canBind: true,
      provider,
    };
  });

  return c.json(success(data, data.canBind ? "Social account can be bound" : "Cannot bind social account"));
});

userRoutes.post("/api/user/bind-social", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    provider?: string;
    socialId?: string;
    socialEmail?: string;
  };
  const socialId = normalizeString(body.socialId, 255);
  if (!body.provider || !socialId) {
    throw new HTTPException(400, { message: "Provider and social ID are required" });
  }
  const provider = normalizeSocialProvider(body.provider);

  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    if (user.social_id) {
      throw new HTTPException(400, { message: "A social account is already bound to this account" });
    }

    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE provider = ? AND social_id = ? LIMIT 1",
      [provider, socialId],
    );
    if (existing[0]) {
      throw new HTTPException(400, { message: "This social account is already linked to another user" });
    }

    await queryRows(
      connection,
      "UPDATE users SET social_id = ?, updated_at = NOW() WHERE id = ?",
      [socialId, session.user.id],
    );

    return {
      provider,
      socialId,
      bound: true,
      socialEmail: body.socialEmail ? normalizeString(body.socialEmail, 255) : null,
    };
  });

  return c.json(success(data, `${provider} account successfully linked`));
});

userRoutes.delete("/api/user/unbind-social", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);
    if (!user.social_id || !SUPPORTED_SOCIAL_PROVIDERS.has(user.provider)) {
      throw new HTTPException(400, { message: "No social account is bound to this account" });
    }

    await queryRows(
      connection,
      "UPDATE users SET social_id = NULL, updated_at = NOW() WHERE id = ?",
      [session.user.id],
    );

    return {
      unbound: true,
    };
  });

  return c.json(success(data, "Social account successfully unlinked"));
});

userRoutes.delete("/api/user/account", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    password?: string;
  };

  const data = await withConnection(c.env, async (connection) => {
    const user = await getUserRow(connection, session.user.id);

    if (user.provider === "local" && user.password_hash) {
      const password = body.password || "";
      if (!password) {
        throw new HTTPException(400, { message: "Password is required to delete local account" });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        throw new HTTPException(401, { message: "Invalid password" });
      }
    }

    await connection.beginTransaction();
    try {
      await queryRows(
        connection,
        "UPDATE users SET is_active = 0, updated_at = NOW() WHERE id = ?",
        [session.user.id],
      );
      await queryRows(
        connection,
        "UPDATE users_tokens SET is_expire = 1 WHERE user_id = ?",
        [session.user.id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    return { deleted: true, userId: session.user.id };
  });

  return c.json(success(data, "Account successfully deleted"));
});
