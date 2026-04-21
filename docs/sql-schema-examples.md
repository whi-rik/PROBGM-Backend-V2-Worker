# Optional SQL Schema Examples

These tables are optional. The Worker can run without them.

Use them when you want:
- upload metadata persistence
- Toss webhook audit persistence

Validate the currently expected columns with:
- `GET /health/schema`

## Upload metadata

### MySQL

```sql
CREATE TABLE worker_upload_metadata (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  public_url TEXT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'r2',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_worker_upload_metadata_user_created (user_id, created_at),
  KEY idx_worker_upload_metadata_storage_key (storage_key(255))
);
```

### Postgres

```sql
CREATE TABLE worker_upload_metadata (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  storage_key TEXT NOT NULL,
  public_url TEXT NULL,
  file_size BIGINT NOT NULL,
  mime_type VARCHAR(255) NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'r2',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_worker_upload_metadata_user_created
  ON worker_upload_metadata (user_id, created_at DESC);

CREATE INDEX idx_worker_upload_metadata_storage_key
  ON worker_upload_metadata (storage_key);
```

### D1 / SQLite

```sql
CREATE TABLE worker_upload_metadata (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  public_url TEXT,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'r2',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_worker_upload_metadata_user_created
  ON worker_upload_metadata (user_id, created_at DESC);

CREATE INDEX idx_worker_upload_metadata_storage_key
  ON worker_upload_metadata (storage_key);
```

## Payment webhook audit

### MySQL

```sql
CREATE TABLE worker_payment_webhook_audit (
  id CHAR(36) PRIMARY KEY,
  webhook_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payment_key VARCHAR(255) NULL,
  order_id VARCHAR(255) NULL,
  billing_key VARCHAR(255) NULL,
  customer_key VARCHAR(255) NULL,
  status VARCHAR(50) NOT NULL,
  raw_data JSON NOT NULL,
  processing_result JSON NULL,
  error_message TEXT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_worker_webhook_audit_webhook_id (webhook_id),
  KEY idx_worker_webhook_audit_payment_key (payment_key),
  KEY idx_worker_webhook_audit_event_created (event_type, created_at)
);
```

### Postgres

```sql
CREATE TABLE worker_payment_webhook_audit (
  id UUID PRIMARY KEY,
  webhook_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  payment_key VARCHAR(255),
  order_id VARCHAR(255),
  billing_key VARCHAR(255),
  customer_key VARCHAR(255),
  status VARCHAR(50) NOT NULL,
  raw_data JSONB NOT NULL,
  processing_result JSONB,
  error_message TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_worker_webhook_audit_webhook_id
  ON worker_payment_webhook_audit (webhook_id);

CREATE INDEX idx_worker_webhook_audit_payment_key
  ON worker_payment_webhook_audit (payment_key);

CREATE INDEX idx_worker_webhook_audit_event_created
  ON worker_payment_webhook_audit (event_type, created_at DESC);
```

### D1 / SQLite

```sql
CREATE TABLE worker_payment_webhook_audit (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payment_key TEXT,
  order_id TEXT,
  billing_key TEXT,
  customer_key TEXT,
  status TEXT NOT NULL,
  raw_data TEXT NOT NULL,
  processing_result TEXT,
  error_message TEXT,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_worker_webhook_audit_webhook_id
  ON worker_payment_webhook_audit (webhook_id);

CREATE INDEX idx_worker_webhook_audit_payment_key
  ON worker_payment_webhook_audit (payment_key);

CREATE INDEX idx_worker_webhook_audit_event_created
  ON worker_payment_webhook_audit (event_type, created_at DESC);
```

## Recommended rollout

1. Keep production parity on MySQL or Hyperdrive first.
2. Create optional tables there first.
3. Test the same Worker against Postgres or D1 only after route-level parity is validated.
