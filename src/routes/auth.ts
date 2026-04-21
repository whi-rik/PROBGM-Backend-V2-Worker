import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../env";
import {
  checkNewbieStatus,
  confirmNewbieStatus,
  createSessionForUser,
  registerLocalUser,
  registerOtpUser,
  registerSocialUser,
  verifyLocalUser,
  verifySocialUser,
  refreshSession,
  requireSessionFromRequest,
  signOutSession,
} from "../lib/auth";
import {
  checkEmailExists,
  checkOtpUserExists,
  createAndStoreOtp,
  getOtpUserByEmail,
  markOtpAsUsed,
  normalizeEmail,
  verifyOtpCode,
} from "../lib/otp";
import { success } from "../lib/response";

export const authRoutes = new Hono<{ Bindings: Bindings }>();

function isSocialProvider(provider: string) {
  return provider === "google" || provider === "facebook" || provider === "kakao";
}

authRoutes.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({} as {
    username?: string;
    email?: string;
    password?: string;
    provider?: string;
  }));

  const provider = body.provider || "local";
  const username = (body.username || "").trim();
  if (provider === "local") {
    if (!body.email || !body.password) {
      throw new HTTPException(400, { message: "email and password are required" });
    }
    if (!username) {
      throw new HTTPException(400, { message: "username is required" });
    }
  } else if (isSocialProvider(provider)) {
    if (!body.social_id || !username) {
      throw new HTTPException(400, { message: "social_id and username are required for social registration" });
    }
  } else {
    throw new HTTPException(400, { message: "Unsupported provider" });
  }

  const user =
    provider === "local"
      ? await registerLocalUser(
          c.env,
          username.slice(0, 50),
          String(body.email).trim().toLowerCase(),
          String(body.password),
        )
      : await registerSocialUser(
          c.env,
          provider,
          String(body.social_id).trim(),
          username.slice(0, 50),
          body.email ? String(body.email).trim().toLowerCase() : null,
        );

  return c.json(success(user, "Registered"), 201);
});

authRoutes.post("/verify", async (c) => {
  const body = await c.req.json().catch(() => ({} as { identifier?: string; credential?: string; provider?: string }));
  if (!body.identifier || !body.provider) {
    throw new HTTPException(400, { message: "identifier and provider are required" });
  }
  let session;
  if (body.provider === "local") {
    if (!body.credential) {
      throw new HTTPException(400, { message: "credential is required for local login" });
    }

    session = await verifyLocalUser(
      c.env,
      String(body.identifier).trim().toLowerCase(),
      String(body.credential),
      c.req.raw.headers,
    );
  } else if (isSocialProvider(body.provider)) {
    session = await verifySocialUser(
      c.env,
      String(body.provider),
      String(body.identifier).trim(),
      c.req.raw.headers,
    );
  } else {
    throw new HTTPException(400, { message: "Unsupported provider" });
  }

  return c.json(
    success({
      id: session.user.id,
      ssid: session.ssid,
      name: session.user.username,
      email: session.user.email || "",
      provider: session.user.provider,
    }),
  );
});

authRoutes.post("/social/callback", async (c) => {
  const body = await c.req.json().catch(
    () =>
      ({} as {
        provider?: string;
        social_id?: string;
        email?: string;
        username?: string;
        autoRegister?: boolean;
      }),
  );

  const provider = String(body.provider || "").trim();
  const socialId = String(body.social_id || "").trim();
  const username = String(body.username || "").trim();
  const email = body.email ? String(body.email).trim().toLowerCase() : null;

  if (!isSocialProvider(provider)) {
    throw new HTTPException(400, { message: "provider must be google, facebook, or kakao" });
  }
  if (!socialId) {
    throw new HTTPException(400, { message: "social_id is required" });
  }

  try {
    const session = await verifySocialUser(c.env, provider, socialId, c.req.raw.headers);
    return c.json(
      success(
        {
          user: {
            id: session.user.id,
            username: session.user.username,
            email: session.user.email,
            provider: session.user.provider,
          },
          ssid: session.ssid,
          registered: false,
        },
        "Social login successful",
      ),
    );
  } catch (error) {
    const shouldAttemptRegister = body.autoRegister !== false;
    const notFound = error instanceof HTTPException && error.status === 404;
    if (!notFound || !shouldAttemptRegister) {
      throw error;
    }

    if (!username) {
      throw new HTTPException(400, { message: "username is required to auto-register a social user" });
    }

    const user = await registerSocialUser(c.env, provider, socialId, username.slice(0, 50), email);
    const ssid = await createSessionForUser(c.env, user.id, c.req.raw.headers);

    return c.json(
      success(
        {
          user: {
            id: user.id,
            username: user.username,
            email: user.email,
            provider: user.provider,
          },
          ssid,
          registered: true,
        },
        "Social registration and login successful",
      ),
      201,
    );
  }
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string; password?: string }));
  if (!body.email || !body.password) {
    throw new HTTPException(400, { message: "email and password are required" });
  }

  const session = await verifyLocalUser(
    c.env,
    String(body.email).trim().toLowerCase(),
    String(body.password),
    c.req.raw.headers,
  );

  return c.json(
    success(
      {
        id: session.user.id,
        username: session.user.username,
        email: session.user.email,
        provider: session.user.provider,
      },
      "Logged in",
    ),
  );
});

authRoutes.get("/me", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  return c.json(
    success({
      id: session.user.id,
      username: session.user.username,
      email: session.user.email,
      provider: session.user.provider,
      is_newbie: session.user.is_newbie,
      created_at: session.user.created_at,
    }),
  );
});

authRoutes.get("/isLogged", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  return c.json(
    success({
      id: session.user.id,
      username: session.user.username,
      email: session.user.email,
      provider: session.user.provider,
      isNewbie: session.user.is_newbie,
      created_at: session.user.created_at,
    }),
  );
});

authRoutes.get("/check", async (c) => {
  await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  return c.json(success({ authenticated: true }, "Authentication checked"));
});

authRoutes.post("/signout", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const ok = await signOutSession(c.env, session.ssid);
  if (!ok) {
    throw new HTTPException(404, { message: "Session not found" });
  }

  return c.json(success({ success: true }, "Signed out"));
});

authRoutes.post("/logout", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const ok = await signOutSession(c.env, session.ssid);
  if (!ok) {
    throw new HTTPException(404, { message: "Session not found" });
  }

  return c.json(success(null, "Signed out"));
});

authRoutes.post("/refresh", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const newSsid = await refreshSession(c.env, session.ssid, session.user.id, c.req.raw.headers);
  return c.json(success({ refreshed: true, ssid: newSsid }, "Session refreshed"));
});

authRoutes.get("/newbie/check", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const isNewbie = await checkNewbieStatus(c.env, session.user.id);
  return c.json(success({ isNewbie, userId: session.user.id }));
});

authRoutes.post("/newbie/confirm", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  await confirmNewbieStatus(c.env, session.user.id);
  return c.json(success({ confirmed: true, userId: session.user.id }, "Newbie confirmed"));
});

authRoutes.post("/otp/check-email", async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string }));
  if (!body.email) {
    throw new HTTPException(400, { message: "email is required" });
  }

  const result = await checkEmailExists(c.env, normalizeEmail(body.email));
  return c.json(
    success({
      available: !result.exists,
      exists: result.exists,
      provider: result.provider,
    }),
  );
});

async function buildOtpRequestResponse(
  c: Context<{ Bindings: Bindings }>,
  purpose: "register" | "login",
) {
  const body = await c.req.json().catch(() => ({} as { email?: string }));
  if (!body.email) {
    throw new HTTPException(400, { message: "email is required" });
  }

  const result = await createAndStoreOtp(c.env, {
    email: normalizeEmail(body.email),
    purpose,
    ipAddress: c.req.header("CF-Connecting-IP") || null,
    userAgent: c.req.header("User-Agent") || null,
  });

  return c.json(
    success(
      {
        expiresAt: result.expiresAt,
        ...(c.env.APP_ENV === "development" ? { otpCode: result.otpCode } : {}),
      },
      "Verification code sent to your email",
    ),
  );
}

authRoutes.post("/otp/register/request", async (c) => buildOtpRequestResponse(c, "register"));
authRoutes.post("/otp/login/request", async (c) => buildOtpRequestResponse(c, "login"));

authRoutes.post("/otp/register/verify", async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string; otpCode?: string; username?: string }));
  if (!body.email || !body.otpCode || !body.username?.trim()) {
    throw new HTTPException(400, { message: "email, otpCode, and username are required" });
  }

  const email = normalizeEmail(body.email);
  await verifyOtpCode(c.env, {
    email,
    otpCode: String(body.otpCode).trim(),
    purpose: "register",
  });

  const exists = await checkOtpUserExists(c.env, email);
  if (exists) {
    throw new HTTPException(400, { message: "Email already registered" });
  }

  const user = await registerOtpUser(c.env, String(body.username).trim().slice(0, 50), email);
  await markOtpAsUsed(c.env, email, "register");
  const ssid = await createSessionForUser(c.env, user.id, c.req.raw.headers);

  return c.json(
    success(
      {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          provider: user.provider,
        },
        ssid,
      },
      "Registration successful",
    ),
  );
});

authRoutes.post("/otp/login/verify", async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string; otpCode?: string }));
  if (!body.email || !body.otpCode) {
    throw new HTTPException(400, { message: "email and otpCode are required" });
  }

  const email = normalizeEmail(body.email);
  await verifyOtpCode(c.env, {
    email,
    otpCode: String(body.otpCode).trim(),
    purpose: "login",
  });

  const user = await getOtpUserByEmail(c.env, email);
  if (!user) {
    throw new HTTPException(401, { message: "User not found or inactive" });
  }

  await markOtpAsUsed(c.env, email, "login");
  const ssid = await createSessionForUser(c.env, user.id, c.req.raw.headers);

  return c.json(
    success(
      {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          provider: "otp",
        },
        ssid,
      },
      "Login successful",
    ),
  );
});

authRoutes.post("/otp/resend", async (c) => {
  const body = await c.req.json().catch(() => ({} as { email?: string; purpose?: "register" | "login" }));
  if (!body.email || !body.purpose || !["register", "login"].includes(body.purpose)) {
    throw new HTTPException(400, { message: "email and valid purpose are required" });
  }

  const result = await createAndStoreOtp(c.env, {
    email: normalizeEmail(body.email),
    purpose: body.purpose,
    ipAddress: c.req.header("CF-Connecting-IP") || null,
    userAgent: c.req.header("User-Agent") || null,
  });

  return c.json(
    success(
      {
        expiresAt: result.expiresAt,
        ...(c.env.APP_ENV === "development" ? { otpCode: result.otpCode } : {}),
      },
      "New verification code sent to your email",
    ),
  );
});

authRoutes.post("/otp/verify", async (c) => {
  const body = await c.req.json().catch(
    () => ({} as { email?: string; otpCode?: string; purpose?: "register" | "login" }),
  );
  if (!body.email || !body.otpCode || !body.purpose || !["register", "login"].includes(body.purpose)) {
    throw new HTTPException(400, { message: "email, otpCode, and valid purpose are required" });
  }

  const result = await verifyOtpCode(c.env, {
    email: normalizeEmail(body.email),
    otpCode: String(body.otpCode).trim(),
    purpose: body.purpose,
  });

  return c.json(success({ verified: true, email: result.email }, "Verification code is valid"));
});
