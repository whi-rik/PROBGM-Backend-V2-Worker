#!/usr/bin/env bash

set -euo pipefail

LEGACY_BASE_URL="${LEGACY_BASE_URL:-}"
WORKER_BASE_URL="${WORKER_BASE_URL:-}"
COMPARE_EMAIL="${COMPARE_EMAIL:-}"
COMPARE_PASSWORD="${COMPARE_PASSWORD:-}"
COMPARE_WRITE_PREFIX="${COMPARE_WRITE_PREFIX:-compare-write}"
COMPARE_USER_AGENT="${COMPARE_USER_AGENT:-compare-write}"

if [[ -z "${LEGACY_BASE_URL}" || -z "${WORKER_BASE_URL}" ]]; then
  echo "LEGACY_BASE_URL and WORKER_BASE_URL are required" >&2
  exit 1
fi

if [[ -z "${COMPARE_EMAIL}" || -z "${COMPARE_PASSWORD}" ]]; then
  echo "COMPARE_EMAIL and COMPARE_PASSWORD are required" >&2
  exit 1
fi

json_extract() {
  local expression="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const data=JSON.parse(s); const value=(function(){return ${expression};})(); if(value===undefined||value===null){process.exit(2)} if(typeof value==='object'){process.stdout.write(JSON.stringify(value))} else {process.stdout.write(String(value))}})"
}

login() {
  local base_url="$1"
  local payload
  payload="$(printf '{"identifier":"%s","credential":"%s","provider":"local"}' "${COMPARE_EMAIL}" "${COMPARE_PASSWORD}")"
  curl -fsS -A "${COMPARE_USER_AGENT}" -X POST "${base_url}/api/auth/verify" -H 'Content-Type: application/json' -d "${payload}"
}

fetch_json() {
  local base_url="$1"
  local path="$2"
  local token="$3"
  curl -fsS -A "${COMPARE_USER_AGENT}" -H "Authorization: Bearer ${token}" "${base_url}${path}"
}

post_json() {
  local base_url="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  curl -fsS -A "${COMPARE_USER_AGENT}" -X POST "${base_url}${path}" -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' -d "${body}"
}

put_json() {
  local base_url="$1"
  local path="$2"
  local token="$3"
  local body="$4"
  curl -fsS -A "${COMPARE_USER_AGENT}" -X PUT "${base_url}${path}" -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' -d "${body}"
}

echo "== compare write =="
echo "LEGACY_BASE_URL=${LEGACY_BASE_URL}"
echo "WORKER_BASE_URL=${WORKER_BASE_URL}"
echo "COMPARE_EMAIL=${COMPARE_EMAIL}"

LEGACY_LOGIN_JSON="$(login "${LEGACY_BASE_URL}")"
WORKER_LOGIN_JSON="$(login "${WORKER_BASE_URL}")"
LEGACY_SSID="$(printf '%s' "${LEGACY_LOGIN_JSON}" | json_extract 'data.data.ssid')"
WORKER_SSID="$(printf '%s' "${WORKER_LOGIN_JSON}" | json_extract 'data.data.ssid')"

ASSET_JSON="$(curl -fsS -A "${COMPARE_USER_AGENT}" "${WORKER_BASE_URL}/api/v3/assets/list?limit=1&p=0")"
MUSIC_ID="$(printf '%s' "${ASSET_JSON}" | json_extract 'data.data[0].id')"

SUFFIX="$(date +%s)"
LEGACY_TITLE="${COMPARE_WRITE_PREFIX}-legacy-${SUFFIX}"
WORKER_TITLE="${COMPARE_WRITE_PREFIX}-worker-${SUFFIX}"

LEGACY_CREATE="$(post_json "${LEGACY_BASE_URL}" "/api/playlist" "${LEGACY_SSID}" "$(printf '{"title":"%s","description":"legacy create"}' "${LEGACY_TITLE}")")"
WORKER_CREATE="$(post_json "${WORKER_BASE_URL}" "/api/playlist" "${WORKER_SSID}" "$(printf '{"title":"%s","description":"worker create"}' "${WORKER_TITLE}")")"
LEGACY_PLAYLIST_ID="$(printf '%s' "${LEGACY_CREATE}" | json_extract 'data.data.id')"
WORKER_PLAYLIST_ID="$(printf '%s' "${WORKER_CREATE}" | json_extract 'data.data.id')"

echo
echo "== create legacy =="
printf '%s\n' "${LEGACY_CREATE}"
echo
echo "== create worker =="
printf '%s\n' "${WORKER_CREATE}"

LEGACY_ADD="$(post_json "${LEGACY_BASE_URL}" "/api/playlist/add" "${LEGACY_SSID}" "$(printf '{"playlist_id":"%s","music_id":"%s"}' "${LEGACY_PLAYLIST_ID}" "${MUSIC_ID}")")"
WORKER_ADD="$(post_json "${WORKER_BASE_URL}" "/api/playlist/add" "${WORKER_SSID}" "$(printf '{"playlist_id":"%s","music_id":"%s"}' "${WORKER_PLAYLIST_ID}" "${MUSIC_ID}")")"

echo
echo "== add legacy =="
printf '%s\n' "${LEGACY_ADD}"
echo
echo "== add worker =="
printf '%s\n' "${WORKER_ADD}"

LEGACY_UPDATE="$(put_json "${LEGACY_BASE_URL}" "/api/playlist/${LEGACY_PLAYLIST_ID}" "${LEGACY_SSID}" "$(printf '{"title":"%s","description":"legacy updated","is_public":true}' "${LEGACY_TITLE}-updated")")"
WORKER_UPDATE="$(put_json "${WORKER_BASE_URL}" "/api/playlist/${WORKER_PLAYLIST_ID}" "${WORKER_SSID}" "$(printf '{"title":"%s","description":"worker updated","is_public":true}' "${WORKER_TITLE}-updated")")"

echo
echo "== update legacy =="
printf '%s\n' "${LEGACY_UPDATE}"
echo
echo "== update worker =="
printf '%s\n' "${WORKER_UPDATE}"

LEGACY_CROSS_READ="$(fetch_json "${WORKER_BASE_URL}" "/api/playlist/${LEGACY_PLAYLIST_ID}" "${WORKER_SSID}")"
WORKER_CROSS_READ="$(fetch_json "${LEGACY_BASE_URL}" "/api/playlist/${WORKER_PLAYLIST_ID}" "${LEGACY_SSID}")"

echo
echo "== cross-read legacy-created from worker =="
printf '%s\n' "${LEGACY_CROSS_READ}"
echo
echo "== cross-read worker-created from legacy =="
printf '%s\n' "${WORKER_CROSS_READ}"

echo
echo "compare write finished"
