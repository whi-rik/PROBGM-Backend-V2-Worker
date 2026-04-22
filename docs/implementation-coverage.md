# Backend V2 Worker Implementation Coverage

This document compares the current `PROBGM-Backend-V2-Worker` implementation against the existing `PROBGM-Backend-TS`.

The goal is not to claim one-to-one route parity from raw route counts alone. The Worker consolidates some route families and also adds extra diagnostics and admin inspection routes that do not exist in exactly the same form in the legacy backend.

## 1. Headline numbers

Legacy backend route count, broad total:

- `PROBGM-Backend-TS/routes`: about `283` route handlers

Worker route count, broad total:

- `PROBGM-Backend-V2-Worker/src/routes`: about `191` route handlers

Worker route count, current cutover scope only:

- excluding `jobs`, `workflow`, `tailored`: about `163` route handlers

Legacy backend route count, current cutover-comparable family set:

- auth
- discovery
- user/account
- playlists
- promotions
- billing/payments
- upload
- v2 admin
- sync
- related search/music families used by frontend and admin

Comparable legacy total for that set:

- about `137` route handlers

Interpretation:

- The Worker already covers a large portion of the route families needed for the current cutover.
- The Worker count is higher than the comparable legacy cutover subset because it includes:
  - extra diagnostics
  - provider health routes
  - payment admin inspection routes
  - Worker-specific storage/runtime verification routes
- This does not mean the Worker is fully parity-complete. It means the current cutover scope is already broad.

## 2. Current cutover scope

Included now:

- auth/session
- v3 discovery
- user/account/channel
- playlists
- downloads
- promotions
- billing/payments
- upload
- admin moderation
- label/grant admin
- sync admin
- payment admin inspection
- provider/runtime diagnostics

Excluded now:

- jobs
- workflow
- tailored
- cron rollout
- provider-owned OAuth code exchange
- blue-green Typesense alias swap

## 3. Route family comparison

### Auth

Legacy reference:

- `routes/authProvider.ts`: `11`
- `routes/otpAuth.ts`: `8`
- total reference slice: `19`

Worker:

- `src/routes/auth.ts`: `19`

Status:

- strong parity for current frontend needs
- local auth, OTP, social callback/session parity are present
- provider-owned OAuth code exchange remains excluded

### Discovery

Legacy reference:

- `routes/v3/assetRoutes.ts`: `6`
- `routes/v3/tagRoutes.ts`: `5`
- `routes/sub/searchRoutes.ts`: `8`
- `routes/sub/musicRoutes.ts`: `10`
- total reference slice: `29`

Worker:

- `src/routes/v3.ts`: `24`

Status:

- broadly covered
- Worker consolidates discovery behavior into fewer files
- response parity still needs staging verification on edge cases

### User and account

Legacy reference:

- `routes/userProvider.ts`: `14`
- `routes/userManagement.ts`: `6`
- total reference slice: `20`

Worker:

- `src/routes/user.ts`: `17`

Status:

- largely covered for current frontend flows
- includes profile, stats, balances, channels, social bind/unbind, account delete

### Playlists

Legacy reference:

- `routes/sub/playlistRoutes.ts`: `22`
- `routes/v2/playlistRoutes.ts`: `8`
- total reference slice: `30`

Worker:

- `src/routes/playlists.ts`: `18`
- `src/routes/v2-playlists.ts`: `9`
- total: `27`

Status:

- strong coverage
- create/add/remove/update/delete/reorder/custom-title/duplicate/like/category/popular are present
- good candidate for real staging write verification

### Promotions

Legacy reference:

- `routes/promotionRoutes.ts`: `4`

Worker:

- `src/routes/promotion.ts`: `7`

Status:

- beyond minimum parity for current scope
- Worker includes extra operational filtering and admin usage inspection

### Redeem

Legacy reference:

- `routes/redeemRoutes.ts`: `5`

Worker:

- `src/routes/redeem.ts`: `5`

Status:

- full 1:1 parity restored in the 2026-04-22 improvement pass
- reward granting uses `grantRedeemMembership`, `addBonusCredits`, `addBonusDownloadPoints` in `src/lib/membership.ts`
- schema unchanged: Worker reads/writes `redeem_codes` and `redeem_code_usage` exactly like legacy
- rate limiting on `/redeem/check/:code` is not implemented in-app (legacy uses Express rate-limit). Attach via Cloudflare WAF / rate-limit rules at the edge

### Billing and payments

Legacy reference:

- `routes/billingRoutes.ts`: `10`
- `routes/paymentsRoutes.ts`: `9`
- total reference slice: `19`

Worker:

- `src/routes/billing.ts`: `7`
- `src/routes/payments.ts`: `15`
- total: `22`

Status:

- strong coverage for current cutover
- Worker includes extra inspection routes:
  - failed payments
  - cancellations
  - webhook audit
  - webhook audit stats
- webhook replay/audit workflow parity is still not fully complete

### Upload

Legacy reference:

- `routes/fileUploadRoutes.ts`: `2`

Worker:

- `src/routes/upload.ts`: `4`

Status:

- functionally covered
- implementation is intentionally different
  - legacy: `multer`
  - Worker: `formData() + R2`

### Admin moderation and maintenance

Legacy reference:

- `routes/v2/labelAdminRoutes.ts`: `5`
- `routes/v2/adminGrantRoutes.ts`: `3`
- `routes/syncRoutes.ts`: `6`
- additional moderation/admin routes are distributed elsewhere

Worker:

- `src/routes/admin.ts`: `8`
- `src/routes/v2-admin.ts`: `8`
- `src/routes/sync.ts`: `19`

Status:

- operationally stronger than the bare minimum cutover need
- Worker adds diagnostics and inspection endpoints that help staging and incident response

## 4. Deferred families

These route families exist in the Worker but are intentionally outside the current cutover scope.

Legacy reference:

- `routes/newTailoredRoute.ts`: `16`
- `routes/jobWorkflowRoutes.ts`: `10`
- `routes/creditRenewalRoutes.ts`: `4`
- `routes/healthRoute.ts`: `5`

Worker:

- `src/routes/tailored.ts`: `16`
- `src/routes/workflow.ts`: `5`
- `src/routes/jobs.ts`: `7`
- `src/routes/health.ts`: `6`

Interpretation:

- There is already meaningful experimental work in these families.
- They are explicitly excluded from the current cutover because they need different rollout and verification standards.
- Their existence in code should not be read as “approved for production cutover”.

## 5. Practical coverage conclusion

For the current cutover target, the Worker is:

- broad in surface area
- strong in frontend-facing account/discovery/playlist/payment support
- stronger than legacy in diagnostics and incident inspection
- intentionally incomplete in workflow/tailored/job orchestration

Operationally, the Worker is best described as:

- ready for focused staging verification on the current cutover scope
- not yet full replacement for every legacy backend route family

## 6. What still needs real proof

Even where route coverage is strong, the following still require staging proof:

- playlist write parity
- payment confirm/cancel/webhook parity
- download entitlement parity
- upload metadata persistence behavior
- mysql vs postgres vs d1 provider behavior against the real schema

## 7. Recommended interpretation rule

Use route counts only as a rough signal.

For go/no-go decisions, trust these documents more:

- [docs/cutover-readiness.md](./cutover-readiness.md)
- [docs/provider-live-runbook.md](./provider-live-runbook.md)
- [docs/provider-decision-record-draft.md](./provider-decision-record-draft.md)
