import type { Connection, RowDataPacket } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanupByPrefix, pingTestDb, testConnection, testEnv } from "./_setup/db";

const PREFIX = "IT-WHK-";

// Leave TOSS_WEBHOOK_SECRET undefined so APP_ENV=development bypass applies.
// Idempotency itself is orthogonal to signature verification; testing them
// separately keeps the assertions tight.
let resolvedEnv: ReturnType<typeof testEnv> | null = null;
try {
  resolvedEnv = testEnv({ appEnv: "development" });
} catch {
  resolvedEnv = null;
}
const dbReachable = resolvedEnv ? await pingTestDb() : false;
const shouldSkip = !resolvedEnv || !dbReachable;
if (!resolvedEnv) {
  console.warn("[integration] TEST_DB_* env vars not set. Skipping webhook idempotency suite.");
} else if (!dbReachable) {
  console.warn("[integration] DB unreachable. Skipping webhook idempotency suite.");
}

async function postWebhook(
  env: ReturnType<typeof testEnv>,
  payload: Record<string, unknown>,
) {
  const request = new Request("http://worker.test/api/payments/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

describe("POST /api/payments/webhook — idempotency", () => {
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

  it.skipIf(shouldSkip)(
    "returns idempotent:true on replay and writes exactly one audit row",
    async () => {
      const webhookId = `${PREFIX}${crypto.randomUUID()}`;
      const payload = {
        id: webhookId,
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey: `${PREFIX}pk-xyz`, status: "DONE" },
      };

      // First delivery: payment does not exist so the handler reports
      // "payment_not_found", but the audit row is still written as PROCESSED.
      const first = await postWebhook(env!, payload);
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as Record<string, any>;
      expect(firstBody.idempotent).toBeUndefined();
      expect(firstBody.data?.action).toBe("payment_not_found");

      // Second delivery with identical body: short-circuits through the
      // findProcessedWebhookResult cache. No new audit row.
      const second = await postWebhook(env!, payload);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as Record<string, any>;
      expect(secondBody.data?.idempotent).toBe(true);
      expect(secondBody.data?.webhookId).toBe(webhookId);

      const [auditRows] = (await conn.query(
        "SELECT status FROM worker_payment_webhook_audit WHERE webhook_id = ?",
        [webhookId],
      )) as [Array<RowDataPacket & { status: string }>, unknown];
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.status).toBe("PROCESSED");
    },
  );

  it.skipIf(shouldSkip)(
    "treats two identical-body deliveries without an `id` as the same event (sha256 fallback)",
    async () => {
      const suffix = crypto.randomUUID();
      const payload = {
        eventType: "PAYMENT_WEBHOOK",
        data: { paymentKey: `${PREFIX}pk-${suffix}`, status: "DONE" },
      };

      const r1 = await postWebhook(env!, payload);
      expect(r1.status).toBe(200);
      const b1 = (await r1.json()) as Record<string, any>;
      expect(b1.idempotent).toBeUndefined();

      const r2 = await postWebhook(env!, payload);
      expect(r2.status).toBe(200);
      const b2 = (await r2.json()) as Record<string, any>;
      expect(b2.data?.idempotent).toBe(true);
      expect(String(b2.data?.webhookId || "")).toMatch(/^body_sha256:/);

      // Cleanup for this test uses the sha256-style webhook id, which does not
      // match our PREFIX. Remove by webhookId from the response body instead.
      const hashId = b2.data.webhookId as string;
      await conn.query("DELETE FROM worker_payment_webhook_audit WHERE webhook_id = ?", [hashId]);
    },
  );

  it.skipIf(shouldSkip)(
    "refuses webhook requests when APP_ENV=staging and secret is missing",
    async () => {
      const stagingEnv = testEnv({ appEnv: "staging" });
      const payload = {
        id: `${PREFIX}${crypto.randomUUID()}`,
        eventType: "PAYMENT_STATUS_CHANGED",
        data: { paymentKey: `${PREFIX}pk-staging`, status: "DONE" },
      };

      const response = await postWebhook(stagingEnv, payload);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, any>;
      expect(String(body.message)).toMatch(/verification is required/i);
    },
  );
});
