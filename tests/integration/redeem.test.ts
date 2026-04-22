import type { Connection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanupByPrefix, pingTestDb, testConnection, testEnv } from "./_setup/db";
import { createTestRedeemCode, createTestUser } from "./_setup/fixtures";

const PREFIX = "IT-RDM-";

// Resolve env + DB reachability synchronously via top-level await so that
// `it.skipIf()` (which evaluates at describe-declaration time) sees the
// correct boolean. Checking these inside `beforeAll` is too late — tests
// would always skip or always run without a chance to introspect state.
let resolvedEnv: ReturnType<typeof testEnv> | null = null;
try {
  resolvedEnv = testEnv();
} catch {
  resolvedEnv = null;
}
const dbReachable = resolvedEnv ? await pingTestDb() : false;
const shouldSkip = !resolvedEnv || !dbReachable;
if (!resolvedEnv) {
  console.warn(
    "[integration] TEST_DB_* env vars not set. Skipping redeem integration suite. Run scripts/test-db-setup.sh and export TEST_DB_HOST/USER/PASS/NAME.",
  );
} else if (!dbReachable) {
  console.warn("[integration] TEST_DB_* configured but DB unreachable. Skipping redeem integration suite.");
}

async function postRedeem(env: ReturnType<typeof testEnv>, ssid: string, code: string) {
  const request = new Request("http://worker.test/api/redeem", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ssid}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

describe("POST /api/redeem — integration", () => {
  const env = resolvedEnv;

  let conn: Connection;

  beforeAll(async () => {
    if (shouldSkip) return;
    conn = await testConnection();
    await cleanupByPrefix(conn, PREFIX);
  });

  afterEach(async () => {
    if (conn) await cleanupByPrefix(conn, PREFIX);
  });

  afterAll(async () => {
    if (conn) await conn.end();
  });

  it.skipIf(shouldSkip)("grants combo rewards and updates DB state", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const code = await createTestRedeemCode(conn, {
      prefix: PREFIX,
      reward_type: "combo",
      membership_type: "basic",
      duration_days: 30,
      credits_amount: 100,
      download_points_amount: 50,
      max_uses: 1,
    });

    const response = await postRedeem(env!, user.ssid, code.code);
    const body = (await response.json()) as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.rewardType).toBe("combo");
    expect(body.data.membership).toMatchObject({ type: "basic", durationDays: 30 });
    expect(body.data.credits).toMatchObject({ amount: 100, expiresInDays: 30 });
    expect(body.data.downloadPoints).toMatchObject({ amount: 50, expiresInDays: 30 });
    expect(body.data.codeUsage).toMatchObject({ current: 1, max: 1, remaining: 0 });

    const [rdmRows] = (await conn.query(
      "SELECT current_uses FROM redeem_codes WHERE code = ?",
      [code.code],
    )) as [Array<RowDataPacket & { current_uses: number }>, unknown];
    expect(rdmRows[0]?.current_uses).toBe(1);

    const [usageRows] = (await conn.query(
      "SELECT reward_type, membership_type, membership_days, credits_granted, download_points_granted FROM redeem_code_usage WHERE used_by = ?",
      [user.id],
    )) as [Array<RowDataPacket & Record<string, unknown>>, unknown];
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      reward_type: "combo",
      membership_type: "basic",
      membership_days: 30,
      credits_granted: 100,
      download_points_granted: 50,
    });

    const [balanceRows] = (await conn.query(
      "SELECT bonus_credits, bonus_download_points FROM users_balance WHERE user = ?",
      [user.id],
    )) as [Array<RowDataPacket & { bonus_credits: number; bonus_download_points: number }>, unknown];
    expect(balanceRows[0]?.bonus_credits).toBe(100);
    expect(balanceRows[0]?.bonus_download_points).toBe(50);

    const [membershipRows] = (await conn.query(
      "SELECT tier, is_active FROM users_membership WHERE user = ?",
      [user.id],
    )) as [Array<RowDataPacket & { tier: number; is_active: number }>, unknown];
    // basic → tier 1. GREATEST() picks this over the baseline tier 0 inserted by the fixture.
    expect(membershipRows[0]?.tier).toBe(1);
    expect(membershipRows[0]?.is_active).toBe(1);
  });

  it.skipIf(shouldSkip)("rejects second use by the same user", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const code = await createTestRedeemCode(conn, {
      prefix: PREFIX,
      reward_type: "membership",
      membership_type: "basic",
      duration_days: 30,
      max_uses: -1,
    });

    const first = await postRedeem(env!, user.ssid, code.code);
    expect(first.status).toBe(200);

    const second = await postRedeem(env!, user.ssid, code.code);
    const body = (await second.json()) as Record<string, any>;
    expect(second.status).toBe(400);
    expect(body.success).toBe(false);
    expect(String(body.message)).toMatch(/already used/i);
  });

  it.skipIf(shouldSkip)("rejects expired code with 400", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const expired = new Date(Date.now() - 24 * 3600 * 1000); // yesterday
    const code = await createTestRedeemCode(conn, {
      prefix: PREFIX,
      reward_type: "membership",
      membership_type: "basic",
      duration_days: 30,
      max_uses: -1,
      expires_at: expired,
    });

    const response = await postRedeem(env!, user.ssid, code.code);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/expired/i);
  });

  it.skipIf(shouldSkip)("rejects inactive code with 400", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const code = await createTestRedeemCode(conn, {
      prefix: PREFIX,
      reward_type: "membership",
      membership_type: "basic",
      duration_days: 30,
      max_uses: -1,
      is_active: false,
    });

    const response = await postRedeem(env!, user.ssid, code.code);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/no longer active|inactive/i);
  });

  it.skipIf(shouldSkip)("rejects unknown code with 400", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const response = await postRedeem(env!, user.ssid, `${PREFIX}DOES-NOT-EXIST`);
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/invalid/i);
  });

  it.skipIf(shouldSkip)("allows exactly one winner under concurrent use for max_uses=1", async () => {
    const userA = await createTestUser(conn, { prefix: PREFIX });
    const userB = await createTestUser(conn, { prefix: PREFIX });
    const code = await createTestRedeemCode(conn, {
      prefix: PREFIX,
      reward_type: "membership",
      membership_type: "basic",
      duration_days: 30,
      max_uses: 1,
    });

    const [responseA, responseB] = await Promise.all([
      postRedeem(env!, userA.ssid, code.code),
      postRedeem(env!, userB.ssid, code.code),
    ]);

    const statuses = [responseA.status, responseB.status].sort();
    expect(statuses).toEqual([200, 400]);

    const [rdmRows] = (await conn.query(
      "SELECT current_uses FROM redeem_codes WHERE code = ?",
      [code.code],
    )) as [Array<RowDataPacket & { current_uses: number }>, unknown];
    expect(rdmRows[0]?.current_uses).toBe(1);

    const [usageRows] = (await conn.query(
      "SELECT used_by FROM redeem_code_usage WHERE code = ?",
      [code.code],
    )) as [Array<RowDataPacket & { used_by: string }>, unknown];
    expect(usageRows).toHaveLength(1);
  });
});
