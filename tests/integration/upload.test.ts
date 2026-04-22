import type { Connection } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanupByPrefix, pingTestDb, testConnection, testEnv } from "./_setup/db";
import { createTestUser } from "./_setup/fixtures";

const PREFIX = "IT-UPL-";

let resolvedEnv: ReturnType<typeof testEnv> | null = null;
try {
  resolvedEnv = testEnv();
} catch {
  resolvedEnv = null;
}
const dbReachable = resolvedEnv ? await pingTestDb() : false;
const shouldSkip = !resolvedEnv || !dbReachable;
if (!resolvedEnv) {
  console.warn("[integration] TEST_DB_* env vars not set. Skipping upload suite.");
} else if (!dbReachable) {
  console.warn("[integration] DB unreachable. Skipping upload suite.");
}

describe("POST /api/upload — integration", () => {
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

  it.skipIf(shouldSkip)("returns 503 when UPLOADS_BUCKET binding is missing", async () => {
    const user = await createTestUser(conn, { prefix: PREFIX });

    const fileContent = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x40])], { type: "audio/mpeg" });
    const form = new FormData();
    form.append("file", new File([fileContent], "test.mp3", { type: "audio/mpeg" }));

    const request = new Request("http://worker.test/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${user.ssid}` },
      body: form,
    });
    const response = await worker.fetch(request, env!, {
      waitUntil() {},
      passThroughOnException() {},
    } as ExecutionContext);

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, any>;
    expect(String(body.message)).toMatch(/R2.*not configured/i);
  });

  it.skipIf(shouldSkip)("rejects unauthenticated upload with 401 before bucket check", async () => {
    const fileContent = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x40])], { type: "audio/mpeg" });
    const form = new FormData();
    form.append("file", new File([fileContent], "test.mp3", { type: "audio/mpeg" }));

    const request = new Request("http://worker.test/api/upload", {
      method: "POST",
      body: form,
    });
    const response = await worker.fetch(request, env!, {
      waitUntil() {},
      passThroughOnException() {},
    } as ExecutionContext);

    expect(response.status).toBe(401);
  });
});
