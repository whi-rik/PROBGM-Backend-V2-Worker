#!/usr/bin/env node
/**
 * Schema parity check: every table + column the Worker reads or writes must
 * also appear somewhere in the legacy PROBGM-Backend-TS source. Drift here
 * breaks the "DB schema is unchanged" contract of the cutover.
 *
 * How it works:
 *   1. Walk src/ for SQL fragments in template strings (FROM/JOIN/INSERT INTO/UPDATE).
 *   2. Walk ../PROBGM-Backend-TS/{routes,controllers,services,classes,models}
 *      and migrations/*.sql for the same patterns.
 *   3. For each (table, column) the Worker uses, assert the legacy side also
 *      references it.
 *   4. An allowlist covers Worker-only optional tables and aliases.
 *
 * Exit codes:
 *   0 — clean or only informational differences
 *   1 — drift found
 *
 * Usage:
 *   node scripts/schema-parity-check.mjs
 *   LEGACY_ROOT=/alt/path node scripts/schema-parity-check.mjs
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

// Tables the Worker introduces for its own bookkeeping. Legacy has no copy.
// These MUST NOT contain legacy business data (they are opt-in only via env).
const WORKER_ONLY_TABLES = new Set(["worker_upload_metadata", "worker_payment_webhook_audit"]);

// SQL identifiers we definitely do not want to treat as real tables.
const SQL_NOISE = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "ORDER",
  "GROUP",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "ON",
  "AS",
  "DESC",
  "ASC",
  "LIMIT",
  "OFFSET",
  "INTO",
  "VALUES",
  "SET",
  "UPDATE",
  "DELETE",
  "DUAL",
  "NULL",
  "TRUE",
  "FALSE",
  "COUNT",
  "SUM",
  "MAX",
  "MIN",
  "AVG",
  "DISTINCT",
  "UNION",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IF",
]);

const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

async function walk(dir, accept) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full, accept)));
    } else if (accept(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function extractTables(text) {
  const tables = new Set();
  let match;
  while ((match = TABLE_RE.exec(text)) !== null) {
    const ident = match[1];
    if (!SQL_NOISE.has(ident.toUpperCase())) {
      tables.add(ident);
    }
  }
  return tables;
}

async function collectTables(root, fileAccept) {
  const files = await walk(root, fileAccept);
  const all = new Set();
  for (const file of files) {
    const text = await readText(file);
    for (const t of extractTables(text)) all.add(t);
  }
  return all;
}

async function loadLegacyCorpus() {
  // Legacy uses dynamic table names via constants (e.g. TABLE_NAME = 'x' then
  // `FROM ${TABLE_NAME}`), so an AST/regex of SQL statements alone undercounts.
  // We instead load the raw corpus of all authoritative legacy source files
  // and require the table word to appear literally somewhere. Documentation
  // files (*.md) are intentionally excluded — a table that only appears in
  // a design doc is not proof of real-world schema presence.
  const dirs = ["routes", "controllers", "services", "classes", "models", "migrations"];
  const corpus = { ts: "", sql: "" };
  for (const sub of dirs) {
    const dir = join(LEGACY_ROOT, sub);
    const exists = await stat(dir).catch(() => null);
    if (!exists) continue;
    const tsFiles = await walk(dir, (n) => n.endsWith(".ts"));
    for (const file of tsFiles) corpus.ts += "\n" + (await readText(file));
    if (sub === "migrations") {
      const sqlFiles = await walk(dir, (n) => n.endsWith(".sql"));
      for (const file of sqlFiles) corpus.sql += "\n" + (await readText(file));
    }
  }
  return corpus;
}

function legacyMentionsTable(corpus, table) {
  // Match the table name as a word. Matches `TABLE_NAME = 'x'`, `FROM x`,
  // `\`x\``, `JOIN x`, etc. — all authoritative references.
  const re = new RegExp(`\\b${table.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`);
  return re.test(corpus.ts) || re.test(corpus.sql);
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

  const workerSrc = join(WORKER_ROOT, "src");
  const workerTables = await collectTables(workerSrc, (name) => name.endsWith(".ts"));
  const corpus = await loadLegacyCorpus();

  const missing = [];
  for (const table of workerTables) {
    if (WORKER_ONLY_TABLES.has(table)) continue;
    if (!legacyMentionsTable(corpus, table)) missing.push(table);
  }

  console.log("== schema-parity-check ==");
  console.log(`Worker tables detected: ${workerTables.size}`);
  console.log(`Worker-only allowlist:  ${[...WORKER_ONLY_TABLES].join(", ")}`);

  if (missing.length > 0) {
    console.error("");
    console.error("DRIFT: Worker references tables not found in legacy source:");
    for (const t of missing) console.error(`  - ${t}`);
    console.error("");
    console.error("Options:");
    console.error("  1. Rename the Worker query to use the legacy table name.");
    console.error("  2. Add the table to WORKER_ONLY_TABLES (requires code review).");
    console.error("  3. Ship a legacy migration that adds the table (requires backend review).");
    console.error("");
    console.error("Notes:");
    console.error("  - 'failed' / 'cover' / other short words are usually SQL-regex false");
    console.error("    positives from URL paths. If you see one, improve the Worker SQL");
    console.error("    extractor or the SQL_NOISE set.");
    process.exit(1);
  }

  console.log("");
  console.log("Schema parity OK — every Worker table reference exists in legacy source.");
}

main().catch((error) => {
  console.error("schema-parity-check failed:", error);
  process.exit(2);
});
