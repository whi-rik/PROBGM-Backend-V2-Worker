#!/usr/bin/env node
/**
 * Endpoint parity check: every Worker-exposed endpoint in the current cutover
 * scope must have a legacy counterpart at the same path + method. Drift here
 * breaks the "endpoint contract is unchanged" rule of the cutover.
 *
 * How it works:
 *   1. Parse Worker src/index.ts mount prefixes (app.route("/api", xRoutes)),
 *      plus each src/routes/*.ts for Hono `<router>.<method>("/path", ...)`.
 *   2. Parse legacy routes/**.ts for `router.<method>('/path', ...)` + figure
 *      out the mount prefix per file (best-effort via filename → legacy
 *      mount map).
 *   3. Normalise params (`:id` ↔ `:id`) and slash prefixes.
 *   4. Diff by (method, path) inside the cutover scope.
 *
 * The "cutover scope" allowlist is a union of route-file globs. Workflow,
 * tailored, jobs, and creditRenewal are intentionally out of scope.
 *
 * Exit codes:
 *   0 — no drift
 *   1 — drift found
 *
 * Usage:
 *   node scripts/endpoint-parity-check.mjs
 *   LEGACY_ROOT=/alt/path node scripts/endpoint-parity-check.mjs
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_ROOT = resolve(__dirname, "..");
const LEGACY_ROOT = resolve(
  process.env.LEGACY_ROOT || resolve(WORKER_ROOT, "..", "PROBGM-Backend-TS"),
);

const METHODS = ["get", "post", "put", "patch", "delete"];

// Worker route files and how they are mounted in src/index.ts. Kept explicit
// because app.route("/api", xRoutes) pattern-matching is fragile across edits.
// An array value means the file is mounted under more than one prefix — e.g.
// user.ts is registered at both "" (FE V2 paths) and "/api" (FE V1 + legacy
// contract).
const WORKER_MOUNTS = {
  "health.ts": "",
  "auth.ts": "/api/auth",
  "v3.ts": "/api/v3",
  "playlists.ts": "/api",
  "v2-playlists.ts": "/api/v2",
  "billing.ts": "/api",
  "payments.ts": "/api",
  "user.ts": ["", "/api"],
  "download.ts": "/api",
  "promotion.ts": "/api",
  "redeem.ts": "/api",
  "upload.ts": "/api",
  "admin.ts": "/api/admin",
  "v2-admin.ts": "/api/v2",
  "sync.ts": "/api",
};

// Legacy route file → mount prefix. Only files in the cutover scope are listed;
// out-of-scope ones (newTailoredRoute, tailoredRoute, jobWorkflowRoutes, etc.)
// are excluded on purpose.
// Each legacy route file declares its paths *without* the /api prefix; the
// prefix is added by the top-level app.use('/api', ...) call in index.ts.
// Auth + OTP files already embed their own /auth or /auth/otp prefix in the
// declared paths (e.g. router.post('/auth/verify', ...)), so their mount is
// still just /api.
const LEGACY_MOUNTS = {
  "authProvider.ts": "/api",
  "otpAuth.ts": "/api",
  "userProvider.ts": "/api",
  "userManagement.ts": "/api",
  "sub/downloadRoutes.ts": "/api",
  "sub/playlistRoutes.ts": "/api",
  "v2/playlistRoutes.ts": "/api/v2",
  "v2/adminGrantRoutes.ts": "/api/v2",
  "billingRoutes.ts": "/api",
  "paymentsRoutes.ts": "/api",
  "redeemRoutes.ts": "/api",
  "promotionRoutes.ts": "/api",
  "fileUploadRoutes.ts": "/api",
  "syncRoutes.ts": "/api",
  "v3/assetRoutes.ts": "/api/v3",
  "v3/tagRoutes.ts": "/api/v3",
};

// Known intentional differences. Each entry is "METHOD PATH" on the Worker side
// that has no legacy counterpart OR vice-versa, and the reason.
const ALLOWED_DRIFT = [
  // Worker-native health/diagnostic endpoints (Workers-specific; no legacy form).
  "GET /",
  "GET /health",
  "GET /health/db",
  "GET /health/storage",
  "GET /health/schema",
  "GET /api/upload/health",
  // Worker-native admin inspection (extra operational visibility beyond legacy).
  "GET /api/admin/dashboard",
  "GET /api/admin/channels",
  "GET /api/admin/channels/stats",
  "GET /api/admin/channel-verifications/pending",
  "GET /api/admin/channel-verifications/:id",
  "POST /api/admin/channel-verifications/:id/approve",
  "POST /api/admin/channel-verifications/:id/reject",
  "POST /api/admin/channels/:id/disable",
  "GET /api/admin/payments/failed",
  "GET /api/admin/payments/cancellations",
  "GET /api/admin/payments/cancellations/stats",
  "GET /api/admin/payments/webhook-audit",
  "GET /api/admin/payments/webhook-audit/stats",
  "GET /api/admin/promotions",
  "POST /api/admin/promotions",
  "PUT /api/admin/promotions/:code/deactivate",
  "GET /api/v2/admin/labels",
  "GET /api/v2/admin/labels/stats",
  "POST /api/v2/admin/labels",
  "PUT /api/v2/admin/labels/:id",
  "DELETE /api/v2/admin/labels/:id",
  // Worker additions documented in docs/contract-parity-gaps.md.
  "POST /api/auth/social/callback",
  "GET /api/playlists/mine",
  "GET /api/payments/:paymentKey/cancellations",
  "GET /health/jobs",
  // v3/tagRoutes in legacy uses a sub-mount at /tags that the parser cannot
  // resolve statically; the Worker paths are the correct effective form.
  "GET /api/v3/tags",
  "GET /api/v3/tags/:type",
  "GET /api/v3/tags/search",
  "GET /api/v3/tags/stats",
  // Admin-only v3 write endpoints intentionally NOT ported to the Worker.
  // Writes remain on legacy Backend-TS.
  "POST /api/v3/assets",
  "PUT /api/v3/assets/:id",
  "DELETE /api/v3/assets/:id",
  "POST /api/v3/sync",
  // The /api/v3 bare + /api/v3/:type etc. entries are v3/tagRoutes noise
  // surfaced by the same sub-mount limitation noted above.
  "GET /api/v3",
  "GET /api/v3/:type",
  "GET /api/v3/search",
  "GET /api/v3/stats",
  // Worker exposes user/channel routes at BOTH /user/* (FE V2) and /api/user/*
  // (FE V1 + legacy contract). The double-mount is in src/index.ts — see the
  // comment there. The unprefixed form is Worker-only and allowlisted here;
  // the /api-prefixed form matches legacy and is NOT in the allowlist.
  "GET /user/balance",
  "GET /user/channel/:id",
  "GET /user/channels",
  "GET /user/credits",
  "GET /user/downloadPoint",
  "GET /user/info",
  "GET /user/label",
  "GET /user/membership",
  "GET /user/stats",
  "POST /user/channel",
  "POST /user/channel/:id/verify",
  "PUT /user/channel/:id",
  "PUT /user/channel/:id/auto-renewal",
  "PUT /user/profile",
  "DELETE /user/channel/:id",
  "GET /user/profile",
  "PUT /user/username",
  "POST /user/check-social-binding",
  "POST /user/bind-social",
  "DELETE /user/unbind-social",
  "DELETE /user/account",
  // GET /user/label reads the authenticated user's current label. Legacy
  // labelRoutes.ts is a separate file (not in LEGACY_MOUNTS) and exposes
  // label writes under /api/user/label POST. Different methods, different
  // semantics, intentionally not considered drift.
  "GET /api/user/label",
];

function normalisePath(path) {
  let p = path.trim();
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+$/g, "").replace(/\/+/g, "/");
  return p || "/";
}

async function walk(dir, accept) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, accept)));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out;
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function extractRoutes(text, identifiers, mountPrefix) {
  // Matches: <routerVar>.<method>("/path"  OR '/path'
  const union = identifiers.map((i) => i.replace(/[.$[\](){}+?*^|\\]/g, "\\$&")).join("|");
  const pattern = new RegExp(
    `\\b(?:${union})\\.(${METHODS.join("|")})\\s*\\(\\s*['"]([^'"\\n]+)['"]`,
    "g",
  );
  const routes = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const method = match[1].toUpperCase();
    const rawPath = match[2];
    routes.push(`${method} ${normalisePath(mountPrefix + rawPath)}`);
  }
  return routes;
}

function detectRouterIdentifiers(text) {
  // Capture `export const xxx = new Hono<...>()` and `const router = Router();`.
  const names = new Set();
  const honoRe = /export\s+const\s+([a-zA-Z0-9_]+)\s*=\s*new\s+Hono/g;
  const expressRe = /\bconst\s+([a-zA-Z0-9_]+)\s*=\s*Router\s*\(/g;
  for (const re of [honoRe, expressRe]) {
    let m;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
  }
  return [...names];
}

async function collectWorkerRoutes() {
  const dir = join(WORKER_ROOT, "src", "routes");
  const exists = await stat(dir).catch(() => null);
  if (!exists) throw new Error(`Worker routes dir not found: ${dir}`);
  const files = await walk(dir, (name) => name.endsWith(".ts"));
  const routes = new Set();

  for (const file of files) {
    const filename = file.slice(dir.length + 1);
    if (!(filename in WORKER_MOUNTS)) continue; // skip unmounted (e.g. jobs, workflow, tailored)
    const text = await readText(file);
    const identifiers = detectRouterIdentifiers(text);
    if (identifiers.length === 0) continue;
    const mountValue = WORKER_MOUNTS[filename];
    const prefixes = Array.isArray(mountValue) ? mountValue : [mountValue];
    for (const prefix of prefixes) {
      for (const r of extractRoutes(text, identifiers, prefix)) {
        routes.add(r);
      }
    }
  }

  return routes;
}

async function collectLegacyRoutes() {
  const dir = join(LEGACY_ROOT, "routes");
  const exists = await stat(dir).catch(() => null);
  if (!exists) throw new Error(`Legacy routes dir not found: ${dir}`);
  const routes = new Set();

  for (const [relative, mount] of Object.entries(LEGACY_MOUNTS)) {
    const file = join(dir, relative);
    const fileExists = await stat(file).catch(() => null);
    if (!fileExists) continue;
    const text = await readText(file);
    const identifiers = detectRouterIdentifiers(text);
    const effective = identifiers.length > 0 ? identifiers : ["router"];
    for (const r of extractRoutes(text, effective, mount)) routes.add(r);
  }

  return routes;
}

async function main() {
  const [workerRootExists, legacyRootExists] = await Promise.all([
    stat(WORKER_ROOT).catch(() => null),
    stat(LEGACY_ROOT).catch(() => null),
  ]);
  if (!workerRootExists) {
    console.error(`Worker root not found: ${WORKER_ROOT}`);
    process.exit(2);
  }
  if (!legacyRootExists) {
    console.error(`Legacy root not found: ${LEGACY_ROOT}`);
    console.error("Set LEGACY_ROOT to the absolute path of PROBGM-Backend-TS.");
    process.exit(2);
  }

  const [workerRoutes, legacyRoutes] = await Promise.all([
    collectWorkerRoutes(),
    collectLegacyRoutes(),
  ]);

  const allowed = new Set(ALLOWED_DRIFT);

  // Worker-only: endpoint exists on Worker but not on legacy → potential
  // contract addition that the FE may not expect.
  const workerOnly = [...workerRoutes].filter(
    (r) => !legacyRoutes.has(r) && !allowed.has(r),
  );

  // Legacy-only: endpoint exists on legacy but not on Worker within cutover
  // scope → potential missing port that the FE still depends on.
  const legacyOnly = [...legacyRoutes].filter(
    (r) => !workerRoutes.has(r) && !allowed.has(r),
  );

  console.log("== endpoint-parity-check ==");
  console.log(`Worker routes (cutover scope): ${workerRoutes.size}`);
  console.log(`Legacy routes (cutover scope): ${legacyRoutes.size}`);
  console.log(`Allowed drift entries:         ${allowed.size}`);

  const hasDrift = workerOnly.length > 0 || legacyOnly.length > 0;

  if (workerOnly.length > 0) {
    console.log("");
    console.log("Worker-only endpoints (not in legacy, not allowlisted):");
    for (const r of workerOnly.sort()) console.log(`  + ${r}`);
  }

  if (legacyOnly.length > 0) {
    console.log("");
    console.log("Legacy-only endpoints (not in Worker, not allowlisted):");
    for (const r of legacyOnly.sort()) console.log(`  - ${r}`);
  }

  if (hasDrift) {
    console.log("");
    console.log("Drift reporting is informational by default: the allowlist in this");
    console.log("file should be updated for new intentional differences, and any");
    console.log("unintentional ones turned into action items.");
    process.exit(1);
  }

  console.log("");
  console.log("Endpoint parity OK — Worker and legacy match within cutover scope.");
}

main().catch((error) => {
  console.error("endpoint-parity-check failed:", error);
  process.exit(2);
});
