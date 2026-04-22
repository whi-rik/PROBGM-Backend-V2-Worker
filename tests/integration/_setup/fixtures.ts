import type { Connection } from "mysql2/promise";

export interface CreateTestUserOptions {
  prefix: string;
  username?: string;
  email?: string;
  isNewbieConfirmed?: boolean;
}

export interface TestUser {
  id: string;
  ssid: string;
  email: string;
}

export async function createTestUser(conn: Connection, options: CreateTestUserOptions): Promise<TestUser> {
  const id = `${options.prefix}${crypto.randomUUID().slice(0, 8)}`;
  const ssid = crypto.randomUUID();
  const username = options.username || `user-${id.slice(-8)}`;
  const email = options.email || `${id}@test.local`;

  await conn.query(
    `INSERT INTO users (id, username, email, password_hash, provider, is_active, is_newbie_confirmed)
     VALUES (?, ?, ?, ?, 'local', 1, ?)`,
    [id, username, email, "bcrypt-placeholder", options.isNewbieConfirmed ? 1 : 0],
  );

  await conn.query(
    `INSERT INTO users_tokens (user_id, token, token_type, client_ip, user_agent, is_expire, issued_in)
     VALUES (?, ?, 'access', '127.0.0.1', 'integration-test', 0, NOW())`,
    [id, ssid],
  );

  await conn.query(
    `INSERT INTO users_balance (user, balance, download_point, bonus_credits, bonus_download_points)
     VALUES (?, 20, 3, 0, 0)`,
    [id],
  );

  await conn.query(
    `INSERT INTO users_membership (user, tier, started_at, renewal_interval_days, last_renewed_at, is_active)
     VALUES (?, 0, NOW(), 9999, NOW(), 1)`,
    [id],
  );

  return { id, ssid, email };
}

export interface CreateTestRedeemCodeOptions {
  prefix: string;
  code?: string;
  reward_type?: "membership" | "credits" | "download_points" | "combo";
  membership_type?: "basic" | "premium" | "pro" | "dev" | "edu" | null;
  duration_days?: number;
  credits_amount?: number | null;
  download_points_amount?: number | null;
  max_uses?: number;
  is_active?: boolean;
  expires_at?: Date | null;
}

export interface TestRedeemCode {
  id: number;
  code: string;
}

export async function createTestRedeemCode(
  conn: Connection,
  options: CreateTestRedeemCodeOptions,
): Promise<TestRedeemCode> {
  const code = options.code || `${options.prefix}${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const [result] = await conn.query(
    `INSERT INTO redeem_codes
     (code, reward_type, membership_type, duration_days, credits_amount, download_points_amount, max_uses, current_uses, is_active, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      code,
      options.reward_type || "membership",
      options.membership_type || null,
      options.duration_days ?? 30,
      options.credits_amount ?? null,
      options.download_points_amount ?? null,
      options.max_uses ?? 1,
      options.is_active === false ? 0 : 1,
      options.expires_at || null,
    ],
  );

  const id = (result as { insertId: number }).insertId;
  return { id, code };
}

export interface CreateTestBillingCycleOptions {
  prefix: string;
  userId: string;
  status?: "ACTIVE" | "PAUSED" | "CANCELLED" | "EXPIRED";
  cycleType?: "MONTHLY" | "YEARLY";
  billingDay?: number;
  amount?: number;
  customerKey?: string;
  billingKey?: string;
  nextBillingDate?: Date;
  maxRetries?: number;
}

export interface TestBillingCycle {
  id: number;
  userId: string;
  status: "ACTIVE" | "PAUSED" | "CANCELLED" | "EXPIRED";
}

/**
 * The real `billing_cycles` schema requires `payment_id` (NOT NULL). We create
 * a throwaway payment row first so the billing cycle satisfies that constraint.
 * The payment row is cleaned up via `cleanupByPrefix` (DELETE FROM payments
 * WHERE user_id LIKE prefix%).
 */
export async function createTestBillingCycle(
  conn: Connection,
  options: CreateTestBillingCycleOptions,
): Promise<TestBillingCycle> {
  const status = options.status || "ACTIVE";
  const amount = options.amount ?? 9900;
  const customerKey =
    options.customerKey || `${options.prefix}ck-${crypto.randomUUID().slice(0, 8)}`;
  const billingKey =
    options.billingKey || `${options.prefix}bk-${crypto.randomUUID().slice(0, 8)}`;
  const nextBillingDate =
    options.nextBillingDate || new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const [paymentResult] = await conn.query(
    `INSERT INTO payments
     (payment_key, order_id, order_name, amount, currency, method, status, user_id, customer_key, billing_key, is_billing, created_by)
     VALUES (?, ?, ?, ?, 'KRW', 'BILLING', 'DONE', ?, ?, ?, 1, ?)`,
    [
      `${options.prefix}pk-${crypto.randomUUID().slice(0, 12)}`,
      `${options.prefix}oid-${crypto.randomUUID().slice(0, 12)}`,
      `${options.prefix}BASIC Monthly`,
      amount,
      options.userId,
      customerKey,
      billingKey,
      options.userId,
    ],
  );
  const paymentId = (paymentResult as { insertId: number }).insertId;

  const [result] = await conn.query(
    `INSERT INTO billing_cycles
     (payment_id, user_id, customer_key, billing_key, cycle_type, billing_day, amount,
      status, next_billing_date, retry_count, max_retries)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      paymentId,
      options.userId,
      customerKey,
      billingKey,
      options.cycleType || "MONTHLY",
      options.billingDay ?? 1,
      amount,
      status,
      nextBillingDate,
      options.maxRetries ?? 3,
    ],
  );

  const id = (result as { insertId: number }).insertId;
  return { id, userId: options.userId, status };
}
