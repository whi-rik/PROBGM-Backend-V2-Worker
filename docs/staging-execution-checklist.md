# Staging Execution Checklist

Use this when you want the shortest possible path to verify the current Worker cutover scope in staging.

## 1. Deploy and runtime check

```bash
npx wrangler deploy --dry-run
```

Then confirm:

- `/health`
- `/health/db`
- `/health/storage`

## 2. Provider check

MySQL default example:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=mysql \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

## 3. Authenticated user check

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

Confirm:

- auth/session works
- playlist reads work
- payment history reads work
- download list works

## 4. Admin check

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
npm run smoke:admin
```

Optional if webhook audit table is configured:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
SMOKE_EXPECT_WEBHOOK_AUDIT=1 \
npm run smoke:admin
```

Optional if promotion usage should be checked:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
SMOKE_PROMOTION_CODE=PROMO2026 \
npm run smoke:admin
```

## 5. Record provider decision

After the checks pass, fill:

- [provider-decision-record-draft.md](./provider-decision-record-draft.md)

## 6. Do not include in current cutover

Keep these out unless the scope is explicitly widened:

- tailored
- workflow
- jobs/cron rollout
- provider-owned OAuth code exchange
