# Migration Notes

This repo is a first Workers-native extraction from `PROBGM-Backend-TS`.

## What is intentionally ported first

- Stateless health endpoints
- Read-heavy v3 discovery APIs
- Public playlist read APIs
- First-pass SSID session validation
- Session lifecycle helpers
  - check
  - refresh
  - signout/logout
  - newbie check/confirm
- User/account bootstrap flows
  - user info
  - balance
  - membership
  - label
  - stats
  - profile
  - username update
  - social binding check/bind/unbind
  - account delete
- User channel flows
  - list
  - create
  - update
  - auto-renewal toggle
  - delete
  - verification request
- Admin channel verification flows
  - dashboard
  - channel stats
  - channel list
  - pending queue
  - detail lookup
  - approve
  - reject
  - disable
- Download permission flows
  - list
  - prepare download permission
- Promotion validation
  - promotion code lookup/check
  - promotion history
  - promotion stats
  - promotion code usage
  - admin promotion list/create/deactivate
- Local auth entrypoints
  - register
  - verify
  - login
- Social auth entrypoints
  - social verify/register parity via auth routes
  - social callback with optional auto-register
- OTP auth entrypoints
  - check email
  - register request/verify
  - login request/verify
  - resend
  - verify-only
- Owned/access playlist reads
- Core playlist write flows
  - create
  - add music
  - remove music
  - set favorite
  - update
  - soft delete
  - custom title
  - permissions list/grant/revoke
- First-pass v2 playlist flows
  - bulk reorder
  - single-track reorder
  - like toggle
  - liked list
  - popular list
  - category list
  - duplicate
  - cover image metadata
- v2 admin label flows
  - stats
  - list
  - create
  - update
  - delete
- v2 admin grant flows
  - pending list
  - retry single
  - retry all
- Sync/admin operational flows
  - typesense status
  - consistency report
  - incremental sync
  - current-collection full sync
  - sampled consistency fix
  - JSONL export response
- User billing/payment read flows
  - billing cycles list/detail
  - pause/resume/cancel billing cycle
  - payment history
  - payment history with cancellations
  - cancellation history
  - payment detail by payment key
  - cancellation history by payment key
- First-pass Toss write flows
  - issue billing key
  - create billing cycle
  - execute first recurring charge
  - confirm one-time payment
  - cancel payment
  - receive Toss webhook events
  - apply membership state after successful payment
- Payment admin inspection
  - failed payment list
  - cancellation list
  - cancellation stats
  - webhook audit list
  - webhook audit stats
  - date, order, billing, and customer filters for operational triage
- Promotion admin inspection
  - filtered promotion list
  - filtered usage lookup
  - time-window stats

## What is intentionally deferred

- Express middleware parity
- Full auth parity
  - deeper OAuth provider-specific token exchange
- Cron and background monitoring
- Multipart upload via `multer`
- Job/workflow/tailored route families for cutover

## Temporary Worker-specific behavior

- OTP email sending is not wired yet.
- In `APP_ENV=development`, OTP request responses include `otpCode` so local and staging verification can continue without SMTP.

## Runtime decisions

- Hono instead of Express
- `mysql2/promise` request-scoped connections
- Hyperdrive-ready DB config
- Fetch-based Typesense calls
- Plain JSON API helpers
- Worker-native auth extraction instead of Express middleware reuse
- Selectable DB runtime
  - mysql / Hyperdrive remains the safest parity option
  - postgres can now be tested with `DB_PROVIDER=postgres`
  - d1 can now be tested with `DB_PROVIDER=d1`
- Worker-native upload path
  - multipart via `formData()`
  - direct R2 upload via bucket binding
  - optional SQL metadata persistence via `UPLOAD_METADATA_TABLE`

## Current DB portability stance

- `mysql` is still the default and recommended path for parity testing.
- `postgres` and `d1` are now wired at the runtime layer so we can evaluate them without forking the app again.
- Query portability is improved, but not assumed complete until live schema tests pass.
- Choose the provider after testing against the real schema and behavior, not by static preference.

## Provider validation flow

Use the Worker itself to validate the runtime choice before promoting it:

1. `GET /health`
   - confirms selected DB provider and storage binding visibility
2. `GET /health/db`
   - attempts a real DB connection and returns a simple ping result
3. `GET /health/storage`
   - reports whether the R2 binding and public URL are configured
4. `GET /api/upload/health`
   - confirms the Worker-native upload service is ready
5. `GET /health/schema`
   - exposes optional SQL table requirements for upload metadata and webhook audit persistence

Recommended order:

- Start with `mysql` or Hyperdrive for parity.
- Test `postgres` only after schema compatibility and write paths pass.
- Test `d1` only after query portability for the relevant routes is confirmed.

## Constraints carried from the old backend

- Existing MySQL schema is reused
- Existing Typesense collections (`musics`, `tags`) are reused
- Response shapes stay close to the v3 asset/tag endpoints where practical
- Session validation still relies on the existing `users_tokens` table
