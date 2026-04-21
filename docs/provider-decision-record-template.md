# Provider Decision Record Template

Use this template after running the provider smoke and live checks.

## Metadata

- Date:
- Environment:
- Worker URL:
- Evaluated provider:
- Evaluator:

## Runtime configuration

- `DB_PROVIDER`:
- Hyperdrive enabled:
- `POSTGRES_URL` or `PG_*` configured:
- D1 binding configured:
- `UPLOADS_BUCKET` configured:
- `UPLOAD_METADATA_TABLE` configured:
- `PAYMENT_WEBHOOK_AUDIT_TABLE` configured:

## Commands run

### Provider smoke

```bash
BASE_URL=...
SMOKE_EXPECT_PROVIDER=...
SMOKE_REQUIRE_DB_OK=1
npm run smoke:provider
```

Result:

### Authenticated smoke

```bash
BASE_URL=...
SMOKE_EMAIL=...
SMOKE_PASSWORD=...
npm run smoke:live
```

Result:

### Admin smoke

```bash
BASE_URL=...
SMOKE_ADMIN_EMAIL=...
SMOKE_ADMIN_PASSWORD=...
npm run smoke:admin
```

Result:

## Health summary

- `/health`:
- `/health/db` selected provider:
- `/health/db` connection ok:
- `/health/storage`:
- `/health/schema`:

## Behavioral notes

- Auth/session:
- Discovery:
- Playlists:
- Payments:
- Upload:
- Admin inspection:

## Decision

- Recommended provider:
- Why:
- Blocking issues:
- Follow-up actions:
