# PROBGM-Backend-V2-Worker

Hono-based Cloudflare Worker backend prototype for migrating `PROBGM-Backend-TS` to Workers.

Current migration slice:

- `GET /`
- `GET /health`
- `GET /health/db`
- `GET /health/storage`
- `GET /health/schema`
- `POST /api/auth/register`
- `POST /api/auth/verify`
- `POST /api/auth/login`
- `POST /api/auth/social/callback`
- `GET /api/auth/me`
- `GET /api/auth/isLogged`
- `GET /api/auth/check`
- `POST /api/auth/signout`
- `POST /api/auth/logout`
- `POST /api/auth/refresh`
- `GET /api/auth/newbie/check`
- `POST /api/auth/newbie/confirm`
- `POST /api/auth/otp/check-email`
- `POST /api/auth/otp/register/request`
- `POST /api/auth/otp/register/verify`
- `POST /api/auth/otp/login/request`
- `POST /api/auth/otp/login/verify`
- `POST /api/auth/otp/resend`
- `POST /api/auth/otp/verify`
- `GET /api/v3/tags`
- `GET /api/v3/tags/stats`
- `GET /api/v3/tags/search`
- `GET /api/v3/tags/:type`
- `GET /api/v3/assets/list`
- `GET /api/v3/assets/search`
- `GET /api/v3/assets/:id`
- `GET /user/info`
- `GET /user/balance`
- `GET /user/membership`
- `GET /user/label`
- `GET /user/stats`
- `GET /user/channels`
- `POST /user/channel`
- `PUT /user/channel/:id`
- `PUT /user/channel/:id/auto-renewal`
- `DELETE /user/channel/:id`
- `POST /user/channel/:id/verify`
- `GET /api/admin/dashboard`
- `GET /api/admin/channels/stats`
- `GET /api/admin/channels`
- `GET /api/admin/channel-verifications/pending`
- `GET /api/admin/channel-verifications/:id`
- `POST /api/admin/channel-verifications/:id/approve`
- `POST /api/admin/channel-verifications/:id/reject`
- `POST /api/admin/channels/:id/disable`
- `GET /api/user/profile`
- `PUT /api/user/username`
- `POST /api/user/check-social-binding`
- `POST /api/user/bind-social`
- `DELETE /api/user/unbind-social`
- `DELETE /api/user/account`
- `GET /api/download/list`
- `GET /api/download/:id`
- `GET /api/promotion/check/:code`
- `GET /api/promotion/history`
- `GET /api/promotion/stats`
- `GET /api/promotion/usage/:code`
- `GET /api/admin/promotions`
- `POST /api/admin/promotions`
- `PUT /api/admin/promotions/:code/deactivate`
- `GET /api/sync/typesense/status`
- `GET /api/sync/typesense/consistency`
- `POST /api/sync/typesense/incremental`
- `POST /api/sync/typesense/full`
- `POST /api/sync/typesense/fix`
- `GET /api/sync/typesense/export`
- `POST /api/upload`
- `GET /api/upload/health`
- `GET /api/playlists`
- `GET /api/playlists/public`
- `GET /api/playlists/mine`
- `GET /api/playlists/accessible`
- `GET /api/favoriteId`
- `POST /api/playlist`
- `POST /api/playlist/add`
- `POST /api/playlist/remove`
- `POST /api/playlist/:id/favorite`
- `PUT /api/playlist/:id`
- `DELETE /api/playlist/:id`
- `PUT /api/playlist/:id/music/:musicId/custom-title`
- `GET /api/playlist/:id/permissions`
- `POST /api/playlist/:id/permissions`
- `DELETE /api/playlist/:id/permissions`
- `GET /api/playlist/:id`
- `GET /api/playlist/:id/musics`
- `PUT /api/v2/playlist/:id/cover`
- `PUT /api/v2/playlist/:id/reorder`
- `PATCH /api/v2/playlist/:id/music/:musicId/order`
- `POST /api/v2/playlist/:id/like`
- `GET /api/v2/playlists/liked`
- `GET /api/v2/playlists/popular`
- `GET /api/v2/playlists/category/:category`
- `POST /api/v2/playlist/:id/duplicate`
- `GET /api/v2/admin/labels/stats`
- `GET /api/v2/admin/labels`
- `POST /api/v2/admin/labels`
- `PUT /api/v2/admin/labels/:id`
- `DELETE /api/v2/admin/labels/:id`
- `GET /api/v2/admin/grants/pending`
- `POST /api/v2/admin/grants/:id/retry`
- `POST /api/v2/admin/grants/retry-all`
- `GET /api/billing/user/cycles`
- `GET /api/billing/:id`
- `POST /api/billing/issue-key`
- `POST /api/billing/create`
- `PUT /api/billing/:id/pause`
- `PUT /api/billing/:id/resume`
- `DELETE /api/billing/:id`
- `GET /api/payments/user/history`
- `GET /api/payments/user/history-with-cancellations`
- `GET /api/payments/user/cancellations`
- `GET /api/payments/:paymentKey`
- `GET /api/payments/:paymentKey/cancellations`
- `POST /api/payments/confirm`
- `DELETE /api/payments/:paymentKey`
- `POST /api/payments/webhook`
- `GET /api/admin/payments/failed`
- `GET /api/admin/payments/cancellations`
- `GET /api/admin/payments/cancellations/stats`
- `GET /api/admin/payments/webhook-audit`
- `GET /api/admin/payments/webhook-audit/stats`

Admin payment inspection filters:
- `createdFrom`
- `createdTo`
- `userId` on failed payments
- `orderId` on failed payments
- `method` on failed payments
- `billingOnly=true` on failed payments
- `requestedBy`, `cancellationType` on cancellation endpoints
- `status`, `eventType`, `paymentKey`, `orderId`, `billingKey`, `customerKey` on webhook audit endpoints

Notes:

- This is not a full Express-to-Workers port.
- It now includes a first Workers-native `Bearer ssid` auth/session check.
- It ports discovery and playlist management before billing/upload/tailored.
- It now includes first-pass user/account/channel/download APIs used by `PROBGM-Frontend-V2`.
- Database access is designed for Workers and should use Hyperdrive in deployment.
- Database runtime can now be selected with `DB_PROVIDER=mysql|postgres|d1`.
- `mysql` is still the safest parity path today.
- `postgres` and `d1` are wired at the connection/runtime layer so they can be tested incrementally.
- Use `GET /health/db` to verify which provider was selected and whether a real connection succeeds.
- File upload is Worker-native and targets Cloudflare R2 via `UPLOADS_BUCKET`.
- `GET /health/storage` and `GET /api/upload/health` expose R2 upload readiness.
- Billing read/manage is available.
- Toss billing key issuance and billing creation are available.
- Payment history reads, payment confirm, and admin payment inspection are available.
- Typesense sync/admin operations are available at first pass.
- OTP auth is available.
- In development, OTP request responses include `otpCode` because email sending is not wired in the Worker yet.
- Local login/register is available.
- Social session callback, social verify/register parity, and OTP flows are available.
- Billing/upload are available at first pass.
- Sync/admin is available at first pass.
- Job/workflow/tailored routes remain outside the current cutover scope.
- Channel verification approval/admin is available at first pass.
- Worker sync currently targets the current Typesense collection directly; blue-green alias swap parity is still deferred.

## Local development

```bash
cp .dev.vars.example .dev.vars
npm install
npm run typecheck
npm run dev
```

## Deployment notes

- Add a Hyperdrive binding in `wrangler.toml`.
- Set Typesense credentials if fuzzy tag search should hit Typesense instead of SQL fallback.
- Set `TOSS_PAYMENTS_SECRET_KEY` for single/overseas payment confirmation.
- Set `TOSS_PAYMENTS_BILLING_SECRET_KEY` for billing key issuance and recurring billing execution.
- Set `TOSS_WEBHOOK_SECRET` if Toss webhook signature verification should be enforced.
- Set `DB_PROVIDER` to `mysql`, `postgres`, or `d1`.
- Set `POSTGRES_URL` for Postgres testing, or add a `DB` D1 binding for SQLite testing.
- Add an `UPLOADS_BUCKET` R2 binding to enable `/api/upload`.
- Set `R2_PUBLIC_URL` if uploaded objects should return a public URL.
- Optionally set `UPLOAD_METADATA_TABLE` if upload metadata should also be persisted to SQL.
- Optionally set `PAYMENT_WEBHOOK_AUDIT_TABLE` if webhook audit events should also be persisted to SQL.
- Optionally set `ADMIN_USER_IDS` as a comma-separated list to extend the legacy hardcoded admin allowlist.
- Validate database choice with:
  - `GET /health`
  - `GET /health/db`
  - `GET /health/schema`
- Validate upload/storage readiness with:
  - `GET /health/storage`
  - `GET /api/upload/health`
- The worker expects `Authorization: Bearer <ssid>` for authenticated routes.
- `SESSION_EXPIRY_HOURS` defaults to `24` if not set.

## Smoke scripts

Runtime/provider smoke:

```bash
BASE_URL=http://127.0.0.1:8787 npm run smoke:provider
```

Authenticated live smoke:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

Write smoke:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:write
```

Write compare:

```bash
LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
COMPARE_EMAIL=user@example.com \
COMPARE_PASSWORD=secret \
npm run compare:write
```

Admin payment smoke:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
npm run smoke:admin
```

Legacy vs Worker contract compare:

```bash
LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
COMPARE_AUTH_TOKEN=<ssid> \
COMPARE_USER_AGENT='contract-compare' \
npm run compare:contract
```

Optional promotion usage check:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
SMOKE_PROMOTION_CODE=PROMO2026 \
npm run smoke:admin
```

## Planning docs

- [docs/migration-notes.md](./docs/migration-notes.md)
- [docs/phase-roadmap.md](./docs/phase-roadmap.md)
- [docs/sql-schema-examples.md](./docs/sql-schema-examples.md)
- [docs/provider-test-matrix.md](./docs/provider-test-matrix.md)
- [docs/provider-live-runbook.md](./docs/provider-live-runbook.md)
- [docs/provider-decision-record-template.md](./docs/provider-decision-record-template.md)
- [docs/provider-decision-record-draft.md](./docs/provider-decision-record-draft.md)
- [docs/staging-execution-checklist.md](./docs/staging-execution-checklist.md)
- [docs/staging-write-checklist.md](./docs/staging-write-checklist.md)
- [docs/write-compare-runbook.md](./docs/write-compare-runbook.md)
- [docs/implementation-coverage.md](./docs/implementation-coverage.md)
- [docs/contract-parity-gaps.md](./docs/contract-parity-gaps.md)
- [docs/contract-compare-runbook.md](./docs/contract-compare-runbook.md)
- [docs/e2e-contract-check-2026-04-21.md](./docs/e2e-contract-check-2026-04-21.md)
- [docs/write-e2e-check-2026-04-21.md](./docs/write-e2e-check-2026-04-21.md)
- [docs/admin-incident-runbook.md](./docs/admin-incident-runbook.md)
- [docs/parity-matrix.md](./docs/parity-matrix.md)
- [docs/cutover-readiness.md](./docs/cutover-readiness.md)
