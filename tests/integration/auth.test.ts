import type { Connection } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanupByPrefix, pingTestDb, testConnection, testEnv } from "./_setup/db";
import { createTestUser } from "./_setup/fixtures";

const PREFIX = "IT-AUTH-";

let resolvedEnv: ReturnType<typeof testEnv> | null = null;
try {
  resolvedEnv = testEnv();
} catch {
  resolvedEnv = null;
}
const dbReachable = resolvedEnv ? await pingTestDb() : false;
const shouldSkip = !resolvedEnv || !dbReachable;
if (!resolvedEnv) {
  console.warn("[integration] TEST_DB_* env vars not set. Skipping auth suite.");
} else if (!dbReachable) {
  console.warn("[integration] DB unreachable. Skipping auth suite.");
}

async function getUserInfo(env: ReturnType<typeof testEnv>, ssid: string | null, path = "/user/info") {
  const headers: Record<string, string> = ssid ? { Authorization: `Bearer ${ssid}` } : {};
  const request = new Request(`http://worker.test${path}`, { method: "GET", headers });
  return worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} } as ExecutionContext);
}

describe("auth / session — integration", () => {
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

  it.skipIf(shouldSkip)("session-required route returns 401 without a Bearer header", async () => {
    const response = await getUserInfo(env!, null);
    expect(response.status).toBe(401);
  });

  it.skipIf(shouldSkip)("session-required route returns 401 for an unknown token", async () => {
    const response = await getUserInfo(env!, `bogus-${crypto.randomUUID()}`);
    expect(response.status).toBe(401);
  });

  it.skipIf(shouldSkip)("session-required route returns 401 when is_expire=1", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });
    await conn.query(
      `UPDATE users_tokens SET is_expire = 1 WHERE token = ?`,
      [user.ssid],
    );

    const response = await getUserInfo(env!, user.ssid);
    expect(response.status).toBe(401);
  });

  it.skipIf(shouldSkip)("same handler is reachable at both /user/info and /api/user/info (dual mount)", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });

    const shortForm = await getUserInfo(env!, user.ssid, "/user/info");
    const prefixedForm = await getUserInfo(env!, user.ssid, "/api/user/info");

    expect(shortForm.status).toBe(200);
    expect(prefixedForm.status).toBe(200);
    const shortBody = (await shortForm.json()) as Record<string, any>;
    const prefixedBody = (await prefixedForm.json()) as Record<string, any>;
    expect(shortBody.data.id).toBe(user.id);
    expect(prefixedBody.data.id).toBe(user.id);
  });
});
