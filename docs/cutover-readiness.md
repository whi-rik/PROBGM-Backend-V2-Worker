# Cutover Readiness

This checklist is the handoff point for deciding whether `PROBGM-Backend-V2-Worker` can move from prototype/staging use toward real traffic.

## 1. Runtime and bindings

- `wrangler deploy --dry-run` passes
- `/health` returns `success: true`
- `/health/db` confirms the selected provider and successful ping
- `/health/storage` confirms R2 readiness

## 2. Database provider decision

- MySQL or Hyperdrive tested first
- Postgres only after playlist/payment writes are confirmed against the real schema
- D1 only after narrowed route-family verification
- Provider decision recorded with date and environment

## 3. Staging API verification

- `npm run smoke:live` passes against the target Worker URL
- `npm run smoke:admin` passes against the target Worker URL when admin inspection is in scope
- `npm run smoke:write` passes against the target Worker URL for safe write flows
- Auth flows work with real `users_tokens`
- `PROBGM-Frontend-V2` can read discovery endpoints from Worker
- playlist create/add/remove/reorder works against staging DB
- payment confirm/cancel/webhook updates staging records correctly
- download entitlement logic matches current backend behavior
- upload writes to R2 and optional SQL metadata table when configured
- admin failed payment inspection endpoints behave correctly

## 4. Admin and moderation

- channel verification approve/reject/disable verified
- promotion admin create/deactivate verified
- label admin CRUD verified
- pending grant retry endpoints verified
- sync/export/status endpoints verified
- admin failed payment and webhook audit inspection verified
- admin payment cancellation inspection verified
- webhook audit stats endpoint verified when audit table is enabled
- payment admin filters verified for the intended incident window, order, payment, billing, or customer key
- promotion admin list and promotion stats verified
- admin incident runbook reviewed and usable by operators

## Local E2E status already completed

These checks were already completed locally against shared MariaDB/Typesense:

- read-side contract compare on tested frontend-critical endpoints
- playlist create/add/remove/update/favorite side effects
- username update side effect
- payment confirm empty-body validation parity
- billing issue-key empty-body validation parity
- write compare between legacy and worker for safe playlist writes

Reference:

- [e2e-contract-check-2026-04-21.md](./e2e-contract-check-2026-04-21.md)
- [write-e2e-check-2026-04-21.md](./write-e2e-check-2026-04-21.md)
- [staging-write-checklist.md](./staging-write-checklist.md)
- [write-compare-runbook.md](./write-compare-runbook.md)

## 5. Known non-cutover items

These can remain out of scope for initial Worker traffic if routes are not pointed at Worker yet:

- tailored routes
- workflow routes
- job/cron rollout
- provider-owned OAuth code exchange
- blue-green Typesense alias swap
- billing notification emails
- advanced webhook replay/audit workflow

## 6. Rollback rule

Do not cut over if any of these fail:

- payment write parity
- playlist write parity
- download entitlement parity
- auth/session stability
- provider ping and schema health

Fallback path:

- keep `PROBGM-Backend-TS` as the write authority
- use Worker only for verified read-heavy routes first
- widen the route set only after staging checks pass
