-- Optional: Worker Toss webhook audit (MySQL)
-- Only required when PAYMENT_WEBHOOK_AUDIT_TABLE is configured in the Worker.
-- Target table name must match the env variable value. The example uses
-- `worker_payment_webhook_audit` which is the recommended default.
--
-- NOTE: UNIQUE KEY on webhook_id is REQUIRED for the Worker's idempotency
-- guard (findProcessedWebhookResult) to function reliably under retries.

CREATE TABLE IF NOT EXISTS worker_payment_webhook_audit (
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
  UNIQUE KEY uk_worker_webhook_audit_webhook_id (webhook_id),
  KEY idx_worker_webhook_audit_payment_key (payment_key),
  KEY idx_worker_webhook_audit_event_created (event_type, created_at)
);
