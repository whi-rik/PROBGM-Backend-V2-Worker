import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireSessionFromRequest } from "../lib/auth";
import { queryRows, withConnection, type DbConnection } from "../lib/db";
import { MembershipTier } from "../lib/membership";
import { success } from "../lib/response";

interface MembershipRow extends RowDataPacket {
  tier: number;
  is_active: number;
}

interface BalanceRow extends RowDataPacket {
  download_point: number | null;
}

interface PermissionRow extends RowDataPacket {
  id: string;
  asset_id: string;
  format: "mp3" | "wav";
  created_at?: Date | string | null;
  created_in?: Date | string | null;
}

interface AssetRow extends RowDataPacket {
  id: string;
}

interface VerifiedChannelRow extends RowDataPacket {
  count: number;
}

const WAV_ALLOWED_TIERS = new Set<number>([
  MembershipTier.BASIC,
  MembershipTier.PRO,
  MembershipTier.MASTER,
  MembershipTier.DEV,
]);

async function ensureBalanceRow(connection: DbConnection, userId: string) {
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

async function getMembershipTier(connection: DbConnection, userId: string) {
  const rows = await queryRows<MembershipRow>(
    connection,
    `SELECT tier, is_active
     FROM users_membership
     WHERE user = ?
     ORDER BY is_active DESC, started_at DESC
     LIMIT 1`,
    [userId],
  );

  const row = rows[0];
  return row && row.is_active ? row.tier : MembershipTier.FREE;
}

async function hasVerifiedChannel(connection: DbConnection, userId: string) {
  const rows = await queryRows<VerifiedChannelRow>(
    connection,
     `SELECT COUNT(*) AS count
     FROM users_channels
     WHERE user_id = ? AND is_deleted = 0 AND is_verified = 1`,
     [userId],
   ).catch(() => [{ count: 0 }] as VerifiedChannelRow[]);

  return (rows[0]?.count || 0) > 0;
}

async function getPermissionByAssetAndFormat(
  connection: DbConnection,
  userId: string,
  assetId: string,
  format: "mp3" | "wav",
) {
  const rows = await queryRows<PermissionRow>(
    connection,
    `SELECT permission_id AS id, asset_id, format, issued_in AS created_in
     FROM users_permission
     WHERE user_id = ? AND asset_id = ? AND format = ? AND is_expired = 0
     LIMIT 1`,
    [userId, assetId, format],
  );

  return rows[0] || null;
}

async function createPermission(
  connection: DbConnection,
  userId: string,
  assetId: string,
  format: "mp3" | "wav",
) {
  const permissionId = crypto.randomUUID();
  await queryRows(
    connection,
    `INSERT INTO users_permission (permission_id, user_id, asset_id, format, issued_in)
     VALUES (?, ?, ?, ?, NOW())`,
    [permissionId, userId, assetId, format],
  );
  return permissionId;
}

export const downloadRoutes = new Hono<{ Bindings: Bindings }>();

downloadRoutes.get("/download/list", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<PermissionRow>(
      connection,
      `SELECT permission_id AS id, asset_id, format, issued_in AS created_in
       FROM users_permission
       WHERE user_id = ? AND is_expired = 0
       ORDER BY issued_in DESC`,
      [session.user.id],
    );

    return rows;
  });

  return c.json(success(data, data.length > 0 ? "다운로드 목록을 불러왔습니다." : "다운로드 목록이 없습니다."));
});

downloadRoutes.get("/download/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const assetId = c.req.param("id")?.trim();
  const format = c.req.query("format") === "wav" ? "wav" : "mp3";

  if (!assetId) {
    throw new HTTPException(400, { message: "Music ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    await ensureBalanceRow(connection, session.user.id);

    const assets = await queryRows<AssetRow>(
      connection,
      "SELECT id FROM musics WHERE id = ? LIMIT 1",
      [assetId],
    );
    if (!assets[0]) {
      throw new HTTPException(404, { message: "음악을 찾을 수 없습니다." });
    }

    const tier = await getMembershipTier(connection, session.user.id);

    if (format === "wav" && !WAV_ALLOWED_TIERS.has(tier)) {
      throw new HTTPException(403, {
        message: "WAV 포맷은 해당 멤버십 티어에서 사용할 수 없습니다. MP3만 다운로드 가능합니다.",
      });
    }

    if (format === "wav" && !(await hasVerifiedChannel(connection, session.user.id))) {
      throw new HTTPException(403, {
        message:
          'WAV 다운로드를 위해 채널 인증이 필요합니다.\n\n1. 채널을 등록해주세요\n2. 콘텐츠 설명란에 "PROBGM"을 포함해주세요\n3. 채널 관리 페이지에서 인증 URL을 제출해주세요',
      });
    }

    const existing = await getPermissionByAssetAndFormat(connection, session.user.id, assetId, format);
    if (existing) {
      return { id: existing.id };
    }

    if (tier === MembershipTier.FREE) {
      const balanceRows = await queryRows<BalanceRow>(
        connection,
        "SELECT download_point FROM users_balance WHERE user = ? LIMIT 1",
        [session.user.id],
      );
      const points = balanceRows[0]?.download_point || 0;
      if (points <= 0) {
        throw new HTTPException(403, { message: "다운로드 포인트가 부족합니다." });
      }

      await connection.beginTransaction();
      try {
        await queryRows(
          connection,
          "UPDATE users_balance SET download_point = download_point - 1 WHERE user = ?",
          [session.user.id],
        );
        const permissionId = await createPermission(connection, session.user.id, assetId, format);
        await connection.commit();
        return { id: permissionId, pointDownShift: 1 };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    const permissionId = await createPermission(connection, session.user.id, assetId, format);
    return { id: permissionId };
  });

  return c.json(success(data, "다운로드가 준비되었습니다."));
});
