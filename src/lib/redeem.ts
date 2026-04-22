import type { RowDataPacket } from "mysql2/promise";
import { queryRows, type DbConnection } from "./db";
import type { RedeemMembershipType } from "./membership";

export type RedeemRewardType = "membership" | "credits" | "download_points" | "combo";

export interface RedeemCodeRow extends RowDataPacket {
  id: number;
  code: string;
  label_id: string | null;
  reward_type: RedeemRewardType;
  membership_type: RedeemMembershipType | null;
  duration_days: number;
  credits_amount: number | null;
  download_points_amount: number | null;
  max_uses: number;
  current_uses: number;
  is_active: number;
  expires_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

export interface RedeemCodeUsageRow extends RowDataPacket {
  id: number;
  redeem_code_id: number;
  code: string;
  used_by: string;
  used_at: Date | string | null;
  ip_address: string | null;
  user_agent: string | null;
  reward_type: RedeemRewardType | null;
  membership_type: string | null;
  membership_days: number | null;
  credits_granted: number | null;
  download_points_granted: number | null;
}

export type RedeemValidationReason =
  | "Code not found"
  | "Code is inactive"
  | "Code has expired"
  | "Code usage limit reached"
  | "User already used this code";

export interface RedeemValidationResult {
  valid: boolean;
  reason?: RedeemValidationReason;
  data?: RedeemCodeRow;
}

export function normalizeRedeemCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

export async function findRedeemCode(
  connection: DbConnection,
  code: string,
): Promise<RedeemCodeRow | null> {
  const rows = await queryRows<RedeemCodeRow>(
    connection,
    `SELECT id, code, label_id, reward_type, membership_type, duration_days,
            credits_amount, download_points_amount, max_uses, current_uses,
            is_active, expires_at, created_at, updated_at
     FROM redeem_codes
     WHERE code = ?
     LIMIT 1`,
    [code],
  );
  return rows[0] || null;
}

export async function validateRedeemCode(
  connection: DbConnection,
  code: string,
  userId?: string,
): Promise<RedeemValidationResult> {
  const redeemCode = await findRedeemCode(connection, code);
  if (!redeemCode) {
    return { valid: false, reason: "Code not found" };
  }

  if (!redeemCode.is_active) {
    return { valid: false, reason: "Code is inactive", data: redeemCode };
  }

  if (redeemCode.expires_at && new Date(redeemCode.expires_at) < new Date()) {
    return { valid: false, reason: "Code has expired", data: redeemCode };
  }

  if (redeemCode.max_uses !== -1 && redeemCode.current_uses >= redeemCode.max_uses) {
    return { valid: false, reason: "Code usage limit reached", data: redeemCode };
  }

  if (userId) {
    const usageRows = await queryRows<RowDataPacket & { count: number }>(
      connection,
      `SELECT COUNT(*) AS count
       FROM redeem_code_usage
       WHERE redeem_code_id = ? AND used_by = ?`,
      [redeemCode.id, userId],
    );
    if ((usageRows[0]?.count || 0) > 0) {
      return { valid: false, reason: "User already used this code", data: redeemCode };
    }
  }

  return { valid: true, data: redeemCode };
}

export interface UseRedeemCodeInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Consume a redeem code atomically. Locks the row, checks validity, writes usage, and
 * increments `current_uses`. Returns null if the code cannot be used by this caller.
 * Reward granting (membership/credits/download_points) is intentionally performed by
 * the route handler AFTER this returns, matching legacy behavior.
 */
export async function useRedeemCode(
  connection: DbConnection,
  code: string,
  input: UseRedeemCodeInput,
): Promise<RedeemCodeRow | null> {
  await connection.beginTransaction();
  try {
    const rows = await queryRows<RedeemCodeRow>(
      connection,
      `SELECT id, code, label_id, reward_type, membership_type, duration_days,
              credits_amount, download_points_amount, max_uses, current_uses,
              is_active, expires_at, created_at, updated_at
       FROM redeem_codes
       WHERE code = ?
       FOR UPDATE`,
      [code],
    );
    const redeemCode = rows[0];
    if (!redeemCode) {
      await connection.rollback();
      return null;
    }

    if (!redeemCode.is_active) {
      await connection.rollback();
      return null;
    }

    if (redeemCode.expires_at && new Date(redeemCode.expires_at) < new Date()) {
      await connection.rollback();
      return null;
    }

    if (redeemCode.max_uses !== -1 && redeemCode.current_uses >= redeemCode.max_uses) {
      await connection.rollback();
      return null;
    }

    const usageRows = await queryRows<RowDataPacket & { count: number }>(
      connection,
      `SELECT COUNT(*) AS count
       FROM redeem_code_usage
       WHERE redeem_code_id = ? AND used_by = ?`,
      [redeemCode.id, input.userId],
    );
    if ((usageRows[0]?.count || 0) > 0) {
      await connection.rollback();
      return null;
    }

    await queryRows(
      connection,
      `INSERT INTO redeem_code_usage
       (redeem_code_id, code, used_by, ip_address, user_agent,
        reward_type, membership_type, membership_days, credits_granted, download_points_granted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        redeemCode.id,
        code,
        input.userId,
        input.ipAddress || null,
        input.userAgent || null,
        redeemCode.reward_type,
        redeemCode.membership_type || null,
        redeemCode.duration_days || null,
        redeemCode.credits_amount || null,
        redeemCode.download_points_amount || null,
      ],
    );

    await queryRows(
      connection,
      `UPDATE redeem_codes
       SET current_uses = current_uses + 1
       WHERE id = ?`,
      [redeemCode.id],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  return findRedeemCode(connection, code);
}

export async function getUserRedeemHistory(
  connection: DbConnection,
  userId: string,
): Promise<RedeemCodeUsageRow[]> {
  return queryRows<RedeemCodeUsageRow>(
    connection,
    `SELECT id, redeem_code_id, code, used_by, used_at, ip_address, user_agent,
            reward_type, membership_type, membership_days, credits_granted, download_points_granted
     FROM redeem_code_usage
     WHERE used_by = ?
     ORDER BY used_at DESC`,
    [userId],
  );
}

export async function getRedeemCodeUsageHistory(
  connection: DbConnection,
  code: string,
): Promise<RedeemCodeUsageRow[]> {
  return queryRows<RedeemCodeUsageRow>(
    connection,
    `SELECT rcu.id, rcu.redeem_code_id, rcu.code, rcu.used_by, rcu.used_at,
            rcu.ip_address, rcu.user_agent, rcu.reward_type, rcu.membership_type,
            rcu.membership_days, rcu.credits_granted, rcu.download_points_granted
     FROM redeem_code_usage rcu
     JOIN redeem_codes rc ON rcu.redeem_code_id = rc.id
     WHERE rc.code = ?
     ORDER BY rcu.used_at DESC`,
    [code],
  );
}

export interface RedeemStats {
  total: number;
  active: number;
  expired: number;
  totalUses: number;
  byType: Record<string, number>;
}

export async function getRedeemStats(connection: DbConnection): Promise<RedeemStats> {
  const basicRows = await queryRows<
    RowDataPacket & {
      total: number;
      active: number;
      expired: number;
      totalUses: number;
    }
  >(
    connection,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < NOW() THEN 1 ELSE 0 END) AS expired,
       COALESCE(SUM(current_uses), 0) AS totalUses
     FROM redeem_codes`,
  );

  const typeRows = await queryRows<RowDataPacket & { membership_type: string | null; count: number }>(
    connection,
    `SELECT membership_type, COUNT(*) AS count
     FROM redeem_codes
     GROUP BY membership_type`,
  );

  const byType: Record<string, number> = {};
  for (const row of typeRows) {
    const key = row.membership_type || "null";
    byType[key] = Number(row.count || 0);
  }

  return {
    total: Number(basicRows[0]?.total || 0),
    active: Number(basicRows[0]?.active || 0),
    expired: Number(basicRows[0]?.expired || 0),
    totalUses: Number(basicRows[0]?.totalUses || 0),
    byType,
  };
}
