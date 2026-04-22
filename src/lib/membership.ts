import type { RowDataPacket } from "mysql2/promise";
import type { DbConnection } from "./db";
import { queryRows } from "./db";

export enum MembershipTier {
  FREE = 0,
  BASIC = 1,
  PRO = 2,
  MASTER = 3,
  EDU = 4,
  DEV = 5,
}

interface MembershipRow extends RowDataPacket {
  tier: number;
  started_at: Date;
  renewal_interval_days: number;
  last_renewed_at: Date;
}

export function parsePlanFromOrderName(
  orderName: string,
): { tier: MembershipTier; renewalDays: number } | null {
  const normalizedName = orderName.toUpperCase();

  let tier: MembershipTier;
  if (normalizedName.includes("BASIC")) {
    tier = MembershipTier.BASIC;
  } else if (normalizedName.includes("PRO")) {
    tier = MembershipTier.PRO;
  } else if (normalizedName.includes("MASTER")) {
    tier = MembershipTier.MASTER;
  } else if (normalizedName.includes("EDU")) {
    tier = MembershipTier.EDU;
  } else if (normalizedName.includes("DEV")) {
    tier = MembershipTier.DEV;
  } else {
    return null;
  }

  let renewalDays = 30;
  if (normalizedName.includes("YEARLY") || normalizedName.includes("YEAR")) {
    renewalDays = 365;
  } else if (normalizedName.includes("MONTHLY") || normalizedName.includes("MONTH")) {
    renewalDays = 30;
  }

  return { tier, renewalDays };
}

export function getMembershipCredits(tier: MembershipTier): number {
  switch (tier) {
    case MembershipTier.FREE:
    case MembershipTier.EDU:
    case MembershipTier.DEV:
      return 20;
    case MembershipTier.BASIC:
      return 70;
    case MembershipTier.PRO:
      return 150;
    case MembershipTier.MASTER:
      return 500;
    default:
      return 0;
  }
}

export function getMembershipDownloadPoints(tier: MembershipTier): number {
  switch (tier) {
    case MembershipTier.FREE:
    case MembershipTier.EDU:
    case MembershipTier.DEV:
      return 10;
    case MembershipTier.BASIC:
    case MembershipTier.PRO:
    case MembershipTier.MASTER:
      return 9999;
    default:
      return 0;
  }
}

async function lookupMembership(connection: DbConnection, userId: string) {
  const rows = await queryRows<MembershipRow>(
    connection,
    `SELECT tier, started_at, renewal_interval_days, last_renewed_at
     FROM users_membership
     WHERE user = ? AND is_active = 1
     LIMIT 1`,
    [userId],
  );

  return rows[0] || null;
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

async function resetUserBalanceForTier(
  connection: DbConnection,
  userId: string,
  tier: MembershipTier,
) {
  await ensureUserBalanceRow(connection, userId);
  await queryRows(
    connection,
    `UPDATE users_balance
     SET balance = ?, download_point = ?
     WHERE user = ?`,
    [getMembershipCredits(tier), getMembershipDownloadPoints(tier), userId],
  );
}

export async function applyMembershipByOrderName(
  connection: DbConnection,
  userId: string,
  orderName: string,
) {
  const plan = parsePlanFromOrderName(orderName);
  if (!plan) {
    return false;
  }

  const current = await lookupMembership(connection, userId);
  const hasExistingMembership = Boolean(current && current.tier !== MembershipTier.FREE);

  if (!hasExistingMembership) {
    await queryRows(
      connection,
      `INSERT INTO users_membership (user, tier, started_at, renewal_interval_days, last_renewed_at, is_active)
       VALUES (?, ?, NOW(), ?, NOW(), 1)`,
      [userId, plan.tier, plan.renewalDays],
    );
  } else if ((current?.tier || MembershipTier.FREE) < plan.tier) {
    await queryRows(
      connection,
      `UPDATE users_membership
       SET tier = ?, renewal_interval_days = ?, last_renewed_at = NOW(), is_active = 1
       WHERE user = ?`,
      [plan.tier, plan.renewalDays, userId],
    );
  } else {
    await queryRows(
      connection,
      `UPDATE users_membership
       SET renewal_interval_days = ?, last_renewed_at = NOW(), is_active = 1
       WHERE user = ?`,
      [plan.renewalDays, userId],
    );
  }

  await resetUserBalanceForTier(connection, userId, plan.tier);
  return true;
}

export type RedeemMembershipType = "basic" | "premium" | "pro" | "dev" | "edu";

export function redeemMembershipTypeToTier(membershipType: RedeemMembershipType): MembershipTier {
  switch (membershipType) {
    case "basic":
      return MembershipTier.BASIC;
    case "pro":
      return MembershipTier.PRO;
    case "premium":
      return MembershipTier.MASTER;
    case "edu":
      return MembershipTier.EDU;
    case "dev":
      return MembershipTier.DEV;
    default:
      throw new Error(`Invalid membership type: ${membershipType}`);
  }
}

export async function grantRedeemMembership(
  connection: DbConnection,
  userId: string,
  membershipType: RedeemMembershipType,
  durationDays: number,
) {
  const tier = redeemMembershipTypeToTier(membershipType);
  const safeDurationDays = Math.max(1, Math.floor(durationDays));

  await queryRows(
    connection,
    `INSERT INTO users_membership (user, tier, started_at, renewal_interval_days, last_renewed_at, is_active)
     VALUES (?, ?, NOW(), ?, NOW(), 1)
     ON DUPLICATE KEY UPDATE
       tier = GREATEST(tier, VALUES(tier)),
       renewal_interval_days = GREATEST(renewal_interval_days, VALUES(renewal_interval_days)),
       last_renewed_at = VALUES(last_renewed_at),
       is_active = VALUES(is_active)`,
    [userId, tier, safeDurationDays],
  );
}

async function resolveLaterExpiry(
  connection: DbConnection,
  userId: string,
  column: "bonus_credits_expires_at" | "bonus_download_points_expires_at",
  candidateExpiresAt: Date,
): Promise<Date> {
  try {
    const rows = await queryRows<RowDataPacket & { existing: Date | string | null }>(
      connection,
      `SELECT ${column} AS existing FROM users_balance WHERE user = ? LIMIT 1`,
      [userId],
    );
    const existing = rows[0]?.existing;
    if (existing) {
      const existingDate = existing instanceof Date ? existing : new Date(existing);
      if (!Number.isNaN(existingDate.getTime()) && existingDate > candidateExpiresAt) {
        return existingDate;
      }
    }
  } catch {
    // Column may not exist yet on legacy deployments. Fall back to the candidate expiry.
  }
  return candidateExpiresAt;
}

export async function addBonusCredits(
  connection: DbConnection,
  userId: string,
  amount: number,
  expiresInDays: number,
  description: string,
) {
  if (amount <= 0) {
    return;
  }

  await ensureUserBalanceRow(connection, userId);

  const candidateExpiresAt = new Date();
  candidateExpiresAt.setDate(candidateExpiresAt.getDate() + Math.max(1, Math.floor(expiresInDays)));
  const finalExpiresAt = await resolveLaterExpiry(
    connection,
    userId,
    "bonus_credits_expires_at",
    candidateExpiresAt,
  );

  await queryRows(
    connection,
    `UPDATE users_balance
     SET bonus_credits = COALESCE(bonus_credits, 0) + ?,
         bonus_credits_expires_at = ?
     WHERE user = ?`,
    [amount, finalExpiresAt, userId],
  );

  try {
    const balanceRows = await queryRows<RowDataPacket & { balance: number; bonus_credits: number | null }>(
      connection,
      "SELECT balance, bonus_credits FROM users_balance WHERE user = ? LIMIT 1",
      [userId],
    );
    const totalBalance = Number(balanceRows[0]?.balance || 0) + Number(balanceRows[0]?.bonus_credits || 0);

    await queryRows(
      connection,
      `INSERT INTO users_transaction
       (id, operated_by, user, subject, change_amount, balance, datetime)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [crypto.randomUUID(), "system", userId, description, amount, totalBalance],
    );
  } catch {
    // Transaction log is best-effort. Legacy deployments without users_transaction column parity must not fail the grant.
  }
}

export async function addBonusDownloadPoints(
  connection: DbConnection,
  userId: string,
  amount: number,
  expiresInDays: number,
) {
  if (amount <= 0) {
    return;
  }

  await ensureUserBalanceRow(connection, userId);

  const candidateExpiresAt = new Date();
  candidateExpiresAt.setDate(candidateExpiresAt.getDate() + Math.max(1, Math.floor(expiresInDays)));
  const finalExpiresAt = await resolveLaterExpiry(
    connection,
    userId,
    "bonus_download_points_expires_at",
    candidateExpiresAt,
  );

  await queryRows(
    connection,
    `UPDATE users_balance
     SET bonus_download_points = COALESCE(bonus_download_points, 0) + ?,
         bonus_download_points_expires_at = ?
     WHERE user = ?`,
    [amount, finalExpiresAt, userId],
  );
}
