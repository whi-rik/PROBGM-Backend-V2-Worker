# Contract Compare Runbook

Use this when you want to compare `PROBGM-Backend-TS` and `PROBGM-Backend-V2-Worker` at the HTTP contract level.

## Goal

Check whether legacy and Worker match closely enough in:

- HTTP status
- response `message`
- top-level and nested response shape

This runbook does **not** prove behavioral parity for ranking, side effects, or database contents. It is strictly for request/response contract comparison.

## Required Inputs

- `LEGACY_BASE_URL`
- `WORKER_BASE_URL`

Optional but strongly recommended:

- `COMPARE_AUTH_TOKEN`
- `COMPARE_ADMIN_TOKEN`
- `COMPARE_PLAYLIST_ID`
- `COMPARE_PAYMENT_KEY`
- `COMPARE_USER_AGENT`

## Basic Run

```bash
cd PROBGM-Backend-V2-Worker

LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
npm run compare:contract
```

## Authenticated Run

```bash
cd PROBGM-Backend-V2-Worker

LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
COMPARE_AUTH_TOKEN=<ssid> \
COMPARE_PLAYLIST_ID=<playlist-id> \
COMPARE_PAYMENT_KEY=<payment-key> \
COMPARE_USER_AGENT='contract-compare' \
npm run compare:contract
```

## Admin Run

```bash
cd PROBGM-Backend-V2-Worker

LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
COMPARE_AUTH_TOKEN=<ssid> \
COMPARE_ADMIN_TOKEN=<admin-ssid> \
COMPARE_USER_AGENT='contract-compare' \
npm run compare:contract
```

## User-Agent Note

Legacy backend session verification can invalidate a session when the `User-Agent` changes.

For protected endpoint comparison:

1. issue the `ssid` with a fixed `User-Agent`
2. run `compare:contract` with the same `COMPARE_USER_AGENT`

Example:

```bash
curl -A 'contract-compare' -X POST "$LEGACY_BASE_URL/api/auth/verify" ...

COMPARE_USER_AGENT='contract-compare' \
COMPARE_AUTH_TOKEN="$SSID" \
npm run compare:contract
```

## What The Script Checks

Public:

- `/api/playlists/public?page=1&limit=5`
- `/api/v3/assets/list?limit=5&p=0`
- `/api/v3/tags`
- `/api/promotion/stats`

Authenticated when `COMPARE_AUTH_TOKEN` is set:

- `/api/auth/me`
- `/api/download/list?page=1&limit=5`
- `/api/payments/user/history?page=1&limit=5`
- `/api/billing/user/cycles?page=1&limit=5`

Authenticated + targeted resource ids:

- `/api/playlist/:id`
- `/api/playlist/:id/musics`
- `/api/payments/:paymentKey`
- `/api/payments/:paymentKey/cancellations`

Admin when `COMPARE_ADMIN_TOKEN` is set:

- `/api/admin/promotions?page=1&limit=5`
- `/api/admin/payments/failed?page=1&limit=5`

## How To Read Output

For each endpoint:

- `status mismatch`
- `message mismatch`
- `shape diff`

`shape diff` is based on keys and structural types, not value equality.

Examples:

- `$.data.pagination.totalPages: missing in worker`
- `$.data[0].billing_key: type mismatch ("string" vs "null")`
- `$.message: ...`

## Recommended Triage Order

1. fix HTTP status mismatches
2. fix response `message` mismatches on frontend-critical endpoints
3. fix missing keys or `null` vs omitted field mismatches
4. only after that, inspect deeper behavioral differences

## Frontend-Critical Endpoints

Prioritize these first:

- `/api/auth/me`
- `/api/playlists/public`
- `/api/playlist/:id/musics`
- `/api/payments/user/history`
- `/api/payments/:paymentKey`
- `/api/payments/:paymentKey/cancellations`
- `/api/billing/user/cycles`

## Output Recording

When a mismatch is found:

1. copy the endpoint name
2. copy the mismatch type
3. patch the Worker route or formatter
4. note the change in [contract-parity-gaps.md](./contract-parity-gaps.md)

## Limits

- The script does not compare POST/PUT/DELETE side effects.
- The script does not compare sorting/ranking semantics.
- The script assumes both environments point at compatible data or at least comparable fixtures.
