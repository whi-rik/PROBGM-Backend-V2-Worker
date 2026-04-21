import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../env";
import { requireSessionFromRequest, type AuthSession } from "./auth";

const LEGACY_ADMIN_USER_IDS = [
  "81a93c1e-e767-4300-8ed5-725baad44a01",
  "931160f5-9291-4afe-97ca-ca83a43e8f56",
  "f4ad3c11-7d8d-4a03-93a4-24347821618d",
  "311b60dd-445c-404e-ac05-a6654a1745e7",
];

export function getAdminUserIds(env: Bindings): string[] {
  const configured = (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return Array.from(new Set([...LEGACY_ADMIN_USER_IDS, ...configured]));
}

export function isAdminUserId(env: Bindings, userId: string): boolean {
  return getAdminUserIds(env).includes(userId);
}

export function getAdminDiagnostics(env: Bindings) {
  const configured = (env.ADMIN_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    legacyFallbackCount: LEGACY_ADMIN_USER_IDS.length,
    configuredCount: configured.length,
    totalRecognizedAdmins: getAdminUserIds(env).length,
  };
}

export async function requireAdminSessionFromRequest(
  env: Bindings,
  authorizationHeader: string | undefined | null,
): Promise<AuthSession> {
  const session = await requireSessionFromRequest(env, authorizationHeader);

  if (!isAdminUserId(env, session.user.id)) {
    throw new HTTPException(403, { message: "Admin privileges required" });
  }

  return session;
}
