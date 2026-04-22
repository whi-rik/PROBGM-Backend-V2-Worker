-- Minimal schema for Worker integration tests.
-- Only includes the columns the Worker code actually reads/writes. Real staging
-- tables have more columns; that is fine — CREATE TABLE IF NOT EXISTS only
-- provisions the minimum needed by tests.

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(50),
  email VARCHAR(100),
  password_hash VARCHAR(255),
  provider VARCHAR(20) NOT NULL DEFAULT 'local',
  social_id VARCHAR(255),
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_newbie_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users_tokens (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  token VARCHAR(36) NOT NULL,
  token_type VARCHAR(20) DEFAULT 'access',
  client_ip VARCHAR(45),
  user_agent TEXT,
  is_expire TINYINT(1) NOT NULL DEFAULT 0,
  issued_in DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity DATETIME NULL,
  KEY idx_users_tokens_user (user_id),
  KEY idx_users_tokens_token (token)
);

CREATE TABLE IF NOT EXISTS users_balance (
  user VARCHAR(36) PRIMARY KEY,
  balance INT NOT NULL DEFAULT 0,
  bonus_credits INT NOT NULL DEFAULT 0,
  bonus_credits_expires_at DATETIME NULL,
  download_point INT NOT NULL DEFAULT 0,
  bonus_download_points INT NOT NULL DEFAULT 0,
  bonus_download_points_expires_at DATETIME NULL,
  credit_expires_at DATETIME NULL,
  last_credit_reset_at DATETIME NULL,
  last_download_point_reset_at DATETIME NULL,
  last_update DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users_membership (
  user VARCHAR(36) PRIMARY KEY,
  tier INT NOT NULL DEFAULT 0,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  renewal_interval_days INT NOT NULL DEFAULT 30,
  last_renewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_active TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users_transaction (
  id VARCHAR(36) PRIMARY KEY,
  operated_by VARCHAR(50) NOT NULL,
  user VARCHAR(36) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  change_amount INT NOT NULL,
  balance INT NOT NULL,
  datetime DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_users_transaction_user_date (user, datetime)
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  label_id VARCHAR(36) NULL,
  reward_type VARCHAR(20) NOT NULL DEFAULT 'membership',
  membership_type VARCHAR(20) NULL,
  duration_days INT NOT NULL DEFAULT 0,
  credits_amount INT NULL,
  download_points_amount INT NULL,
  max_uses INT NOT NULL DEFAULT 1,
  current_uses INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS redeem_code_usage (
  id INT AUTO_INCREMENT PRIMARY KEY,
  redeem_code_id INT NOT NULL,
  code VARCHAR(50) NOT NULL,
  used_by VARCHAR(36) NOT NULL,
  used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT,
  reward_type VARCHAR(20) NULL,
  membership_type VARCHAR(20) NULL,
  membership_days INT NULL,
  credits_granted INT NULL,
  download_points_granted INT NULL,
  KEY idx_redeem_code_usage_used_by (used_by),
  KEY idx_redeem_code_usage_code (redeem_code_id)
);

-- Matches migrations/worker-optional/002_worker_payment_webhook_audit.mysql.sql.
-- UNIQUE KEY on webhook_id is load-bearing for idempotency tests.
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

-- Minimal columns used by payments webhook handler. Real schema has more.
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payment_key VARCHAR(200) UNIQUE,
  order_id VARCHAR(200) UNIQUE,
  order_name VARCHAR(255),
  amount DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'KRW',
  method VARCHAR(50),
  status VARCHAR(50) DEFAULT 'READY',
  user_id VARCHAR(36),
  customer_key VARCHAR(200),
  billing_key VARCHAR(200),
  is_billing TINYINT(1) DEFAULT 0,
  billing_cycle VARCHAR(20),
  toss_payment_data JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_cycles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  payment_id INT,
  user_id VARCHAR(36),
  customer_key VARCHAR(200),
  billing_key VARCHAR(200),
  cycle_type VARCHAR(20) DEFAULT 'MONTHLY',
  billing_day INT,
  amount DECIMAL(10,2),
  currency VARCHAR(10) DEFAULT 'KRW',
  order_name VARCHAR(255),
  status VARCHAR(20) DEFAULT 'ACTIVE',
  next_billing_date DATETIME NULL,
  last_billing_date DATETIME NULL,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3,
  last_retry_date DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
