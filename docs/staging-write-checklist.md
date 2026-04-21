# Staging Write Checklist

Use this after basic deploy/provider/live/admin checks pass.

## Goal

Verify that Worker write-side behavior is safe enough for staging cutover.

This checklist is split into:

- safe writes
- validation-only payment checks
- optional live payment/billing writes

## Required Inputs

- `BASE_URL`
- `SMOKE_EMAIL`
- `SMOKE_PASSWORD`

Optional:

- `SMOKE_WRITE_PREFIX`
- `SMOKE_PAYMENT_CONFIRM_BODY_FILE`
- `SMOKE_BILLING_ISSUE_KEY_BODY_FILE`
- `SMOKE_BILLING_CREATE_BODY_FILE`

## Safe Write Smoke

This runs:

- playlist create
- playlist add/remove
- playlist update
- playlist favorite
- username update and restore
- validation-only payment/billing requests

```bash
cd PROBGM-Backend-V2-Worker

BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
SMOKE_WRITE_PREFIX=staging-write \
npm run smoke:write
```

## What Safe Write Smoke Verifies

- `POST /api/playlist`
- `POST /api/playlist/add`
- `POST /api/playlist/remove`
- `PUT /api/playlist/:id`
- `POST /api/playlist/:id/favorite`
- `PUT /api/user/username`
- `POST /api/payments/confirm` with empty body returns legacy-style validation error
- `POST /api/billing/issue-key` with empty body returns legacy-style validation error

## Optional Live Payment/Billing Write Smoke

Only run this if you intentionally want real staging side effects.

### 1. Prepare body files

Example:

- `confirm-payment.json`
- `issue-billing-key.json`
- `create-billing.json`

### 2. Run with explicit files

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
SMOKE_PAYMENT_CONFIRM_BODY_FILE=./fixtures/confirm-payment.json \
SMOKE_BILLING_ISSUE_KEY_BODY_FILE=./fixtures/issue-billing-key.json \
SMOKE_BILLING_CREATE_BODY_FILE=./fixtures/create-billing.json \
npm run smoke:write
```

## Recommended Order

1. run `smoke:provider`
2. run `smoke:live`
3. run `smoke:admin`
4. run `smoke:write`
5. only then consider optional live payment/billing write smoke

## Recording

When a write mismatch is found, record:

- endpoint
- request body used
- legacy response
- worker response
- actual DB side effect

Then update:

- [write-e2e-check-2026-04-21.md](./write-e2e-check-2026-04-21.md)
- [contract-parity-gaps.md](./contract-parity-gaps.md)
