#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"
SMOKE_EXPECT_PROVIDER="${SMOKE_EXPECT_PROVIDER:-}"
SMOKE_REQUIRE_DB_OK="${SMOKE_REQUIRE_DB_OK:-0}"
AUTH_HEADER=()

if [[ -n "${SMOKE_AUTH_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${SMOKE_AUTH_TOKEN}")
fi

fetch_json() {
  local path="$1"
  curl -fsS "${AUTH_HEADER[@]}" "${BASE_URL}${path}"
}

assert_contains() {
  local body="$1"
  local expected="$2"
  local label="$3"
  if [[ "${body}" != *"${expected}"* ]]; then
    echo "Smoke failed: ${label} did not include ${expected}" >&2
    exit 1
  fi
}

echo "== provider smoke =="
echo "BASE_URL=${BASE_URL}"

root_json="$(fetch_json "/")"
assert_contains "${root_json}" "\"service\"" "root"

health_json="$(fetch_json "/health")"
assert_contains "${health_json}" "\"runtime\"" "health"

db_json="$(fetch_json "/health/db")"
assert_contains "${db_json}" "\"selectedProvider\"" "health/db"

if [[ -n "${SMOKE_EXPECT_PROVIDER}" ]]; then
  assert_contains "${db_json}" "\"selectedProvider\":\"${SMOKE_EXPECT_PROVIDER}\"" "health/db selectedProvider"
fi

if [[ "${SMOKE_REQUIRE_DB_OK}" == "1" ]]; then
  assert_contains "${db_json}" "\"ok\":true" "health/db connection"
fi

schema_json="$(fetch_json "/health/schema")"
assert_contains "${schema_json}" "\"optionalTables\"" "health/schema"

storage_json="$(fetch_json "/health/storage")"
assert_contains "${storage_json}" "\"provider\":\"r2\"" "health/storage"

upload_json="$(fetch_json "/api/upload/health")"
assert_contains "${upload_json}" "\"provider\":\"r2\"" "api/upload/health"

if [[ -n "${SMOKE_AUTH_TOKEN:-}" ]]; then
  profile_json="$(fetch_json "/api/auth/me")"
  assert_contains "${profile_json}" "\"success\":true" "api/auth/me"
fi

echo "provider smoke passed"
