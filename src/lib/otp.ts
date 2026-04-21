import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { queryRows, withConnection } from "./db";

interface OtpRecord extends RowDataPacket {
  id: string;
  email: string;
  otp_code: string;
  purpose: "register" | "login";
  is_verified: number;
  is_used: number;
  expires_at: Date;
  created_at: Date;
  verified_at: Date | null;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface EmailProviderRow extends RowDataPacket {
  count: number;
  provider: string;
}

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS_PER_PERIOD = 5;
const RATE_LIMIT_PERIOD_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function generateOtpCode(): string {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < OTP_LENGTH; i += 1) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

async function checkRateLimit(env: Bindings, email: string) {
  const periodAgo = new Date(Date.now() - RATE_LIMIT_PERIOD_MINUTES * 60 * 1000);
  const rows = await withConnection(env, (connection) =>
    queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM otp_codes
       WHERE email = ? AND created_at > ?`,
      [email, periodAgo],
    ),
  );

  if ((rows[0]?.count || 0) >= MAX_ATTEMPTS_PER_PERIOD) {
    throw new HTTPException(429, {
      message: `Too many OTP requests. Please try again after ${RATE_LIMIT_PERIOD_MINUTES} minutes.`,
    });
  }
}

async function checkResendCooldown(env: Bindings, email: string, purpose: "register" | "login") {
  const cooldownTime = new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000);
  const rows = await withConnection(env, (connection) =>
    queryRows<RowDataPacket & { created_at: Date }>(
      connection,
      `SELECT created_at
       FROM otp_codes
       WHERE email = ? AND purpose = ? AND created_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [email, purpose, cooldownTime],
    ),
  );

  if (rows.length > 0) {
    const secondsLeft = Math.ceil(
      (rows[0].created_at.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000,
    );
    throw new HTTPException(429, {
      message: `Please wait ${secondsLeft} seconds before requesting a new code.`,
    });
  }
}

export async function checkEmailExists(env: Bindings, email: string) {
  const rows = await withConnection(env, (connection) =>
    queryRows<EmailProviderRow>(
      connection,
      "SELECT COUNT(*) AS count, provider FROM users WHERE email = ? GROUP BY provider",
      [email],
    ),
  );

  if (rows.length > 0 && rows[0].count > 0) {
    return {
      exists: true,
      provider: rows[0].provider,
    };
  }

  return { exists: false };
}

export async function checkOtpUserExists(env: Bindings, email: string) {
  const rows = await withConnection(env, (connection) =>
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM users WHERE email = ? AND provider = 'otp'",
      [email],
    ),
  );
  return (rows[0]?.count || 0) > 0;
}

export async function getOtpUserByEmail(env: Bindings, email: string) {
  const rows = await withConnection(env, (connection) =>
    queryRows<RowDataPacket & { id: string; username: string; email: string; is_active: number }>(
      connection,
      `SELECT id, username, email, is_active
       FROM users
       WHERE email = ? AND provider = 'otp' AND is_active = 1
       LIMIT 1`,
      [email],
    ),
  );
  return rows[0] || null;
}

export async function createAndStoreOtp(
  env: Bindings,
  options: {
    email: string;
    purpose: "register" | "login";
    ipAddress?: string | null;
    userAgent?: string | null;
  },
) {
  const email = normalizeEmail(options.email);
  await checkRateLimit(env, email);
  await checkResendCooldown(env, email, options.purpose);

  const emailState = await checkEmailExists(env, email);
  if (options.purpose === "register") {
    if (emailState.exists) {
      if (emailState.provider === "otp") {
        throw new HTTPException(400, { message: "Email already registered. Please login instead." });
      }
      throw new HTTPException(400, {
        message: `Email already registered with ${emailState.provider}. Please login with ${emailState.provider} instead.`,
      });
    }
  } else {
    if (!emailState.exists) {
      throw new HTTPException(400, { message: "Email not found. Please register first." });
    }
    if (emailState.provider !== "otp") {
      throw new HTTPException(400, {
        message: `This email is registered with ${emailState.provider}. Please login with ${emailState.provider} instead.`,
      });
    }
  }

  const otpCode = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await withConnection(env, async (connection) => {
    await queryRows(
      connection,
      `UPDATE otp_codes
       SET is_used = TRUE
       WHERE email = ? AND purpose = ? AND is_used = FALSE`,
      [email, options.purpose],
    );

    await queryRows(
      connection,
      `INSERT INTO otp_codes (id, email, otp_code, purpose, expires_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        email,
        otpCode,
        options.purpose,
        expiresAt,
        options.ipAddress || null,
        options.userAgent || null,
      ],
    );
  });

  return {
    success: true,
    expiresAt,
    otpCode,
  };
}

export async function verifyOtpCode(
  env: Bindings,
  options: {
    email: string;
    otpCode: string;
    purpose: "register" | "login";
  },
) {
  const email = normalizeEmail(options.email);

  const verified = await withConnection(env, async (connection) => {
    const rows = await queryRows<OtpRecord>(
      connection,
      `SELECT *
       FROM otp_codes
       WHERE email = ?
         AND otp_code = ?
         AND purpose = ?
         AND is_used = FALSE
         AND is_verified = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [email, options.otpCode, options.purpose],
    );

    const otpRecord = rows[0];
    if (!otpRecord) {
      throw new HTTPException(401, { message: "Invalid or expired verification code" });
    }

    await queryRows(
      connection,
      `UPDATE otp_codes
       SET is_verified = TRUE, verified_at = NOW()
       WHERE id = ?`,
      [otpRecord.id],
    );

    return otpRecord.email;
  });

  return { success: true, email: verified };
}

export async function markOtpAsUsed(
  env: Bindings,
  email: string,
  purpose: "register" | "login",
) {
  await withConnection(env, (connection) =>
    queryRows(
      connection,
      `UPDATE otp_codes
       SET is_used = TRUE
       WHERE email = ? AND purpose = ? AND is_verified = TRUE AND is_used = FALSE`,
      [normalizeEmail(email), purpose],
    ),
  );
}
