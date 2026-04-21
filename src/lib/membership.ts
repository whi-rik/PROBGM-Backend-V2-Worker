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
