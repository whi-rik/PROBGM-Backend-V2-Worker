import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanupByPrefix, pingTestDb, testConnection, testEnv } from "./_setup/db";
import { createTestBillingCycle, createTestUser } from "./_setup/fixtures";

const PREFIX = "IT-BIL-";

let resolvedEnv: ReturnType<typeof testEnv> | null = null;
try {
  resolvedEnv = testEnv();
} catch {
  resolvedEnv = null;
}
const dbReachable = resolvedEnv ? await pingTestDb() : false;
const shouldSkip = !resolvedEnv || !dbReachable;
if (!resolvedEnv) {
  console.warn("[integration] TEST_DB_* env vars not set. Skipping billing state suite.");
} else if (!dbReachable) {
  console.warn("[integration] DB unreachable. Skipping billing state suite.");
}

function headers(ssid: string): HeadersInit {
  return { Authorization: `Bearer ${ssid}`, "Content-Type": "application/json" };
}

async function putBilling(
  env: ReturnType<typeof testEnv>,
  ssid: string,
  id: number,
  action: "pause" | "resume",
  body: Record<string, unknown> = {},
) {
  const request = new Request(`http://worker.test/api/billing/${id}/${action}`, {
    method: "PUT",
    headers: headers(ssid),
    body: JSON.stringify(body),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

async function deleteBilling(env: ReturnType<typeof testEnv>, ssid: string, id: number) {
  const request = new Request(`http://worker.test/api/billing/${id}`, {
    method: "DELETE",
    headers: headers(ssid),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

async function postProcessPending(env: ReturnType<typeof testEnv>, ssid: string) {
  const request = new Request("http://worker.test/api/billing/process/pending", {
    method: "POST",
    headers: headers(ssid),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

async function getCronStatus(env: ReturnType<typeof testEnv>, ssid: string) {
  const request = new Request("http://worker.test/api/billing/cron/status", {
    method: "GET",
    headers: headers(ssid),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

describe("billing state transitions + manual trigger — integration", () => {
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

  it.skipIf(shouldSkip)("pause: ACTIVE → PAUSED", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, { prefix: PREFIX, userId: user.id, status: "ACTIVE" });

    const response = await putBilling(env!, user.ssid, cycle.id, "pause");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("PAUSED");

    const [rows] = (await conn.query(
      "SELECT status FROM billing_cycles WHERE id = ?",
      [cycle.id],
    )) as [Array<RowDataPacket & { status: string }>, unknown];
    expect(rows[0]?.status).toBe("PAUSED");
  });

  it.skipIf(shouldSkip)("pause rejects non-ACTIVE cycle with 400", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, { prefix: PREFIX, userId: user.id, status: "PAUSED" });

    const response = await putBilling(env!, user.ssid, cycle.id, "pause");
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/Cannot pause .* PAUSED/i);
  });

  it.skipIf(shouldSkip)("resume: PAUSED → ACTIVE (next_billing_date recomputed if not supplied)", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, {
      prefix: PREFIX,
      userId: user.id,
      status: "PAUSED",
      cycleType: "MONTHLY",
      billingDay: 15,
    });

    const response = await putBilling(env!, user.ssid, cycle.id, "resume");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ACTIVE");
    expect(body.data.next_billing_date).toBeTruthy();

    const [rows] = (await conn.query(
      "SELECT status, next_billing_date FROM billing_cycles WHERE id = ?",
      [cycle.id],
    )) as [Array<RowDataPacket & { status: string; next_billing_date: Date | null }>, unknown];
    expect(rows[0]?.status).toBe("ACTIVE");
    expect(rows[0]?.next_billing_date).toBeTruthy();
  });

  it.skipIf(shouldSkip)("resume rejects non-PAUSED cycle with 400", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, { prefix: PREFIX, userId: user.id, status: "ACTIVE" });

    const response = await putBilling(env!, user.ssid, cycle.id, "resume");
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/Cannot resume .* ACTIVE/i);
  });

  it.skipIf(shouldSkip)("delete marks cycle CANCELLED and rejects a second cancel", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, { prefix: PREFIX, userId: user.id, status: "ACTIVE" });

    const first = await deleteBilling(env!, user.ssid, cycle.id);
    expect(first.status).toBe(200);

    const [rows] = (await conn.query(
      "SELECT status FROM billing_cycles WHERE id = ?",
      [cycle.id],
    )) as [Array<RowDataPacket & { status: string }>, unknown];
    expect(rows[0]?.status).toBe("CANCELLED");

    const second = await deleteBilling(env!, user.ssid, cycle.id);
    expect(second.status).toBe(400);
    const body = (await second.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/already cancelled|CANCELLED/i);
  });

  it.skipIf(shouldSkip)("ownership guard: another user gets 404, not 200", async () => {
    const owner = await createTestUser(conn, { prefix: PREFIX });
    const intruder = await createTestUser(conn, { prefix: PREFIX });
    const cycle = await createTestBillingCycle(conn, { prefix: PREFIX, userId: owner.id, status: "ACTIVE" });

    const response = await putBilling(env!, intruder.ssid, cycle.id, "pause");
    expect(response.status).toBe(404);
  });

  it.skipIf(shouldSkip)("process/pending runs safely with no due cycles and is idempotent across retries", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });

    const first = await postProcessPending(env!, user.ssid);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, any>;
    expect(firstBody.success).toBe(true);
    expect(firstBody.data).toBeDefined();
    expect(firstBody.data.due).toBeDefined();
    expect(firstBody.data.retries).toBeDefined();

    const second = await postProcessPending(env!, user.ssid);
    expect(second.status).toBe(200);
  });

  it.skipIf(shouldSkip)("cron/status advertises worker-native runtime and its cron schedules", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });

    const response = await getCronStatus(env!, user.ssid);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.data.runtime).toBe("cloudflare-workers-scheduled");
    expect(body.data.isRunning).toBe(true);
    expect(body.data.schedules).toBeDefined();
  });
});
