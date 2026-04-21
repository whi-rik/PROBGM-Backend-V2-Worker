# E2E Contract Check 2026-04-21

This note records an actual local E2E contract check against:

- legacy: `PROBGM-Backend-TS` via `http://127.0.0.1:23030`
- worker: `PROBGM-Backend-V2-Worker` via `http://127.0.0.1:8787`
- shared MariaDB and Typesense from local Docker

## Setup

- worker started with `.dev.vars` pointing at local MariaDB (`23306`) and Typesense (`28108`)
- contract compare used a fixed `User-Agent` of `contract-compare`
- protected compare used an `ssid` issued by the legacy backend with the same `User-Agent`

## E2E Fixes Applied During Check

1. DB health ping
   - problem: MariaDB rejected alias `current_time`
   - fix: changed DB ping alias to `current_ts`
   - file: [src/lib/db.ts](../src/lib/db.ts)

2. playlist create follow-up read
   - problem: create response id could later resolve to the wrong playlist because the post-insert lookup used `ORDER BY created_in DESC LIMIT 1`
   - fix: generate playlist id first and re-read by inserted id
   - file: [src/routes/playlists.ts](../src/routes/playlists.ts)

3. protected contract compare stability
   - problem: legacy session verification invalidates sessions on `User-Agent` mismatch
   - fix: `compare-contract` now supports `COMPARE_USER_AGENT`
   - file: [scripts/compare-contract.mjs](../scripts/compare-contract.mjs)

4. auth parity
   - `GET /api/auth/me` and `GET /api/auth/isLogged` no longer include extra `created_at`
   - files: [src/routes/auth.ts](../src/routes/auth.ts)

5. legacy auth failure parity
   - protected routes now return legacy-style 401 body for missing/expired session cases
   - files: [src/lib/auth.ts](../src/lib/auth.ts), [src/lib/response.ts](../src/lib/response.ts), [src/index.ts](../src/index.ts)

6. playlist parity
   - public playlist list no longer includes extra flattened `thumbnail` and `cover_image_url`
   - playlist detail now returns legacy-style `musics` array
   - playlist musics now returns legacy-style `keywords[]` and `custom_title`
   - file: [src/routes/playlists.ts](../src/routes/playlists.ts)

## Compared Endpoints

The following endpoints completed without detected status/message/shape mismatches under the test fixture:

- `GET /api/playlists/public?page=1&limit=5`
- `GET /api/v3/assets/list?limit=5&p=0`
- `GET /api/v3/tags`
- `GET /api/promotion/stats`
- `GET /api/auth/me`
- `GET /api/download/list?page=1&limit=5`
- `GET /api/payments/user/history?page=1&limit=5`
- `GET /api/billing/user/cycles?page=1&limit=5`
- `GET /api/playlist/:id`
- `GET /api/playlist/:id/musics?page=1&limit=5`

## Result

Local contract compare finished without detected mismatches for the above endpoint set.

This is not full behavioral parity. It confirms that, for the tested fixture and current compare scope, the Worker matched the legacy backend at:

- HTTP status
- response `message`
- response shape

## Remaining Work

- repeat on staging data with real staging URLs
- expand compare coverage only to routes that exist on both legacy and Worker
- continue checking write-side parity separately from read-side contract compare
