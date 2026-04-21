#!/usr/bin/env node

const LEGACY_BASE_URL = process.env.LEGACY_BASE_URL || "";
const WORKER_BASE_URL = process.env.WORKER_BASE_URL || "";
const AUTH_TOKEN = process.env.COMPARE_AUTH_TOKEN || "";
const ADMIN_TOKEN = process.env.COMPARE_ADMIN_TOKEN || "";
const PLAYLIST_ID = process.env.COMPARE_PLAYLIST_ID || "";
const PAYMENT_KEY = process.env.COMPARE_PAYMENT_KEY || "";
const USER_AGENT = process.env.COMPARE_USER_AGENT || "";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage:
  LEGACY_BASE_URL=https://legacy.example.com \\
  WORKER_BASE_URL=https://worker.example.com \\
  COMPARE_AUTH_TOKEN=<ssid> \\
  node ./scripts/compare-contract.mjs

Optional env:
  COMPARE_ADMIN_TOKEN=<admin ssid>
  COMPARE_PLAYLIST_ID=<playlist id>
  COMPARE_PAYMENT_KEY=<payment key>
`);
  process.exit(0);
}

if (!LEGACY_BASE_URL || !WORKER_BASE_URL) {
  console.error("LEGACY_BASE_URL and WORKER_BASE_URL are required");
  process.exit(1);
}

function trimSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const legacyBase = trimSlash(LEGACY_BASE_URL);
const workerBase = trimSlash(WORKER_BASE_URL);

function buildHeaders(scope) {
  const headers = { Accept: "application/json" };
  if (USER_AGENT) {
    headers["User-Agent"] = USER_AGENT;
  }
  if (scope === "auth" && AUTH_TOKEN) {
    headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  }
  if (scope === "admin" && ADMIN_TOKEN) {
    headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  }
  return headers;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeShape(value, depth = 0) {
  if (depth > 4) {
    return "<max-depth>";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [];
    }
    return [summarizeShape(value[0], depth + 1)];
  }
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = summarizeShape(value[key], depth + 1);
    }
    return out;
  }
  return typeof value;
}

function diffShape(a, b, path = "$") {
  const diffs = [];

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  const aIsObject = isObject(a);
  const bIsObject = isObject(b);

  if (typeof a !== typeof b || aIsArray !== bIsArray || aIsObject !== bIsObject) {
    diffs.push(`${path}: type mismatch (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);
    return diffs;
  }

  if (aIsArray && bIsArray) {
    if (a.length === 0 || b.length === 0) {
      if (a.length !== b.length) {
        diffs.push(`${path}: array emptiness differs (${a.length} vs ${b.length})`);
      }
      return diffs;
    }
    return diffShape(a[0], b[0], `${path}[0]`);
  }

  if (aIsObject && bIsObject) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of [...keys].sort()) {
      if (!(key in a)) {
        diffs.push(`${path}.${key}: missing in legacy`);
        continue;
      }
      if (!(key in b)) {
        diffs.push(`${path}.${key}: missing in worker`);
        continue;
      }
      diffs.push(...diffShape(a[key], b[key], `${path}.${key}`));
    }
    return diffs;
  }

  return diffs;
}

async function fetchJson(base, spec) {
  const url = `${base}${spec.path}`;
  const init = {
    method: spec.method || "GET",
    headers: {
      ...buildHeaders(spec.scope),
      ...(spec.body ? { "Content-Type": "application/json" } : {}),
    },
    body: spec.body ? JSON.stringify(spec.body) : undefined,
  };

  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { __nonJson: text };
  }

  return {
    url,
    status: response.status,
    json,
  };
}

const endpointSpecs = [
  { name: "public playlists", path: "/api/playlists/public?page=1&limit=5", scope: "public" },
  { name: "discovery assets", path: "/api/v3/assets/list?limit=5&p=0", scope: "public" },
  { name: "discovery tags", path: "/api/v3/tags", scope: "public" },
  { name: "promotion stats", path: "/api/promotion/stats", scope: "public" },
  ...(AUTH_TOKEN
    ? [
        { name: "auth me", path: "/api/auth/me", scope: "auth" },
        { name: "download list", path: "/api/download/list?page=1&limit=5", scope: "auth" },
        { name: "payment history", path: "/api/payments/user/history?page=1&limit=5", scope: "auth" },
        { name: "billing cycles", path: "/api/billing/user/cycles?page=1&limit=5", scope: "auth" },
      ]
    : []),
  ...(AUTH_TOKEN && PLAYLIST_ID
    ? [
        { name: "playlist detail", path: `/api/playlist/${encodeURIComponent(PLAYLIST_ID)}`, scope: "auth" },
        {
          name: "playlist musics",
          path: `/api/playlist/${encodeURIComponent(PLAYLIST_ID)}/musics?page=1&limit=5`,
          scope: "auth",
        },
      ]
    : []),
  ...(AUTH_TOKEN && PAYMENT_KEY
    ? [
        {
          name: "payment detail",
          path: `/api/payments/${encodeURIComponent(PAYMENT_KEY)}`,
          scope: "auth",
        },
        {
          name: "payment cancellations",
          path: `/api/payments/${encodeURIComponent(PAYMENT_KEY)}/cancellations`,
          scope: "auth",
        },
      ]
    : []),
  ...(ADMIN_TOKEN
    ? [
        { name: "admin promotions", path: "/api/admin/promotions?page=1&limit=5", scope: "admin" },
        { name: "admin failed payments", path: "/api/admin/payments/failed?page=1&limit=5", scope: "admin" },
      ]
    : []),
];

let failures = 0;

for (const spec of endpointSpecs) {
  console.log(`\n== ${spec.name} ==`);
  try {
    const [legacy, worker] = await Promise.all([
      fetchJson(legacyBase, spec),
      fetchJson(workerBase, spec),
    ]);

    console.log(`legacy status: ${legacy.status} ${legacy.url}`);
    console.log(`worker status: ${worker.status} ${worker.url}`);

    if (legacy.status !== worker.status) {
      failures += 1;
      console.log("status mismatch");
    }

    const legacyMessage = legacy.json?.message;
    const workerMessage = worker.json?.message;
    if (legacyMessage !== workerMessage) {
      failures += 1;
      console.log(`message mismatch:\n  legacy=${JSON.stringify(legacyMessage)}\n  worker=${JSON.stringify(workerMessage)}`);
    }

    const legacyShape = summarizeShape(legacy.json);
    const workerShape = summarizeShape(worker.json);
    const shapeDiffs = diffShape(legacyShape, workerShape);
    if (shapeDiffs.length > 0) {
      failures += 1;
      console.log("shape diff:");
      for (const line of shapeDiffs.slice(0, 30)) {
        console.log(`  - ${line}`);
      }
      if (shapeDiffs.length > 30) {
        console.log(`  ... ${shapeDiffs.length - 30} more`);
      }
    } else {
      console.log("shape: ok");
    }
  } catch (error) {
    failures += 1;
    console.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(`\ncontract compare finished with ${failures} mismatch group(s)`);
  process.exit(1);
}

console.log("\ncontract compare finished without detected mismatches");
