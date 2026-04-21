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

## 5. Sequence for incident triage

1. Check failed payments for the incident window.
2. Check cancellations for the same window.
3. If webhook processing is involved, inspect webhook audit rows and stats.
4. If a discount or billing amount looks wrong, inspect promotion stats and code usage.
5. Record the findings in the deployment or incident log before retrying or rolling back.
