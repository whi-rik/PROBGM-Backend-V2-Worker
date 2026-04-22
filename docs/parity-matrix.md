# Route Parity Matrix

This matrix is the cutover-oriented view of what is already implemented in `PROBGM-Backend-V2-Worker` and what still requires either deeper parity work or architectural replacement.

## Ready for focused staging verification

- Health and runtime diagnostics
  - `/`
  - `/health`
  - `/health/db`
  - `/health/storage`
  - `/health/schema`
- Auth/session
  - local login/register/verify
  - OTP request/verify flows
  - social verify/register/callback parity
  - session refresh/signout/check
- Discovery
  - `/api/v3/tags*`
  - `/api/v3/assets*`
- Account bootstrap
  - `/user/info`
  - `/user/balance`
  - `/user/membership`
  - `/user/label`
  - `/user/stats`
  - `/api/user/profile`
- Playlists
  - public read
  - mine/accessible/favorite
  - add/remove/update/delete
  - reorder/custom-title/duplicate/like/category/popular
- Downloads
  - `/api/download/list`
  - `/api/download/:id`
- Promotions
  - check/history/stats/usage
  - admin list/create/deactivate
- Redeem
  - `/api/redeem` (use code, session-auth)
  - `/api/redeem/check/:code` (public)
  - `/api/redeem/history` (session-auth)
  - `/api/redeem/stats` (admin-auth)
  - `/api/redeem/usage/:code` (admin-auth)
- Billing and payments
  - billing key issue
  - billing cycle create/pause/resume/cancel
  - payment confirm/cancel
  - payment history/cancellations
  - payment webhook
- Upload
  - Worker-native multipart
  - R2 storage
  - optional SQL metadata persistence
- Admin operations
  - channel moderation
  - label admin
  - grant retry
  - dashboard
  - sync/status/export/fix
  - failed payments inspection
  - payment cancellation inspection
  - webhook audit inspection
  - webhook audit stats

Local verification already completed for this group:

- contract compare on tested read endpoints
- safe playlist write compare between legacy and worker
- username update write/read verification
- payment confirm empty-body validation parity
- billing issue-key empty-body validation parity

## Implemented, but needs deeper parity checks

- Payments
  - replay-safe webhook operations
  - failed billing inspection UX/admin workflows
  - live Toss-backed staging write verification
- Billing scheduler
  - Worker cron/manual execution exists
  - production retry/backoff and notification parity still needs staging verification
- Credit renewal
  - Worker cron/manual execution exists
  - schema-column parity needs confirmation on real DBs
- Upload metadata
  - optional table integration exists
  - exact schema and downstream consumers need verification
- Provider portability
  - mysql/postgres/d1 runtime exists
  - only mysql should currently be considered the default parity path
- Billing/create and pause/resume
  - route parity exists
  - live staging write verification still required

## Not yet parity-complete

- Provider-owned OAuth code exchange
- Blue-green Typesense alias swap and queue recovery
- Billing notification scheduler
- Channel renewal scheduler parity
- Full route-by-route response diffing against production
- job/workflow/tailored route families are intentionally out of current cutover scope

## Architectural replacement, not direct parity

- Node cron and process intervals
  - replaced by Worker `scheduled()` and planned queue/workflow design
- `multer` upload path
  - replaced by `Request.formData()` + R2
- PM2/cluster behavior
  - replaced by Cloudflare Worker deployment/runtime model
