# Worker Optional SQL Migrations

These SQL files match the optional tables documented in
[../../docs/sql-schema-examples.md](../../docs/sql-schema-examples.md).

They are optional: the Worker runs correctly without them. Apply them only when
the corresponding env variable is configured:

| File | Env variable | Purpose |
|------|--------------|---------|
| `001_worker_upload_metadata.mysql.sql` | `UPLOAD_METADATA_TABLE` | Persist metadata for files uploaded via `/api/upload`. |
| `002_worker_payment_webhook_audit.mysql.sql` | `PAYMENT_WEBHOOK_AUDIT_TABLE` | Persist Toss webhook events and support idempotent replay handling. |

## Naming

The Worker reads the exact table name from the env variable. The recommended
default names in these files are:

- `worker_upload_metadata`
- `worker_payment_webhook_audit`

If you use a different table name, set the env variable to that name and
rename the table in the SQL file accordingly before applying.

## Applying

These files target MySQL / Hyperdrive. For Postgres / D1 variants use the
examples in [../../docs/sql-schema-examples.md](../../docs/sql-schema-examples.md).

```bash
mysql -h <host> -u <user> -p <database> < migrations/worker-optional/001_worker_upload_metadata.mysql.sql
mysql -h <host> -u <user> -p <database> < migrations/worker-optional/002_worker_payment_webhook_audit.mysql.sql
```

After applying, confirm the Worker sees the tables via:

```
GET /health/schema
```

## Important: webhook idempotency

`002_worker_payment_webhook_audit.mysql.sql` enforces a UNIQUE KEY on
`webhook_id`. This is required for the Worker's `findProcessedWebhookResult`
idempotency guard to hold up under retry storms. Do not drop that index.
