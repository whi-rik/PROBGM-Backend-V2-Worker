#!/usr/bin/env bash

set -euo pipefail

BASE_URL="${BASE_URL:-}"
SMOKE_EMAIL="${SMOKE_EMAIL:-}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-}"
SMOKE_WRITE_PREFIX="${SMOKE_WRITE_PREFIX:-write-smoke}"
SMOKE_PAYMENT_CONFIRM_BODY_FILE="${SMOKE_PAYMENT_CONFIRM_BODY_FILE:-}"
SMOKE_BILLING_ISSUE_KEY_BODY_FILE="${SMOKE_BILLING_ISSUE_KEY_BODY_FILE:-}"
SMOKE_BILLING_CREATE_BODY_FILE="${SMOKE_BILLING_CREATE_BODY_FILE:-}"

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
    echo "Write smoke failed: ${label} did not include ${expected}" >&2
    echo "${body}" >&2
    exit 1
  fi
}

json_extract() {
  local expression="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const data=JSON.parse(s); const value=(function(){return ${expression};})(); if(value===undefined||value===null){process.exit(2)} if(typeof value==='object'){process.stdout.write(JSON.stringify(value))} else {process.stdout.write(String(value))}})"
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

put_json() {
  local path="$1"
  local token="$2"
  local body="$3"
  curl -fsS -X PUT "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    -d "${body}"
}

delete_json() {
  local path="$1"
  local token="$2"
  curl -fsS -X DELETE "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${token}"
}

post_json_file() {
  local path="$1"
  local token="$2"
  local file="$3"
  curl -fsS -X POST "${BASE_URL}${path}" \
    -H "Authorization: Bearer ${token}" \
    -H 'Content-Type: application/json' \
    --data-binary "@${file}"
}

login_payload="$(printf '{"identifier":"%s","credential":"%s","provider":"local"}' "${SMOKE_EMAIL}" "${SMOKE_PASSWORD}")"
login_json="$(curl -fsS -X POST "${BASE_URL}/api/auth/verify" -H 'Content-Type: application/json' -d "${login_payload}")"
assert_contains "${login_json}" "\"ssid\"" "api/auth/verify"

SSID="$(printf '%s' "${login_json}" | json_extract 'data.data.ssid')"
if [[ -z "${SSID}" ]]; then
  echo "Write smoke failed: could not extract ssid" >&2
  exit 1
fi

echo "== write smoke =="
echo "BASE_URL=${BASE_URL}"
echo "authenticated as ${SMOKE_EMAIL}"

me_json="$(fetch_json "/api/auth/me" "${SSID}")"
assert_contains "${me_json}" "\"success\":true" "api/auth/me"
ORIGINAL_USERNAME="$(printf '%s' "${me_json}" | json_extract 'data.data.username')"
if [[ -z "${ORIGINAL_USERNAME}" ]]; then
  echo "Write smoke failed: could not extract original username" >&2
  exit 1
fi

asset_list_json="$(curl -fsS "${BASE_URL}/api/v3/assets/list?limit=1&p=0")"
assert_contains "${asset_list_json}" "\"success\":true" "api/v3/assets/list"
MUSIC_ID="$(printf '%s' "${asset_list_json}" | json_extract 'data.data[0].id')"
if [[ -z "${MUSIC_ID}" ]]; then
  echo "Write smoke failed: could not extract music id" >&2
  exit 1
fi

UNIQUE_SUFFIX="$(date +%s)"
PLAYLIST_TITLE="${SMOKE_WRITE_PREFIX}-playlist-${UNIQUE_SUFFIX}"
PLAYLIST_TITLE_UPDATED="${PLAYLIST_TITLE}-updated"
PLAYLIST_DESC="${SMOKE_WRITE_PREFIX}-desc"
USERNAME_UPDATED="${SMOKE_WRITE_PREFIX}-user-${UNIQUE_SUFFIX}"

create_payload="$(printf '{"title":"%s","description":"%s"}' "${PLAYLIST_TITLE}" "${PLAYLIST_DESC}")"
create_json="$(post_json "/api/playlist" "${SSID}" "${create_payload}")"
assert_contains "${create_json}" "\"success\":true" "api/playlist create"
PLAYLIST_ID="$(printf '%s' "${create_json}" | json_extract 'data.data.id')"
if [[ -z "${PLAYLIST_ID}" ]]; then
  echo "Write smoke failed: could not extract created playlist id" >&2
  exit 1
fi

add_payload="$(printf '{"playlist_id":"%s","music_id":"%s"}' "${PLAYLIST_ID}" "${MUSIC_ID}")"
add_json="$(post_json "/api/playlist/add" "${SSID}" "${add_payload}")"
assert_contains "${add_json}" "\"success\":true" "api/playlist/add"

update_payload="$(printf '{"title":"%s","description":"%s","is_public":true}' "${PLAYLIST_TITLE_UPDATED}" "${PLAYLIST_DESC}")"
update_json="$(put_json "/api/playlist/${PLAYLIST_ID}" "${SSID}" "${update_payload}")"
assert_contains "${update_json}" "\"success\":true" "api/playlist/:id update"

favorite_json="$(post_json "/api/playlist/${PLAYLIST_ID}/favorite" "${SSID}" '{}')"
assert_contains "${favorite_json}" "\"success\":true" "api/playlist/:id/favorite"

detail_json="$(fetch_json "/api/playlist/${PLAYLIST_ID}" "${SSID}")"
assert_contains "${detail_json}" "\"${PLAYLIST_TITLE_UPDATED}\"" "api/playlist/:id detail title"
assert_contains "${detail_json}" "\"is_public\":true" "api/playlist/:id detail public flag"

remove_json="$(post_json "/api/playlist/remove" "${SSID}" "${add_payload}")"
assert_contains "${remove_json}" "\"success\":true" "api/playlist/remove"

remove_detail_json="$(fetch_json "/api/playlist/${PLAYLIST_ID}/musics?page=1&limit=10" "${SSID}")"
assert_contains "${remove_detail_json}" "\"success\":true" "api/playlist/:id/musics after remove"

username_payload="$(printf '{"username":"%s"}' "${USERNAME_UPDATED}")"
username_update_json="$(put_json "/api/user/username" "${SSID}" "${username_payload}")"
assert_contains "${username_update_json}" "\"success\":true" "api/user/username update"

username_me_json="$(fetch_json "/api/auth/me" "${SSID}")"
assert_contains "${username_me_json}" "\"${USERNAME_UPDATED}\"" "api/auth/me updated username"

restore_payload="$(printf '{"username":"%s"}' "${ORIGINAL_USERNAME}")"
restore_json="$(put_json "/api/user/username" "${SSID}" "${restore_payload}")"
assert_contains "${restore_json}" "\"success\":true" "api/user/username restore"

confirm_validation_json="$(curl -sS -X POST "${BASE_URL}/api/payments/confirm" -H "Authorization: Bearer ${SSID}" -H 'Content-Type: application/json' -d '{}')"
assert_contains "${confirm_validation_json}" "\"statusCode\":422" "api/payments/confirm validation status"
assert_contains "${confirm_validation_json}" "\"code\":\"VALIDATION_ERROR\"" "api/payments/confirm validation code"

issue_key_validation_json="$(curl -sS -X POST "${BASE_URL}/api/billing/issue-key" -H "Authorization: Bearer ${SSID}" -H 'Content-Type: application/json' -d '{}')"
assert_contains "${issue_key_validation_json}" "\"statusCode\":422" "api/billing/issue-key validation status"
assert_contains "${issue_key_validation_json}" "\"code\":\"VALIDATION_ERROR\"" "api/billing/issue-key validation code"

if [[ -n "${SMOKE_PAYMENT_CONFIRM_BODY_FILE}" ]]; then
  confirm_json="$(post_json_file "/api/payments/confirm" "${SSID}" "${SMOKE_PAYMENT_CONFIRM_BODY_FILE}")"
  assert_contains "${confirm_json}" "\"success\":true" "api/payments/confirm live"
fi

if [[ -n "${SMOKE_BILLING_ISSUE_KEY_BODY_FILE}" ]]; then
  issue_key_json="$(post_json_file "/api/billing/issue-key" "${SSID}" "${SMOKE_BILLING_ISSUE_KEY_BODY_FILE}")"
  assert_contains "${issue_key_json}" "\"success\":true" "api/billing/issue-key live"
fi

if [[ -n "${SMOKE_BILLING_CREATE_BODY_FILE}" ]]; then
  billing_create_json="$(post_json_file "/api/billing/create" "${SSID}" "${SMOKE_BILLING_CREATE_BODY_FILE}")"
  assert_contains "${billing_create_json}" "\"success\":true" "api/billing/create live"
fi

echo "write smoke passed"
