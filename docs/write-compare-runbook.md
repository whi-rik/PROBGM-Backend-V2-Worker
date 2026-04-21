# Write Compare Runbook

Use this when you want to compare write-side behavior between:

- `PROBGM-Backend-TS`
- `PROBGM-Backend-V2-Worker`

This runbook is intentionally limited to safe playlist writes by default.

## Goal

Check whether both backends:

- accept the same request bodies
- return close enough response envelopes
- create side effects that can be read from the opposite backend

## Required Inputs

- `LEGACY_BASE_URL`
- `WORKER_BASE_URL`
- `COMPARE_EMAIL`
- `COMPARE_PASSWORD`

Optional:

- `COMPARE_WRITE_PREFIX`
- `COMPARE_USER_AGENT`

## Basic Run

```bash
cd PROBGM-Backend-V2-Worker

LEGACY_BASE_URL=https://legacy.example.com \
WORKER_BASE_URL=https://worker.example.com \
COMPARE_EMAIL=user@example.com \
COMPARE_PASSWORD=secret \
COMPARE_WRITE_PREFIX=staging-compare \
npm run compare:write
```

## What It Does

1. logs into both backends with the same user
2. fetches one music id from Worker discovery
3. creates one playlist on legacy
4. creates one playlist on worker
5. adds the same music to both
6. updates both playlists
7. cross-reads:
   - legacy-created playlist from worker
   - worker-created playlist from legacy

## Why Same User-Agent Matters

Legacy session verification can invalidate a session if the `User-Agent` changes.

`compare:write` uses one fixed `COMPARE_USER_AGENT` for:

- legacy login
- worker login
- all follow-up write/read requests

## Recommended Review Points

After each run, compare:

- create response status and `message`
- update response status and `message`
- cross-read playlist detail
  - `title`
  - `description`
  - `is_public`
  - `musics`
  - `created_in`
  - `updated_at`

## Limits

- This script does not compare payment or billing live writes.
- It does not roll back created playlists.
- It is intended for staging, not production.

## Related Docs

- [staging-write-checklist.md](./staging-write-checklist.md)
- [write-e2e-check-2026-04-21.md](./write-e2e-check-2026-04-21.md)
- [contract-parity-gaps.md](./contract-parity-gaps.md)
