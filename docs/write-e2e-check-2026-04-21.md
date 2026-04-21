# Write E2E Check 2026-04-21

This note records local write-side E2E checks against:

- legacy: `http://127.0.0.1:23030`
- worker: `http://127.0.0.1:8787`

Both backends were tested against the same local MariaDB and Typesense stack.

## Tested User

A dedicated local user was created in the shared database and logged in through both backends with the same `User-Agent`.

## Verified Side-Effect Flows

### Playlist write flows

Verified with actual write requests and cross-read checks:

- `POST /api/playlist`
- `POST /api/playlist/add`
- `POST /api/playlist/remove`
- `PUT /api/playlist/:id`
- `POST /api/playlist/:id/favorite`

Checks performed:

1. create through legacy
2. create through worker
3. add/remove a real music id through both
4. update title/description/public flag through both
5. set favorite through both
6. read the resulting playlists from the opposite backend

### Account write flow

Verified with actual write + opposite-side read:

- `PUT /api/user/username`

Checks performed:

1. update username through legacy
2. read through worker `GET /api/auth/me`
3. update username through worker
4. read through legacy `GET /api/auth/me`

## Fixes Applied During Write E2E

1. Playlist create HTTP status parity
   - worker changed from `201` to `200`
   - file: [src/routes/playlists.ts](../src/routes/playlists.ts)

2. MySQL datetime parity
   - worker MySQL connection now uses `timezone: 'Z'`
   - this aligned `created_in` / `updated_at` with legacy
   - file: [src/lib/db.ts](../src/lib/db.ts)

3. Validation contract parity
   - `POST /api/payments/confirm` empty body now matches legacy `422 + VALIDATION_ERROR + errors[]`
   - `POST /api/billing/issue-key` empty body now matches legacy `422 + VALIDATION_ERROR`
   - files:
     - [src/routes/payments.ts](../src/routes/payments.ts)
     - [src/routes/billing.ts](../src/routes/billing.ts)
     - [src/index.ts](../src/index.ts)
     - [src/lib/response.ts](../src/lib/response.ts)

## Result

### Fully verified locally

- playlist create/update/add/remove/favorite
- username update

These were verified as actual writes, not just shape comparison.

### Verified at validation-contract level only

- `POST /api/payments/confirm`
- `POST /api/billing/issue-key`

These were checked with empty-body validation requests because real execution requires Toss integration, valid payment data, and billing credentials.

## Remaining Write-Side Work

- real staging write check for:
  - `POST /api/payments/confirm`
  - `DELETE /api/payments/:paymentKey`
  - `POST /api/billing/create`
  - `PUT /api/billing/:id/pause`
  - `PUT /api/billing/:id/resume`
- optional scripted write compare harness for repeatable staging verification
