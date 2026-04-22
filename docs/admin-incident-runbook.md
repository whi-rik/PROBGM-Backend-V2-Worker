# Admin Incident Runbook

Use this runbook when investigating payment or promotion incidents in `PROBGM-Backend-V2-Worker`.

## 1. Payment failures

List recent failed payments:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/payments/failed?createdFrom=2026-04-01T00:00:00Z&createdTo=2026-04-30T23:59:59Z"
```

Useful filters:

- `userId`
- `orderId`
- `method`
- `billingOnly=true`
- `createdFrom`
- `createdTo`

Use this when:

- a single user reports checkout failure
- a billing-only failure window needs investigation
- a specific order ID must be traced

## 2. Payment cancellations

List recent cancellations:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/payments/cancellations?createdFrom=2026-04-01T00:00:00Z&createdTo=2026-04-30T23:59:59Z"
```

Useful filters:

- `paymentKey`
- `orderId`
- `billingKey`
- `customerKey`
- `requestedBy`
- `status`
- `cancellationType`
- `createdFrom`
- `createdTo`

Cancellation summary:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/payments/cancellations/stats?createdFrom=2026-04-01T00:00:00Z&createdTo=2026-04-30T23:59:59Z"
```

Use this when:

- refund volume spikes
- partial vs full cancellation ratio must be checked
- a specific billing key or customer key must be traced

## 3. Webhook audit

List webhook audit rows:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/payments/webhook-audit?status=FAILED&createdFrom=2026-04-01T00:00:00Z"
```

Useful filters:

- `status`
- `eventType`
- `paymentKey`
- `orderId`
- `billingKey`
- `customerKey`
- `createdFrom`
- `createdTo`

Webhook audit summary:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/payments/webhook-audit/stats?createdFrom=2026-04-01T00:00:00Z"
```

Use this when:

- Toss webhook failures need narrowing
- a single payment or billing key must be traced through webhook processing
- event-type failure concentration must be checked quickly

## 4. Promotion operations

List promotions:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/admin/promotions?active=true&page=1&limit=20"
```

Promotion usage by code:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/promotion/usage/PROMO2026?createdFrom=2026-04-01T00:00:00Z"
```

Promotion stats with time window:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/promotion/stats?createdFrom=2026-04-01T00:00:00Z&createdTo=2026-04-30T23:59:59Z"
```

Useful filters:

- promotions list:
  - `code`
  - `active`
  - `page`
  - `limit`
- usage:
  - `usedBy`
  - `paymentId`
  - `createdFrom`
  - `createdTo`

Use this when:

- a promotion code appears overused
- a single user/payment must be traced to a promotion application
- discount totals over a time window need validation

## 5. Redeem operations

Check redeem stats and a specific code:

```bash
curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/redeem/stats"

curl -H "Authorization: Bearer <admin-ssid>" \
  "https://your-worker.example.com/api/redeem/usage/WELCOME2026"
```

Use this when:

- a redeem code appears to be granting more than its intended uses
- a user reports missing rewards after redeem
- a label or membership grant needs to be audited against the usage log

## 6. Billing manual triggers

Scheduled billing runs via Cloudflare Workers cron. If an incident requires a
manual run between cron ticks, use these session-authenticated endpoints:

```bash
# Run due + retry billing cycles immediately
curl -X POST -H "Authorization: Bearer <ssid>" \
  "https://your-worker.example.com/api/billing/process/pending"

# Expire credits that passed their renewal window
curl -X POST -H "Authorization: Bearer <ssid>" \
  "https://your-worker.example.com/api/billing/process/expired-memberships"

# Confirm the scheduler runtime and current cron mappings
curl -H "Authorization: Bearer <ssid>" \
  "https://your-worker.example.com/api/billing/cron/status"
```

Use this when:

- Cloudflare cron triggers are paused or misconfigured and a batch must run now
- a specific user's billing retry cannot wait for the next cron tick
- verifying the Worker's advertised schedule vs the actual `wrangler.toml` triggers

## 7. Webhook replay / idempotency

Inbound Toss webhooks are deduplicated by `webhook_id` against the configured
`PAYMENT_WEBHOOK_AUDIT_TABLE`. When a webhook is re-delivered:

- the Worker returns the cached `PROCESSED` result with `idempotent: true`
- no state mutation re-runs (payments, billing cycles, memberships)
- audit rows are only written on first processing

Checks during incident triage:

1. Inspect `worker_payment_webhook_audit` rows for repeated `webhook_id`.
2. If a stale `FAILED` status persists, it means idempotency did not apply —
   confirm the UNIQUE KEY on `webhook_id` is present (see
   `migrations/worker-optional/002_worker_payment_webhook_audit.mysql.sql`).
3. If `TOSS_WEBHOOK_SECRET` is unset in staging/production, the Worker refuses
   webhooks with 503. Check environment posture before assuming delivery failure.

## 8. Sequence for incident triage

1. Check failed payments for the incident window.
2. Check cancellations for the same window.
3. If webhook processing is involved, inspect webhook audit rows and stats (section 3 + 7).
4. If a discount or billing amount looks wrong, inspect promotion stats and code usage.
5. If a reward / membership was lost, inspect redeem usage (section 5).
6. If billing did not execute on schedule, confirm cron status and run manual triggers (section 6).
7. Record the findings in the deployment or incident log before retrying or rolling back.
