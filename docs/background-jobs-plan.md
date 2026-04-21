# Background Jobs Plan

This document tracks how Node/cron/process-driven behavior from `PROBGM-Backend-TS` should move into the Worker architecture.

Status:
- Deferred from the current cutover scope.
- Keep this as a follow-up planning document, not as an active migration target.

## Current Worker stance

Implemented now:
- manual admin trigger for pending grant processing
- manual admin trigger for Typesense consistency repair
- manual admin trigger for monthly credit renewal
- manual admin trigger for credit expiration
- manual admin trigger for due billing and retry billing
- admin job status endpoint
- Worker `scheduled()` entrypoint with cron-to-job dispatch

Not implemented yet:
- queue-based retries
- workflow-based tailored monitoring
- blue-green Typesense queue recovery
- advanced billing notification and channel-renewal scheduler parity

## Job split

### 1. Pending grants

Old backend:
- `PendingGrantCron`
- every 5 minutes

Worker target:
- short term: admin/manual trigger
- now: Cron Trigger entrypoint supported
- next: enable Cron Trigger every 5 minutes in deployment

Current endpoint:
- `POST /api/admin/jobs/run/pending-grants`

### 2. Typesense consistency

Old backend:
- `TypesenseSyncCron`
- daily consistency + stale queue recovery

Worker target:
- short term: admin/manual trigger
- now: Cron Trigger entrypoint supported
- next: daily Cron Trigger
- later: queue-aware recovery replacement

Current endpoint:
- `POST /api/admin/jobs/run/typesense-consistency`

### 3. Credit renewal

Old backend:
- monthly renewal
- daily expiration cleanup

Worker target:
- Cron Trigger
- separate monthly and daily handlers

Current endpoints:
- `POST /api/admin/jobs/run/credit-renewal/monthly`
- `POST /api/admin/jobs/run/credit-renewal/expire`

Status:
- first-pass Worker implementation added

### 4. Billing scheduler

Old backend:
- recurring billing processing
- renewal notifications
- channel renewal processing

Worker target:
- Cron Trigger or queue-backed scheduler
- split by concern rather than one monolith

Current endpoints:
- `POST /api/admin/jobs/run/billing-due`
- `POST /api/admin/jobs/run/billing-retries`

Status:
- first-pass Worker implementation added

### 5. Tailored monitoring and workflow

Old backend:
- monitoring interval
- job polling
- external callback coordination

Worker target:
- Durable Workflow / queue-based orchestration
- no interval-based long-lived process assumptions

Status:
- planned only

## Recommended order

1. Promote pending-grants to Cron Trigger
2. Promote typesense-consistency to Cron Trigger
3. Add credit-renewal Cron Trigger handlers
4. Split billing scheduler into small Worker-safe scheduled tasks
5. Move tailored workflow to queue/workflow architecture

## Current cron mapping

- `*/5 * * * *` -> pending grants
- `15 2 * * *` -> typesense consistency
- `0 0 1 * *` -> monthly credit renewal
- `0 1 * * *` -> credit expiration
- `*/10 * * * *` -> due billing cycles
- `0 * * * *` -> billing retries
