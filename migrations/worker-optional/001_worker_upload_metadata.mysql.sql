-- Optional: Worker upload metadata (MySQL)
-- Only required when UPLOAD_METADATA_TABLE is configured in the Worker.
-- Target table name must match the env variable value. The example uses
-- `worker_upload_metadata` which is the recommended default.

CREATE TABLE IF NOT EXISTS worker_upload_metadata (
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
