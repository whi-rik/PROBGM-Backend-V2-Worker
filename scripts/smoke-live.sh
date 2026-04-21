#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-}"
SMOKE_EMAIL="${SMOKE_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-}"

if [[ -z "${BASE_URL}" ]]; then
  echo "BASE_URL is required" >&2
  exit 1
fi

if [[ -z "${SMOKE_EMAIL}" || -z "${SMOKE_PASSWORD}" ]]; then
  echo "SMOKE_EMAIL and SMOKE_PASSWORD are required" >&2
  exit 1
fi

assert_contains() {
  local body="$1"
  local expected="$2"
  local label="$3"
  if [[ "${body}" != *"${expected}"* ]]; then
    echo "Smoke failed: ${label} did not include ${expected}" >&2
    exit 1
  fi
}

fetch_json() {
  local path="$1"
  local token="$2"
  curl -fsS -H "Authorization: Bearer ${token}" "${BASE_URL}${path}"
}

login_payload="$(printf '{"identifier":"%s","credential":"%s","provider":"local"}' "${SMOKE_EMAIL}" "${SMOKE_PASSWORD}")"
login_json="$(curl -fsS -X POST "${BASE_URL}/api/auth/verify" -H 'Content-Type: application/json' -d "${login_payload}")"
assert_contains "${login_json}" "\"ssid\"" "api/auth/verify"

SSID="$(printf '%s' "${login_json}" | sed -n 's/.*"ssid":"\([^"]*\)".*/\1/p')"
if [[ -z "${SSID}" ]]; then
  echo "Smoke failed: could not extract ssid" >&2
  exit 1
fi

echo "== live smoke =="
echo "BASE_URL=${BASE_URL}"
echo "authenticated as ${SMOKE_EMAIL}"

me_json="$(fetch_json "/api/auth/me" "${SSID}")"
assert_contains "${me_json}" "\"success\":true" "api/auth/me"

user_json="$(fetch_json "/user/info" "${SSID}")"
assert_contains "${user_json}" "\"success\":true" "user/info"

playlist_json="$(fetch_json "/api/playlists/mine" "${SSID}")"
assert_contains "${playlist_json}" "\"success\":true" "api/playlists/mine"

payment_history_json="$(fetch_json "/api/payments/user/history" "${SSID}")"
assert_contains "${payment_history_json}" "\"success\":true" "api/payments/user/history"

download_list_json="$(fetch_json "/api/download/list" "${SSID}")"
assert_contains "${download_list_json}" "\"success\":true" "api/download/list"

echo "live smoke passed"
