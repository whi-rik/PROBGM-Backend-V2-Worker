import { createConnection, type Connection } from "mysql2/promise";
import type { Bindings } from "../../../src/env";

export interface TestEnvOptions {
  appEnv?: string;
  webhookAuditTable?: string;
  tossWebhookSecret?: string;
  adminUserIds?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set for integration tests`);
  }
  return value;
}

export function testEnv(options: TestEnvOptions = {}): Bindings {
  return {
    APP_ENV: options.appEnv || "development",
    DB_PROVIDER: "mysql",
    DB_HOST: requireEnv("TEST_DB_HOST"),
    DB_PORT: process.env.TEST_DB_PORT || "23306",
    DB_USER: requireEnv("TEST_DB_USER"),
    DB_PASS: process.env.TEST_DB_PASS || "",
    DB_NAME: requireEnv("TEST_DB_NAME"),
    SESSION_EXPIRY_HOURS: "24",
    PAYMENT_WEBHOOK_AUDIT_TABLE: options.webhookAuditTable || "worker_payment_webhook_audit",
    TOSS_WEBHOOK_SECRET: options.tossWebhookSecret,
    ADMIN_USER_IDS: options.adminUserIds,
  };
}

export async function testConnection(): Promise<Connection> {
  return createConnection({
    host: requireEnv("TEST_DB_HOST"),
    port: Number(process.env.TEST_DB_PORT || "23306"),
    user: requireEnv("TEST_DB_USER"),
    password: process.env.TEST_DB_PASS || "",
    database: requireEnv("TEST_DB_NAME"),
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
  });
}

export async function pingTestDb(): Promise<boolean> {
  try {
    const conn = await testConnection();
    await conn.query("SELECT 1");
    await conn.end();
    return true;
  } catch {
    return false;
  }
}

export async function cleanupByPrefix(conn: Connection, prefix: string) {
  // Cleanup uses prefix pattern so leftover rows from crashed runs can be removed
  // by a repeat invocation. Order matters: children before parents.
  await conn.query(`DELETE FROM redeem_code_usage WHERE code LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM redeem_codes WHERE code LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM worker_payment_webhook_audit WHERE webhook_id LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM users_transaction WHERE user LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM users_membership WHERE user LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM users_balance WHERE user LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM users_tokens WHERE user_id LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM users WHERE id LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM payments WHERE user_id LIKE ?`, [`${prefix}%`]);
  await conn.query(`DELETE FROM billing_cycles WHERE user_id LIKE ?`, [`${prefix}%`]);
}
