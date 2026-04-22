#!/usr/bin/env bash
set -euo pipefail

# Provision an isolated test database for Worker integration tests.
# Reads TEST_DB_* env vars. Safe to re-run (CREATE TABLE IF NOT EXISTS).
#
# Usage:
#   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=23306 \
#   TEST_DB_USER=root TEST_DB_PASS=... TEST_DB_NAME=probgm_test \
#   bash scripts/test-db-setup.sh

TEST_DB_HOST="${TEST_DB_HOST:-127.0.0.1}"
TEST_DB_PORT="${TEST_DB_PORT:-23306}"
TEST_DB_USER="${TEST_DB_USER:?TEST_DB_USER is required}"
TEST_DB_PASS="${TEST_DB_PASS:-}"
TEST_DB_NAME="${TEST_DB_NAME:-probgm_test}"

SCHEMA_FILE="$(cd "$(dirname "$0")/.." && pwd)/tests/integration/_setup/schema.sql"
if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema file not found: $SCHEMA_FILE" >&2
  exit 1
fi

echo "Creating test database $TEST_DB_NAME on $TEST_DB_HOST:$TEST_DB_PORT ..."

mysql_cmd=(mysql -h "$TEST_DB_HOST" -P "$TEST_DB_PORT" -u "$TEST_DB_USER")
if [[ -n "$TEST_DB_PASS" ]]; then
  mysql_cmd+=("-p${TEST_DB_PASS}")
fi

"${mysql_cmd[@]}" -e "CREATE DATABASE IF NOT EXISTS \`$TEST_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
"${mysql_cmd[@]}" "$TEST_DB_NAME" < "$SCHEMA_FILE"

echo "Test database $TEST_DB_NAME ready."
