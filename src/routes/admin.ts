import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import { queryRows, withConnection, type DbConnection } from "../lib/db";
import { success } from "../lib/response";

interface CountRow extends RowDataPacket {
  count: number;
}

interface StatsRow extends RowDataPacket {
  total_channels: number;
  pending_verifications: number;
  verified_channels: number;
  disabled_channels: number;
}

interface SumRow extends RowDataPacket {
  amount: number;
}

interface AdminChannelRow extends RowDataPacket {
  id: string;
  user_id: string;
  username: string;
  email: string | null;
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

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function mapAdminChannel(row: AdminChannelRow) {
  return {
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    email: row.email,
    platform: row.platform,
    name: row.name,
    url: row.url,
    auto_renewal: Boolean(row.auto_renewal),
    is_expired: Boolean(row.is_expired),
    last_renewal_at: row.last_renewal_at,
    next_renewal_at: row.next_renewal_at,
    renewal_cost: row.renewal_cost,
    is_disabled: Boolean(row.is_disabled),
    is_verified: Boolean(row.is_verified),
    verification_url: row.verification_url,
    verification_requested_at: row.verification_requested_at,
    verified_at: row.verified_at,
    verification_keyword: row.verification_keyword || "PROBGM",
    reg_in: row.reg_in,
  };
}

async function getAdminChannel(connection: DbConnection, channelId: string) {
  const rows = await queryRows<AdminChannelRow>(
    connection,
    `SELECT
        uc.channel_id AS id,
        uc.user_id,
        u.username,
        u.email,
        uc.platform,
        uc.name,
        uc.url,
        uc.reg_in,
        uc.auto_renewal,
        uc.is_expired,
        uc.last_renewal_at,
        uc.next_renewal_at,
        uc.renewal_cost,
        uc.is_disabled,
        uc.is_verified,
        uc.verification_url,
        uc.verification_requested_at,
        uc.verified_at,
        uc.verification_keyword
     FROM users_channels uc
     JOIN users u ON u.id = uc.user_id
     WHERE uc.channel_id = ? AND uc.is_deleted = 0
     LIMIT 1`,
    [channelId],
  );

  return rows[0] ? mapAdminChannel(rows[0]) : null;
}

export const adminRoutes = new Hono<{ Bindings: Bindings }>();

adminRoutes.get("/dashboard", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const [
      userCount,
      musicCount,
      playlistCount,
      paymentCount,
      paymentAmount,
      pendingGrantCount,
      pendingVerificationCount,
    ] = await Promise.all([
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM users WHERE is_active = 1",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM musics",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM playlist WHERE is_hide = 0",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM payments",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<SumRow>(
        connection,
        "SELECT COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'DONE'",
      ).catch(() => [{ amount: 0 }] as SumRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM pending_membership_grants WHERE status IN ('pending', 'failed')",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        `SELECT COUNT(*) AS count
         FROM users_channels
         WHERE is_deleted = 0
           AND is_verified = 0
           AND verification_url IS NOT NULL`,
      ).catch(() => [{ count: 0 }] as CountRow[]),
    ]);

    return {
      users: {
        active: userCount[0]?.count || 0,
      },
      assets: {
        total: musicCount[0]?.count || 0,
      },
      playlists: {
        visible: playlistCount[0]?.count || 0,
      },
      payments: {
        totalCount: paymentCount[0]?.count || 0,
        totalCompletedAmount: Number(paymentAmount[0]?.amount || 0),
      },
      operations: {
        pendingGrants: pendingGrantCount[0]?.count || 0,
        pendingChannelVerifications: pendingVerificationCount[0]?.count || 0,
      },
    };
  });

  return c.json(success(data, "Admin dashboard retrieved"));
});

adminRoutes.get("/channels/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<StatsRow>(
      connection,
      `SELECT
          COUNT(*) AS total_channels,
          SUM(CASE WHEN is_deleted = 0 AND is_verified = 0 AND verification_url IS NOT NULL THEN 1 ELSE 0 END) AS pending_verifications,
          SUM(CASE WHEN is_deleted = 0 AND is_verified = 1 THEN 1 ELSE 0 END) AS verified_channels,
          SUM(CASE WHEN is_deleted = 0 AND is_disabled = 1 THEN 1 ELSE 0 END) AS disabled_channels
       FROM users_channels
       WHERE is_deleted = 0`,
    );

    const stats = rows[0];
    return {
      total_channels: stats?.total_channels || 0,
      pending_verifications: stats?.pending_verifications || 0,
      verified_channels: stats?.verified_channels || 0,
      disabled_channels: stats?.disabled_channels || 0,
    };
  });

  return c.json(success(data, "Admin channel stats retrieved"));
});

adminRoutes.get("/channels", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 1000);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;
  const status = (c.req.query("status") || "all").trim().toLowerCase();
  const userId = (c.req.query("userId") || "").trim();

  const whereClauses = ["uc.is_deleted = 0"];
  const params: Array<string | number> = [];

  if (status === "pending") {
    whereClauses.push("uc.is_verified = 0", "uc.verification_url IS NOT NULL");
  } else if (status === "verified") {
    whereClauses.push("uc.is_verified = 1");
  } else if (status === "disabled") {
    whereClauses.push("uc.is_disabled = 1");
  } else if (status !== "all") {
    throw new HTTPException(400, { message: "status must be one of all, pending, verified, disabled" });
  }

  if (userId) {
    whereClauses.push("uc.user_id = ?");
    params.push(userId);
  }

  const whereSql = whereClauses.join(" AND ");

  const data = await withConnection(c.env, async (connection) => {
    const [countRows, items] = await Promise.all([
      queryRows<CountRow>(
        connection,
        `SELECT COUNT(*) AS count
         FROM users_channels uc
         WHERE ${whereSql}`,
        params,
      ),
      queryRows<AdminChannelRow>(
        connection,
        `SELECT
            uc.channel_id AS id,
            uc.user_id,
            u.username,
            u.email,
            uc.platform,
            uc.name,
            uc.url,
            uc.reg_in,
            uc.auto_renewal,
            uc.is_expired,
            uc.last_renewal_at,
            uc.next_renewal_at,
            uc.renewal_cost,
            uc.is_disabled,
            uc.is_verified,
            uc.verification_url,
            uc.verification_requested_at,
            uc.verified_at,
            uc.verification_keyword
         FROM users_channels uc
         JOIN users u ON u.id = uc.user_id
         WHERE ${whereSql}
         ORDER BY
           CASE WHEN uc.verification_requested_at IS NULL THEN 1 ELSE 0 END ASC,
           uc.verification_requested_at DESC,
           uc.reg_in DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
    ]);

    return {
      items: items.map(mapAdminChannel),
      total: countRows[0]?.count || 0,
      page,
      limit,
      status,
      userId: userId || null,
    };
  });

  return c.json(success(data, "Admin channel list retrieved"));
});

adminRoutes.get("/channel-verifications/pending", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 1000);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;

  const data = await withConnection(c.env, async (connection) => {
    const [countRows, items] = await Promise.all([
      queryRows<CountRow>(
        connection,
        `SELECT COUNT(*) AS count
         FROM users_channels
         WHERE is_deleted = 0
           AND is_verified = 0
           AND verification_url IS NOT NULL`,
      ),
      queryRows<AdminChannelRow>(
        connection,
        `SELECT
            uc.channel_id AS id,
            uc.user_id,
            u.username,
            u.email,
            uc.platform,
            uc.name,
            uc.url,
            uc.reg_in,
            uc.auto_renewal,
            uc.is_expired,
            uc.last_renewal_at,
            uc.next_renewal_at,
            uc.renewal_cost,
            uc.is_disabled,
            uc.is_verified,
            uc.verification_url,
            uc.verification_requested_at,
            uc.verified_at,
            uc.verification_keyword
         FROM users_channels uc
         JOIN users u ON u.id = uc.user_id
         WHERE uc.is_deleted = 0
           AND uc.is_verified = 0
           AND uc.verification_url IS NOT NULL
         ORDER BY uc.verification_requested_at DESC, uc.reg_in DESC
         LIMIT ? OFFSET ?`,
        [limit, offset],
      ),
    ]);

    return {
      items: items.map(mapAdminChannel),
      total: countRows[0]?.count || 0,
      page,
      limit,
    };
  });

  return c.json(success(data, "Pending channel verification requests retrieved"));
});

adminRoutes.get("/channel-verifications/:id", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const channel = await getAdminChannel(connection, channelId);
    if (!channel) {
      throw new HTTPException(404, { message: "Channel not found" });
    }
    return channel;
  });

  return c.json(success(data, "Channel verification detail retrieved"));
});

adminRoutes.post("/channel-verifications/:id/approve", async (c) => {
  const adminSession = await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const channel = await getAdminChannel(connection, channelId);
    if (!channel) {
      throw new HTTPException(404, { message: "Channel not found" });
    }
    if (!channel.verification_url) {
      throw new HTTPException(400, { message: "Verification request not found" });
    }

    await queryRows(
      connection,
      `UPDATE users_channels
       SET is_verified = 1,
           verified_at = CURRENT_TIMESTAMP
       WHERE channel_id = ? AND is_deleted = 0`,
      [channelId],
    );

    const updated = await getAdminChannel(connection, channelId);
    if (!updated) {
      throw new HTTPException(500, { message: "Channel verification approval failed" });
    }

    return {
      approvedBy: adminSession.user.id,
      channel: updated,
    };
  });

  return c.json(success(data, "Channel verification approved"));
});

adminRoutes.post("/channel-verifications/:id/reject", async (c) => {
  const adminSession = await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    clearUrl?: boolean;
    reason?: string;
  };
  const clearUrl = body.clearUrl !== false;
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  const data = await withConnection(c.env, async (connection) => {
    const channel = await getAdminChannel(connection, channelId);
    if (!channel) {
      throw new HTTPException(404, { message: "Channel not found" });
    }
    if (!channel.verification_url) {
      throw new HTTPException(400, { message: "Verification request not found" });
    }

    await queryRows(
      connection,
      `UPDATE users_channels
       SET verification_url = ?,
           verification_requested_at = NULL,
           is_verified = 0,
           verified_at = NULL
       WHERE channel_id = ? AND is_deleted = 0`,
      [clearUrl ? null : channel.verification_url, channelId],
    );

    const updated = await getAdminChannel(connection, channelId);
    if (!updated) {
      throw new HTTPException(500, { message: "Channel verification rejection failed" });
    }

    return {
      rejectedBy: adminSession.user.id,
      reason,
      channel: updated,
    };
  });

  return c.json(success(data, "Channel verification request rejected"));
});

adminRoutes.post("/channels/:id/disable", async (c) => {
  const adminSession = await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const channelId = c.req.param("id");

  const data = await withConnection(c.env, async (connection) => {
    const channel = await getAdminChannel(connection, channelId);
    if (!channel) {
      throw new HTTPException(404, { message: "Channel not found" });
    }

    await queryRows(
      connection,
      `UPDATE users_channels
       SET is_disabled = 1,
           auto_renewal = 0
       WHERE channel_id = ? AND is_deleted = 0`,
      [channelId],
    );

    const updated = await getAdminChannel(connection, channelId);
    if (!updated) {
      throw new HTTPException(500, { message: "Channel disable failed" });
    }

    return {
      disabledBy: adminSession.user.id,
      channel: updated,
    };
  });

  return c.json(success(data, "Channel disabled"));
});
