# Provider Live Runbook

Use this runbook when deciding whether `PROBGM-Backend-V2-Worker` should stay on MySQL/Hyperdrive or move to Postgres or D1.

## Decision policy

- Default to `mysql` until another provider passes the same checks against the real schema.
- Promote `postgres` or `d1` only after runtime health, authenticated smoke, and payment/playlist checks all match expectations.

## Step 1. Deploy one provider at a time

Pick exactly one:

- `DB_PROVIDER=mysql`
- `DB_PROVIDER=postgres`
- `DB_PROVIDER=d1`

Do not compare providers from local assumptions alone. Always compare deployed behavior.

## Step 2. Runtime validation

Run provider smoke with explicit expectations:

### MySQL

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=mysql \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

### Postgres

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=postgres \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

### D1

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=d1 \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

Pass criteria:

- `/health/db` reports the expected provider
- `/health/db` reports `"ok": true`
- `/health/schema` is reachable
- `/health/storage` and `/api/upload/health` are reachable

## Step 3. Authenticated parity validation

Use a real account:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

Pass criteria:

- auth works
- playlist reads work
- payment history reads work
- download list works

## Step 4. Admin payment inspection

If admin inspection is part of rollout, validate it separately:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
npm run smoke:admin
```

Optional:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
SMOKE_EXPECT_WEBHOOK_AUDIT=1 \
npm run smoke:admin
```

Pass criteria:

- admin dashboard works
- failed payment list works
- webhook audit list works when the audit table is configured

## Step 5. Choose the provider

Choose `mysql` when:

- it is the only provider passing all checks
- write parity is highest
- migration cost is not justified yet

Choose `postgres` when:

- runtime checks pass
- authenticated smoke matches MySQL behavior
- payment and playlist writes match expectations

Choose `d1` when:

- the route set is intentionally narrowed
- schema portability is verified
- operational simplicity matters more than full SQL parity

## Step 6. Record the decision

After running the checks, write one provider decision record using:

- [docs/provider-decision-record-template.md](./provider-decision-record-template.md)
- [docs/provider-decision-record-draft.md](./provider-decision-record-draft.md) as the starting point for the current mysql-default recommendation

Include:

- environment
- selected provider
- exact smoke commands used
- health/db result
- authenticated smoke result
- admin smoke result
- final recommendation

## Current recommendation

- Use `mysql` or Hyperdrive as the current safe default.
- Treat `postgres` and `d1` as experimental until live parity checks pass.

## Production safety guards

As of the 2026-04-22 improvement pass, the Worker enforces:

- `DB_PROVIDER=d1` is rejected at `withConnection` entry when `APP_ENV=production`.
  Attempting a production deploy with `DB_PROVIDER=d1` fails fast with a clear
  error. Remove the guard in `src/lib/db.ts` only after D1 SQL normalization is
  rewritten to cover dialect gaps documented in
  [backend-v2-worker-review.md](./backend-v2-worker-review.md).
- The Toss webhook handler refuses requests with HTTP 503 when
  `TOSS_WEBHOOK_SECRET` is missing and `APP_ENV != development`. Confirm the
  secret is set in the target environment before routing webhook traffic.

These guards are deliberately verbose in logs so that misconfiguration does not
appear as a silent data issue later.
