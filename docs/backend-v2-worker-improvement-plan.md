# Backend V2 Worker Improvement Plan

> Generated: 2026-04-22
> Based on: [backend-v2-worker-review.md](./backend-v2-worker-review.md)
> Scope: `PROBGM-Backend-V2-Worker`
> Goal: turn review findings into concrete cutover actions without changing the current cutover scope policy.

---

## 1. Summary

The review says the worker is close to cutover for the current scope, but not ready yet.

The two blocking areas are:

1. `redeem` route family is entirely missing.
2. Toss webhook handling is too permissive and not idempotent enough.

Everything else is important, but secondary:

- billing manual trigger parity
- cookie session compatibility check
- scheduled error handling
- D1 production guard
- optional SQL tables promoted into actual migration files

---

## 2. Priority Order

### P0 — Must close before cutover

1. Port `/api/redeem/*` route family.
2. Make webhook signature verification fail-closed outside development.

### P1 — Strongly recommended before cutover

1. Add webhook idempotency.
2. Restore billing manual trigger operations.
3. Verify whether cookie session fallback is required.

### P2 — Reliability / operations hardening

1. Add `scheduled()` try/catch and logging.
2. Prevent `d1` from being used in production by mistake.
3. Promote optional SQL tables into actual migration files.

---

## 3. Action Items

## 3.1 Redeem Route Parity

### Why

The worker currently ports `/api/promotion/*` but does not implement `/api/redeem/*`.
That breaks the "endpoint contract must not change" rule and can block the frontend redeem flow entirely.

### Required endpoints

- `POST /api/redeem`
- `GET /api/redeem/check/:code`
- `GET /api/redeem/history`
- `GET /api/redeem/stats`
- `GET /api/redeem/usage/:code`

### Expected implementation notes

- Add `src/routes/redeem.ts`
- Reuse patterns already present in:
  - `src/routes/promotion.ts`
  - `src/lib/promotion.ts`
- Match legacy auth behavior exactly:
  - authenticated endpoints use session auth
  - public code-check endpoint keeps its legacy access behavior
- Match legacy response envelope and message style

### Files likely affected

- `src/routes/redeem.ts`
- `src/index.ts`
- `docs/parity-matrix.md`
- `docs/contract-parity-gaps.md`
- `docs/cutover-readiness.md`
- `docs/implementation-coverage.md`

### Done when

- all 5 endpoints exist
- read/write contract compare can cover them
- cutover docs no longer list redeem as missing

---

## 3.2 Toss Webhook Signature: Fail Closed

### Why

Current webhook verification is skipped when `TOSS_WEBHOOK_SECRET` is empty.
That is too dangerous for production.

### Required change

- In production-like environments, reject webhook requests if the secret is not configured.
- Only allow bypass in explicit local development.

### Expected implementation notes

- Use `APP_ENV` or equivalent runtime mode gate.
- Recommended behavior:
  - `development`: bypass allowed
  - `staging/production`: missing secret returns `5xx` or equivalent hard failure

### Files likely affected

- `src/routes/payments.ts`
- `src/env.ts`
- `README.md`
- `docs/cutover-readiness.md`
- `docs/admin-incident-runbook.md`

### Done when

- webhook requests cannot run in staging/production with missing secret
- docs clearly state the requirement

---

## 3.3 Webhook Idempotency

### Why

Payment providers may replay webhook events.
Without idempotency, duplicate processing can create incorrect local payment state.

### Required change

- Store webhook event identifiers before processing.
- Return success on duplicate delivery without re-applying side effects.

### Expected implementation notes

- Use `PAYMENT_WEBHOOK_AUDIT_TABLE`
- Add unique constraint on event identity
- Insert first, process second
- On duplicate conflict, short-circuit to success

### Files likely affected

- `src/routes/payments.ts`
- `docs/sql-schema-examples.md`
- `docs/admin-incident-runbook.md`
- `docs/cutover-readiness.md`

### Done when

- duplicate webhook delivery cannot re-run state mutation
- audit table schema and uniqueness rule are documented

---

## 3.4 Billing Manual Trigger Parity

### Why

The worker has scheduled jobs, but the legacy system also exposes manual billing process endpoints for operators.
Those manual controls are useful during incidents.

### Required change

Restore either:

- the same legacy billing process endpoints, or
- one explicit admin replacement API with equivalent operational power

### Legacy parity targets

- `POST /api/billing/process/pending`
- `POST /api/billing/process/expired-memberships`
- `GET /api/billing/cron/status`

### Files likely affected

- `src/routes/billing.ts`
- or `src/routes/admin.ts`
- `docs/admin-incident-runbook.md`
- `docs/cutover-readiness.md`

### Done when

- operators can manually trigger or inspect billing processing
- runbook documents the exact path to use

---

## 3.5 Cookie Session Compatibility Check

### Why

Legacy backend accepts both bearer token and cookie-based session behavior.
The worker currently parses bearer token only.

### Required decision

Check whether any remaining client still depends on cookie auth.

### Possible outcomes

- If no client depends on cookies:
  - document bearer-only assumption
- If any client depends on cookies:
  - add cookie-to-bearer fallback in auth middleware

### Files likely affected

- `src/lib/auth.ts`
- `README.md`
- `docs/cutover-readiness.md`

### Done when

- cookie dependency is explicitly confirmed or rejected
- no hidden auth regression remains at cutover

---

## 3.6 scheduled() Error Handling

### Why

Background scheduled execution currently needs clearer logging and failure handling.

### Required change

- wrap scheduled job dispatch in `try/catch`
- log failures clearly
- rethrow where appropriate so failure is visible to the platform

### Files likely affected

- `src/scheduled.ts`
- maybe `src/lib/jobs.ts`
- `docs/background-jobs-plan.md`

### Done when

- scheduler failures leave an observable trace

---

## 3.7 D1 Production Guard

### Why

D1 support exists as an option, but the current SQL normalization is intentionally loose and should not silently become the production provider.

### Required change

- fail fast if `DB_PROVIDER=d1` in production
- keep D1 available only for explicit experimentation

### Files likely affected

- `src/lib/db.ts`
- `src/env.ts`
- `docs/provider-live-runbook.md`
- `docs/provider-decision-record-draft.md`

### Done when

- production cannot start accidentally on D1

---

## 3.8 Optional Tables as Real SQL Migrations

### Why

Optional operational tables are documented, but not yet shipped as migration files.
That creates deployment ambiguity.

### Tables called out in review

- upload metadata table
- payment webhook audit table

### Required change

- add real SQL files under a migration directory
- keep them optional, but versioned and ready to apply

### Suggested directory

- `migrations/worker-optional/`

### Files likely affected

- new SQL files
- `docs/sql-schema-examples.md`
- `README.md`
- `docs/staging-execution-checklist.md`

### Done when

- DBA or operator can apply exact SQL from repo without copying snippets out of docs

---

## 4. Suggested Execution Sequence

1. Implement `redeem` route family.
2. Lock down webhook signature policy.
3. Add webhook idempotency.
4. Restore billing manual trigger parity.
5. Decide cookie fallback requirement.
6. Harden `scheduled()`.
7. Add D1 production guard.
8. Add optional SQL migration files.

This order keeps user-facing contract gaps and payment risks ahead of operational polish.

---

## 5. Required Document Updates After Implementation

Once the above items are done, update these documents together:

- [cutover-readiness.md](./cutover-readiness.md)
- [parity-matrix.md](./parity-matrix.md)
- [contract-parity-gaps.md](./contract-parity-gaps.md)
- [implementation-coverage.md](./implementation-coverage.md)
- [admin-incident-runbook.md](./admin-incident-runbook.md)
- [provider-live-runbook.md](./provider-live-runbook.md)

Also add a dated validation record if any of the above is proven with live compare or smoke runs.

---

## 6. Cutover Recommendation

Do not mark the worker cutover-ready until both are closed:

1. `redeem` parity
2. production-safe webhook verification

The rest can still be scheduled tightly behind those items, but these two are the real release gate according to the review.
