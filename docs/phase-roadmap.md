# Worker Migration Phase Roadmap

This roadmap is the execution plan for finishing `PROBGM-Backend-V2-Worker` as the Cloudflare Worker successor to `PROBGM-Backend-TS`.

## Phase 1. Runtime and parity baseline

Goal:
- Make the Worker runnable with minimal frontend breakage.

Status:
- In progress, largely complete.

Completed:
- Hono worker shell
- SSID session validation
- Local auth
- OTP auth
- Social session parity
- v3 discovery APIs
- Core playlist APIs
- user/account/channel/download APIs
- billing/payment read flows
- Toss confirm/cancel/webhook flows
- R2 upload flow
- mysql/postgres/d1 runtime switching
- local read-side contract compare on tested frontend-critical endpoints
- local safe write-side E2E for playlist/account flows

Remaining:
- live provider parity verification against real schema
- response parity audit on edge cases

## Phase 2. Payments, billing, and audit hardening

Goal:
- Reach operational parity for payment lifecycle handling.

Status:
- In progress.

Completed:
- billing key issuance
- billing creation
- one-time payment confirmation
- payment cancel
- webhook processing
- optional webhook audit table
- admin failed payment inspection
- admin webhook audit inspection
- local validation parity check for `payments/confirm`
- local validation parity check for `billing/issue-key`

Remaining:
- webhook replay/retry strategy
- billing and payment edge-case parity against production data
- webhook audit table live verification on staging

## Phase 3. Auth and account parity

Goal:
- Support current frontend auth/account flows without Express dependencies.

Status:
- In progress.

Completed:
- local auth
- OTP register/login flows
- social verify/register/session callback parity
- user profile and username update
- social bind/unbind
- account delete
- local username update write E2E verified across legacy/worker reads

Remaining:
- provider-specific OAuth code exchange if the edge layer needs to own it
- deeper email delivery parity for OTP

## Phase 4. Admin and moderation flows

Goal:
- Replace manual scripts and Express-only admin paths with Worker-native endpoints.

Status:
- Started.

Completed:
- admin channel verification queue endpoints
- admin channel approve/reject
- admin channel disable
- v2 label admin endpoints
- promotion stats and usage admin reads
- promotion admin list/create/deactivate
- pending grant admin retry endpoints
- typesense sync admin endpoints

Remaining:
- full blue-green sync and queue parity

## Phase 5. Storage and schema migration options

Goal:
- Keep MySQL as the safe path while making Postgres/D1 and R2 migration decisions testable.

Status:
- In progress.

Completed:
- selectable provider runtime
- `/health/db`
- `/health/storage`
- `/health/schema`
- Worker-native upload to R2
- optional SQL upload metadata persistence
- UTC/MySQL datetime parity verified locally for playlist write/read checks

Remaining:
- real-provider smoke against mysql/postgres/d1
- schema portability notes per route family
- upload metadata table migration scripts

## Phase 6. Deferred non-cutover work

Goal:
- Track deferred route families and operational work that are not part of the current cutover.

Status:
- Deferred from the current cutover scope.

Scope:
- background jobs
- workflow routes
- tailored routes
- blue-green alias/queue recovery

Remaining:
- keep them documented but outside the current cutover

## Phase 7. Cutover readiness

Goal:
- Make the Worker promotable behind real traffic.

Status:
- In progress.

Scope:
- route-by-route parity matrix
- staging traffic verification
- rollback plan
- observability and alerting
- deployment checklist

Completed:
- route parity matrix doc
- cutover readiness checklist
- provider/runtime health diagnostics
- authenticated live smoke script
- safe write smoke script
- write compare runbook
- local read/write E2E notes

Remaining:
- staging traffic verification with real frontend and DB
- live alerting/observability decisions
- route-family progressive cutover plan

## Immediate next priorities

1. staging execution of `smoke:provider`, `smoke:live`, `smoke:admin`, `smoke:write`
2. staging payment/billing live write verification using fixture bodies
3. live DB provider verification matrix for mysql/postgres/d1
4. upload metadata and webhook audit SQL schema docs/examples
