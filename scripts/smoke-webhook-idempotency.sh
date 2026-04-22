#!/usr/bin/env bash

set -euo pipefail

# Staging smoke for payment webhook idempotency.
#
# Sends the exact same webhook body twice and asserts the second response
# carries idempotent:true. Works only against an environment where
# APP_ENV=development OR TOSS_WEBHOOK_SECRET is set AND we can sign the body.
#
# Required env:
#   BASE_URL          Worker origin
#
# Optional env:
#   TOSS_WEBHOOK_SECRET  If set, the script signs the body with HMAC-SHA256
#                         and attaches x-toss-signature. Required in
#                         staging/production (APP_ENV != development) where
#                         the Worker refuses unsigned webhooks with 503.
#   SMOKE_PAYMENT_KEY    Payment key embedded in the synthetic body.
#                         Defaults to a TEST-IDEMPOTENCY-* key; the Worker
#                         returns "payment_not_found" because no real payment
#                         exists, which is fine — the assertion is on
#                         idempotent:true, not on successful state change.

BASE_URL="${BASE_URL:-}"
TOSS_WEBHOOK_SECRET="${TOSS_WEBHOOK_SECRET:-}"
SMOKE_PAYMENT_KEY="${SMOKE_PAYMENT_KEY:-TEST-IDEMPOTENCY-$(date +%s)-$$}"

if [[ -z "${BASE_URL}" ]]; then
  echo "BASE_URL is required" >&2
  exit 1
fi

WEBHOOK_ID="smoke-${SMOKE_PAYMENT_KEY}"
BODY="$(printf '{"id":"%s","eventType":"PAYMENT_STATUS_CHANGED","data":{"paymentKey":"%s","status":"DONE"}}' "${WEBHOOK_ID}" "${SMOKE_PAYMENT_KEY}")"

echo "== webhook idempotency smoke =="
echo "BASE_URL=${BASE_URL}"
echo "webhook_id=${WEBHOOK_ID}"

build_curl_args() {
  local args=(-sS -X POST "${BASE_URL}/api/payments/webhook" -H 'Content-Type: application/json' -d "${BODY}")
  if [[ -n "${TOSS_WEBHOOK_SECRET}" ]]; then
    local signature
    signature="$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${TOSS_WEBHOOK_SECRET}" -binary | base64)"
    args+=(-H "x-toss-signature: sha256=${signature}")
  fi
  printf '%s\n' "${args[@]}"
}

# Capture both status code and body.
first_response="$(mapfile -t ARGS < <(build_curl_args); curl "${ARGS[@]}" -w '\n%{http_code}')"
first_status="$(printf '%s' "${first_response}" | tail -n1)"
first_body="$(printf '%s' "${first_response}" | sed '$d')"

if [[ "${first_status}" != "200" ]]; then
  echo "Smoke failed: first delivery returned HTTP ${first_status}" >&2
  echo "Response: ${first_body}" >&2
  exit 1
fi

if [[ "${first_body}" == *"\"idempotent\":true"* ]]; then
  echo "Smoke failed: first delivery should not be marked idempotent" >&2
  echo "Body: ${first_body}" >&2
  exit 1
fi

second_response="$(mapfile -t ARGS < <(build_curl_args); curl "${ARGS[@]}" -w '\n%{http_code}')"
second_status="$(printf '%s' "${second_response}" | tail -n1)"
second_body="$(printf '%s' "${second_response}" | sed '$d')"

if [[ "${second_status}" != "200" ]]; then
  echo "Smoke failed: second delivery returned HTTP ${second_status}" >&2
  echo "Response: ${second_body}" >&2
  exit 1
fi

if [[ "${second_body}" != *"\"idempotent\":true"* ]]; then
  echo "Smoke failed: second delivery must carry idempotent:true" >&2
  echo "Body: ${second_body}" >&2
  exit 1
fi

if [[ "${second_body}" != *"\"webhookId\":\"${WEBHOOK_ID}\""* ]]; then
  echo "Smoke failed: second delivery must echo the webhookId we sent" >&2
  echo "Body: ${second_body}" >&2
  exit 1
fi

echo "webhook idempotency smoke passed"
