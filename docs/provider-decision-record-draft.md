# Provider Decision Record Draft

This is the prefilled starting point for the first real provider choice.

Use it only after running the live checks in staging. Do not treat this file as evidence that the checks already passed.

## Metadata

- Date: TBD
- Environment: staging
- Worker URL: TBD
- Evaluated provider: mysql
- Evaluator: TBD

## Runtime configuration

- `DB_PROVIDER`: mysql
- Hyperdrive enabled: TBD
- `POSTGRES_URL` or `PG_*` configured: no
- D1 binding configured: no
- `UPLOADS_BUCKET` configured: TBD
- `UPLOAD_METADATA_TABLE` configured: TBD
- `PAYMENT_WEBHOOK_AUDIT_TABLE` configured: TBD

## Commands planned

### Provider smoke

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=mysql \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

Result:
- pending live execution

### Authenticated smoke

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

Result:
- pending live execution

### Admin smoke

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_ADMIN_EMAIL=admin@example.com \
SMOKE_ADMIN_PASSWORD=secret \
npm run smoke:admin
```

Result:
- pending live execution

## Current expectation

- Recommended provider: mysql
- Why:
  - current safest parity path
  - existing schema alignment is highest
  - Postgres and D1 are still experimental until live parity checks pass

## What must be filled before final decision

- actual `/health/db` result
- authenticated smoke outcome
- admin smoke outcome
- any playlist/payment mismatch notes
- final go/no-go recommendation
