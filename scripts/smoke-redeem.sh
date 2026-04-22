#!/usr/bin/env bash

set -euo pipefail

# Staging smoke for the redeem route family.
#
# Required env:
#   BASE_URL         Worker origin (e.g. https://worker-staging.example.com)
#   SMOKE_EMAIL      Test user email (cannot be a production account)
#   SMOKE_PASSWORD   Test user password
#   SMOKE_REDEEM_CODE  Pre-seeded redeem code. Must be:
#                      - is_active = 1
#                      - max_uses = -1 or unused for this user
#                      - reward_type = combo|membership (download_points-only is fine too)
#                      - NOT yet used by the SMOKE_EMAIL account
#
# This script does NOT create redeem codes — seeding is a DB-side concern and
# must happen outside the Worker surface. Use an admin-authored code in
# staging with predictable reward shape.

BASE_URL="${BASE_URL:-}"
SMOKE_EMAIL="${SMOKE_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-}"
SMOKE_REDEEM_CODE="${SMOKE_REDEEM_CODE:-}"

if [[ -z "${BASE_URL}" ]]; then
  echo "BASE_URL is required" >&2
  exit 1
fi
if [[ -z "${SMOKE_EMAIL}" || -z "${SMOKE_PASSWORD}" ]]; then
  echo "SMOKE_EMAIL and SMOKE_PASSWORD are required" >&2
  exit 1
fi
if [[ -z "${SMOKE_REDEEM_CODE}" ]]; then
  echo "SMOKE_REDEEM_CODE is required (pre-seeded, unused by this user)" >&2
  exit 1
fi

assert_contains() {
  local body="$1"
  local expected="$2"
  local label="$3"
  if [[ "${body}" != *"${expected}"* ]]; then
    echo "Smoke failed: ${label} did not include ${expected}" >&2
    echo "Response was: ${body}" >&2
    exit 1
  fi
}

fetch_json() {
  local path="$1"
  local token="$2"
  curl -fsS -H "Authorization: Bearer ${token}" "${BASE_URL}${path}"
}

post_json() {
  local path="$1"
  local token="$2"
  local body="$3"
  curl -fsS -X POST "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -d "${body}"
}

echo "== redeem smoke =="
echo "BASE_URL=${BASE_URL}"
echo "user=${SMOKE_EMAIL}"
echo "code=${SMOKE_REDEEM_CODE}"

login_payload="$(printf '{"identifier":"%s","credential":"%s","provider":"local"}' "${SMOKE_EMAIL}" "${SMOKE_PASSWORD}")"
login_json="$(curl -fsS -X POST "${BASE_URL}/api/auth/verify" -H 'Content-Type: application/json' -d "${login_payload}")"
assert_contains "${login_json}" "\"ssid\"" "api/auth/verify"

SSID="$(printf '%s' "${login_json}" | sed -n 's/.*"ssid":"\([^"]*\)".*/\1/p')"
if [[ -z "${SSID}" ]]; then
  echo "Smoke failed: could not extract ssid" >&2
  exit 1
fi

# Public check endpoint should return valid=true for the seeded code.
check_json="$(curl -fsS "${BASE_URL}/api/redeem/check/${SMOKE_REDEEM_CODE}")"
assert_contains "${check_json}" "\"valid\":true" "api/redeem/check/:code"

# Snapshot balance BEFORE to verify a delta on combo/credits/download_points codes.
balance_before_json="$(fetch_json "/user/balance" "${SSID}")"
assert_contains "${balance_before_json}" "\"success\":true" "user/balance (pre-redeem)"

redeem_body="$(printf '{"code":"%s"}' "${SMOKE_REDEEM_CODE}")"
redeem_json="$(post_json "/api/redeem" "${SSID}" "${redeem_body}")"
assert_contains "${redeem_json}" "\"success\":true" "api/redeem"
assert_contains "${redeem_json}" "\"rewardType\"" "api/redeem rewardType"
assert_contains "${redeem_json}" "\"codeUsage\"" "api/redeem codeUsage"

history_json="$(fetch_json "/api/redeem/history" "${SSID}")"
assert_contains "${history_json}" "\"success\":true" "api/redeem/history"
assert_contains "${history_json}" "\"${SMOKE_REDEEM_CODE}\"" "api/redeem/history includes the code"

balance_after_json="$(fetch_json "/user/balance" "${SSID}")"
assert_contains "${balance_after_json}" "\"success\":true" "user/balance (post-redeem)"

# Second attempt by the same user must fail with "already used" per legacy contract.
# curl -f would exit on 4xx; use -w to inspect status code without aborting.
second_http_code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/api/redeem" \
  -H "Authorization: Bearer ${SSID}" \
  -H 'Content-Type: application/json' \
  -d "${redeem_body}")"
if [[ "${second_http_code}" != "400" ]]; then
  echo "Smoke failed: second redeem should return 400, got ${second_http_code}" >&2
  exit 1
fi

echo "redeem smoke passed"
