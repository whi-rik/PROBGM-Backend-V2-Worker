#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-}"
SMOKE_ADMIN_EMAIL="${SMOKE_ADMIN_EMAIL:-}"
SMOKE_ADMIN_PASSWORD="${SMOKE_ADMIN_PASSWORD:-}"
SMOKE_EXPECT_WEBHOOK_AUDIT="${SMOKE_EXPECT_WEBHOOK_AUDIT:-0}"
SMOKE_PROMOTION_CODE="${SMOKE_PROMOTION_CODE:-}"

if [[ -z "${BASE_URL}" ]]; then
  echo "BASE_URL is required" >&2
  exit 1
fi

if [[ -z "${SMOKE_ADMIN_EMAIL}" || -z "${SMOKE_ADMIN_PASSWORD}" ]]; then
  echo "SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD are required" >&2
  exit 1
fi

assert_contains() {
  local body="$1"
  local expected="$2"
  local label="$3"
  if [[ "${body}" != *"${expected}"* ]]; then
    echo "Admin smoke failed: ${label} did not include ${expected}" >&2
    exit 1
  fi
}

fetch_json() {
  local path="$1"
  local token="$2"
  curl -fsS -H "Authorization: Bearer ${token}" "${BASE_URL}${path}"
}

login_payload="$(printf '{"identifier":"%s","credential":"%s","provider":"local"}' "${SMOKE_ADMIN_EMAIL}" "${SMOKE_ADMIN_PASSWORD}")"
login_json="$(curl -fsS -X POST "${BASE_URL}/api/auth/verify" -H 'Content-Type: application/json' -d "${login_payload}")"
assert_contains "${login_json}" "\"ssid\"" "api/auth/verify"

SSID="$(printf '%s' "${login_json}" | sed -n 's/.*"ssid":"\([^"]*\)".*/\1/p')"
if [[ -z "${SSID}" ]]; then
  echo "Admin smoke failed: could not extract ssid" >&2
  exit 1
fi

echo "== admin smoke =="
echo "BASE_URL=${BASE_URL}"
echo "authenticated as ${SMOKE_ADMIN_EMAIL}"

dashboard_json="$(fetch_json "/api/admin/dashboard" "${SSID}")"
assert_contains "${dashboard_json}" "\"success\":true" "api/admin/dashboard"

promotions_json="$(fetch_json "/api/admin/promotions" "${SSID}")"
assert_contains "${promotions_json}" "\"success\":true" "api/admin/promotions"

promotion_stats_json="$(fetch_json "/api/promotion/stats" "${SSID}")"
assert_contains "${promotion_stats_json}" "\"success\":true" "api/promotion/stats"

failed_json="$(fetch_json "/api/admin/payments/failed" "${SSID}")"
assert_contains "${failed_json}" "\"success\":true" "api/admin/payments/failed"

cancellations_json="$(fetch_json "/api/admin/payments/cancellations" "${SSID}")"
assert_contains "${cancellations_json}" "\"success\":true" "api/admin/payments/cancellations"

cancellations_stats_json="$(fetch_json "/api/admin/payments/cancellations/stats" "${SSID}")"
assert_contains "${cancellations_stats_json}" "\"success\":true" "api/admin/payments/cancellations/stats"

if [[ -n "${SMOKE_PROMOTION_CODE}" ]]; then
  promotion_usage_json="$(fetch_json "/api/promotion/usage/${SMOKE_PROMOTION_CODE}" "${SSID}")"
  assert_contains "${promotion_usage_json}" "\"success\":true" "api/promotion/usage/:code"
fi

if [[ "${SMOKE_EXPECT_WEBHOOK_AUDIT}" == "1" ]]; then
  webhook_audit_json="$(fetch_json "/api/admin/payments/webhook-audit" "${SSID}")"
  assert_contains "${webhook_audit_json}" "\"success\":true" "api/admin/payments/webhook-audit"

  webhook_audit_stats_json="$(fetch_json "/api/admin/payments/webhook-audit/stats" "${SSID}")"
  assert_contains "${webhook_audit_stats_json}" "\"success\":true" "api/admin/payments/webhook-audit/stats"
fi

echo "admin smoke passed"
