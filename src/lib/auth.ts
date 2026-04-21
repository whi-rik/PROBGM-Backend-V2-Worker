import bcrypt from "bcryptjs";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { queryRows, withConnection, type DbConnection } from "./db";

interface SessionRow extends RowDataPacket {
  user_id: string;
  client_ip: string | null;
  user_agent: string | null;
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  email: string | null;
  password_hash?: string | null;
  provider: string;
  is_active: number;
  is_newbie_confirmed: number;
  created_at: Date | null;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  provider: string;
  is_newbie: boolean;
  created_at: Date | null;
}

export interface AuthSession {
  ssid: string;
  user: AuthUser;
}

export interface RegisteredUser {
  id: string;
  username: string;
  email: string;
  provider: string;
  created_at: Date | null;
}

export type SocialProvider = "google" | "facebook" | "kakao";

function isSupportedSocialProvider(provider: string): provider is SocialProvider {
  return provider === "google" || provider === "facebook" || provider === "kakao";
}

async function initializeDefaultUserData(connection: DbConnection, userId: string) {
  const balanceRows = await queryRows<RowDataPacket & { user: string }>(
    connection,
    "SELECT user FROM users_balance WHERE user = ? LIMIT 1",
    [userId],
  );
  if (!balanceRows[0]) {
    await queryRows(
      connection,
      `INSERT INTO users_balance (user, balance, download_point)
       VALUES (?, 20, 3)`,
      [userId],
    );
  }

  await queryRows(
    connection,
    `INSERT INTO playlist
     (id, user_id, title, description, created_in, is_hide, is_default, is_public)
     VALUES (?, ?, 'Favorites', 'My Favorites Playlist', NOW(), 0, 1, 0)`,
    [crypto.randomUUID(), userId],
  );

  const membershipRows = await queryRows<RowDataPacket & { user: string }>(
    connection,
    "SELECT user FROM users_membership WHERE user = ? LIMIT 1",
    [userId],
  );
  if (membershipRows[0]) {
    await queryRows(
      connection,
      `UPDATE users_membership
       SET tier = 0, started_at = NOW(), renewal_interval_days = 9999, last_renewed_at = NOW(), is_active = 1
       WHERE user = ?`,
      [userId],
    );
  } else {
    await queryRows(
      connection,
      `INSERT INTO users_membership
       (user, tier, started_at, renewal_interval_days, last_renewed_at, is_active)
       VALUES (?, 0, NOW(), 9999, NOW(), 1)`,
      [userId],
    );
  }
}

function getClientIp(headers: Headers): string {
  return headers.get("CF-Connecting-IP") || headers.get("X-Forwarded-For") || "N/A";
}

function getUserAgent(headers: Headers): string {
  return headers.get("User-Agent") || "N/A";
}

function getSessionExpiryHours(env: Bindings): number {
  const raw = Number.parseInt(env.SESSION_EXPIRY_HOURS || "24", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

export function extractBearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authorizationHeader.slice("Bearer ".length).trim();
  return token || null;
}

async function lookupSession(
  connection: DbConnection,
  env: Bindings,
  ssid: string,
): Promise<SessionRow | null> {
  const rows = await queryRows<SessionRow>(
    connection,
    `SELECT user_id, client_ip, user_agent
     FROM users_tokens
     WHERE token = ?
       AND is_expire = 0
       AND issued_in > ?
     LIMIT 1`,
    [ssid, new Date(Date.now() - getSessionExpiryHours(env) * 60 * 60 * 1000)],
  );

  return rows[0] || null;
}

async function expireSession(connection: DbConnection, ssid: string) {
  await queryRows(connection, "UPDATE users_tokens SET is_expire = 1 WHERE token = ?", [ssid]);
}

async function lookupUser(connection: DbConnection, userId: string): Promise<AuthUser | null> {
  const rows = await queryRows<UserRow>(
    connection,
    `SELECT id, username, email, provider, is_active, is_newbie_confirmed, created_at
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId],
  );

  const row = rows[0];
  if (!row || !row.is_active) {
    return null;
  }

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    provider: row.provider,
    is_newbie: !Boolean(row.is_newbie_confirmed),
    created_at: row.created_at,
  };
}

async function touchSession(connection: DbConnection, ssid: string) {
  await queryRows(
    connection,
    "UPDATE users_tokens SET last_activity = NOW() WHERE token = ? AND is_expire = 0",
    [ssid],
  );
}

async function createSessionRecord(
  connection: DbConnection,
  userId: string,
  clientIp: string,
  userAgent: string,
) {
  const ssid = crypto.randomUUID();
  await queryRows(
    connection,
    `INSERT INTO users_tokens
     (user_id, token, token_type, client_ip, user_agent, issued_in)
     VALUES (?, ?, 'access', ?, ?, NOW())`,
    [userId, ssid, clientIp, userAgent],
  );
  return ssid;
}

export async function createSessionForUser(
  env: Bindings,
  userId: string,
  headers: Headers,
): Promise<string> {
  return withConnection(env, (connection) =>
    createSessionRecord(connection, userId, getClientIp(headers), getUserAgent(headers)),
  );
}

export async function validateSession(env: Bindings, ssid: string): Promise<AuthSession | null> {
  return withConnection(env, async (connection) => {
    const session = await lookupSession(connection, env, ssid);
    if (!session) {
      await expireSession(connection, ssid);
      return null;
    }

    const user = await lookupUser(connection, session.user_id);
    if (!user) {
      return null;
    }

    await touchSession(connection, ssid);
    return { ssid, user };
  });
}

export async function signOutSession(env: Bindings, ssid: string): Promise<boolean> {
  return withConnection(env, async (connection) => {
    const existing = await lookupSession(connection, env, ssid);
    await expireSession(connection, ssid);
    return Boolean(existing);
  });
}

export async function refreshSession(
  env: Bindings,
  currentSsid: string,
  userId: string,
  headers: Headers,
): Promise<string> {
  return withConnection(env, async (connection) => {
    const existing = await lookupSession(connection, env, currentSsid);
    if (!existing) {
      throw new HTTPException(401, { message: "Invalid or expired session" });
    }

    await expireSession(connection, currentSsid);
    return createSessionRecord(connection, userId, getClientIp(headers), getUserAgent(headers));
  });
}

export async function checkNewbieStatus(env: Bindings, userId: string): Promise<boolean> {
  return withConnection(env, async (connection) => {
    const rows = await queryRows<RowDataPacket & { is_newbie_confirmed: number }>(
      connection,
      "SELECT is_newbie_confirmed FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
      [userId],
    );
    const row = rows[0];
    if (!row) {
      throw new HTTPException(404, { message: "User not found" });
    }
    return row.is_newbie_confirmed === 0;
  });
}

export async function confirmNewbieStatus(env: Bindings, userId: string): Promise<boolean> {
  return withConnection(env, async (connection) => {
    const rows = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1",
      [userId],
    );
    if (!rows[0]) {
      throw new HTTPException(404, { message: "User not found" });
    }

    await queryRows(
      connection,
      "UPDATE users SET is_newbie_confirmed = 1 WHERE id = ?",
      [userId],
    );
    return true;
  });
}

export async function verifyLocalUser(
  env: Bindings,
  email: string,
  password: string,
  headers: Headers,
): Promise<AuthSession> {
  return withConnection(env, async (connection) => {
    const rows = await queryRows<UserRow>(
      connection,
      `SELECT id, username, email, password_hash, provider, is_active, is_newbie_confirmed, created_at
       FROM users
       WHERE email = ? AND provider = 'local'
       LIMIT 1`,
      [email],
    );

    const user = rows[0];
    if (!user || !user.is_active || !user.password_hash) {
      throw new HTTPException(401, { message: "Invalid email or password" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw new HTTPException(401, { message: "Invalid email or password" });
    }

    const ssid = await createSessionRecord(connection, user.id, getClientIp(headers), getUserAgent(headers));
    return {
      ssid,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        provider: user.provider,
        is_newbie: !Boolean(user.is_newbie_confirmed),
        created_at: user.created_at,
      },
    };
  });
}

export async function verifySocialUser(
  env: Bindings,
  provider: string,
  socialId: string,
  headers: Headers,
): Promise<AuthSession> {
  if (!isSupportedSocialProvider(provider)) {
    throw new HTTPException(400, { message: "Unsupported social provider" });
  }

  return withConnection(env, async (connection) => {
    const rows = await queryRows<UserRow>(
      connection,
      `SELECT id, username, email, provider, is_active, is_newbie_confirmed, created_at
       FROM users
       WHERE provider = ? AND social_id = ?
       LIMIT 1`,
      [provider, socialId],
    );

    const user = rows[0];
    if (!user || !user.is_active) {
      throw new HTTPException(404, { message: "Social account not found" });
    }

    const ssid = await createSessionRecord(connection, user.id, getClientIp(headers), getUserAgent(headers));
    return {
      ssid,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        provider: user.provider,
        is_newbie: !Boolean(user.is_newbie_confirmed),
        created_at: user.created_at,
      },
    };
  });
}

export async function registerLocalUser(
  env: Bindings,
  username: string,
  email: string,
  password: string,
): Promise<RegisteredUser> {
  return withConnection(env, async (connection) => {
    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    if (existing[0]) {
      throw new HTTPException(400, { message: "Email already exists" });
    }

    const userId = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    await queryRows(
      connection,
      `INSERT INTO users
       (id, username, email, password_hash, provider, social_id, is_active, is_newbie_confirmed)
       VALUES (?, ?, ?, ?, 'local', NULL, 1, 0)`,
      [userId, username, email, passwordHash],
    );

    await initializeDefaultUserData(connection, userId);

    const created = await queryRows<UserRow>(
      connection,
      `SELECT id, username, email, provider, is_active, is_newbie_confirmed, created_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId],
    );
    const user = created[0];
    if (!user) {
      throw new HTTPException(500, { message: "User registration failed" });
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email || email,
      provider: user.provider,
      created_at: user.created_at,
    };
  });
}

export async function registerOtpUser(
  env: Bindings,
  username: string,
  email: string,
): Promise<RegisteredUser> {
  return withConnection(env, async (connection) => {
    const existing = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    if (existing[0]) {
      throw new HTTPException(400, { message: "Email already exists" });
    }

    const userId = crypto.randomUUID();
    await queryRows(
      connection,
      `INSERT INTO users
       (id, username, email, provider, social_id, is_active, is_newbie_confirmed)
       VALUES (?, ?, ?, 'otp', NULL, 1, 0)`,
      [userId, username, email],
    );

    await initializeDefaultUserData(connection, userId);

    const created = await queryRows<UserRow>(
      connection,
      `SELECT id, username, email, provider, is_active, is_newbie_confirmed, created_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId],
    );
    const user = created[0];
    if (!user) {
      throw new HTTPException(500, { message: "OTP user registration failed" });
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email || email,
      provider: user.provider,
      created_at: user.created_at,
    };
  });
}

export async function registerSocialUser(
  env: Bindings,
  provider: string,
  socialId: string,
  username: string,
  email?: string | null,
): Promise<RegisteredUser> {
  if (!isSupportedSocialProvider(provider)) {
    throw new HTTPException(400, { message: "Unsupported social provider" });
  }

  return withConnection(env, async (connection) => {
    const existingSocial = await queryRows<RowDataPacket & { id: string }>(
      connection,
      "SELECT id FROM users WHERE provider = ? AND social_id = ? LIMIT 1",
      [provider, socialId],
    );
    if (existingSocial[0]) {
      throw new HTTPException(400, { message: "Social account already exists" });
    }

    const normalizedEmail = email?.trim().toLowerCase() || null;
    if (normalizedEmail) {
      const existingEmail = await queryRows<RowDataPacket & { id: string }>(
        connection,
        "SELECT id FROM users WHERE email = ? LIMIT 1",
        [normalizedEmail],
      );
      if (existingEmail[0]) {
        throw new HTTPException(400, { message: "Email already exists" });
      }
    }

    const userId = crypto.randomUUID();
    await queryRows(
      connection,
      `INSERT INTO users
       (id, username, email, provider, social_id, is_active, is_newbie_confirmed)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [userId, username, normalizedEmail, provider, socialId],
    );

    await initializeDefaultUserData(connection, userId);

    const created = await queryRows<UserRow>(
      connection,
      `SELECT id, username, email, provider, is_active, is_newbie_confirmed, created_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId],
    );
    const user = created[0];
    if (!user) {
      throw new HTTPException(500, { message: "Social user registration failed" });
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email || normalizedEmail || "",
      provider: user.provider,
      created_at: user.created_at,
    };
  });
}

export async function optionalSessionFromRequest(
  env: Bindings,
  authorizationHeader: string | undefined | null,
): Promise<AuthSession | null> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return null;
  }

  return validateSession(env, token);
}

export async function requireSessionFromRequest(
  env: Bindings,
  authorizationHeader: string | undefined | null,
): Promise<AuthSession> {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    throw new HTTPException(401, { message: "Authorization header is required" });
  }

  const session = await validateSession(env, token);
  if (!session) {
    throw new HTTPException(401, { message: "Invalid or expired session" });
  }

  return session;
}
