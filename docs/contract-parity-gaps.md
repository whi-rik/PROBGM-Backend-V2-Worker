# Contract Parity Gaps

Legacy baseline: `PROBGM-Backend-TS`

Target: `PROBGM-Backend-V2-Worker`

## Goal

Current priority is not "feature count parity" but "contract parity" for the current cutover scope.

That means the Worker should match the legacy backend closely enough in:

- endpoint path
- request body keys
- query parameter names
- response envelope
- important response data keys
- user-visible success/error message shape where the frontend depends on it

## Aligned In This Pass

### Common response envelope

- Worker responses now follow legacy `ApiResponse` more closely:
  - `success`
  - `data`
  - `message`
  - `statusCode`

### Auth / OTP

- `/api/auth/register`
- `/api/auth/verify`
- `/api/auth/login`
- `/api/auth/me`
- `/api/auth/isLogged`
- `/api/auth/check`
- `/api/auth/logout`
- `/api/auth/signout`
- `/api/auth/refresh`
- `/api/auth/newbie/check`
- `/api/auth/newbie/confirm`
- `/api/auth/otp/check-email`
- `/api/auth/otp/register/request`
- `/api/auth/otp/register/verify`
- `/api/auth/otp/login/request`
- `/api/auth/otp/login/verify`
- `/api/auth/otp/resend`
- `/api/auth/otp/verify`
- `/api/auth/otp/stats`

Notable fixes:

- social verify now returns legacy-style `SOCIAL_USER_NOT_FOUND` payload
- success messages were shifted toward legacy wording
- `/auth/me` and `/auth/isLogged` now expose `isNewbie` instead of the previous Worker-only shape
- `register` / `verify` invalid-provider and required-field validation messages were moved closer to the legacy controller wording
- OTP validation/error messages were moved closer to the legacy controller wording
- `logout` / `signout` now succeed even if session invalidation itself fails, matching legacy behavior more closely

### User / Account

- `/user/info`
- `/user/balance`
- `/user/credits`
- `/user/membership`
- `/user/downloadPoint`
- `/user/stats`
- `/user/channels`
- `/user/channel/:id`
- `/user/channel`
- `/user/channel/:id`
- `/user/channel/:id/auto-renewal`
- `/user/channel/:id/verify`
- `/api/user/profile`
- `/api/user/username`
- `/api/user/check-social-binding`
- `/api/user/bind-social`
- `/api/user/unbind-social`
- `/api/user/account`

Notable fixes:

- `/api/user/profile` now matches legacy more closely for `balance.downloadPoints` and `membership.tier`
- user stats now returns the legacy success message
- channel update / auto-renewal / verify / delete not-found and validation messages were shifted toward legacy Korean responses
- social binding endpoints now validate missing provider/socialId and invalid providers using legacy-style messages more closely

### Discovery

- `/api/v3/tags`
- `/api/v3/tags/stats`
- `/api/v3/tags/search`
- `/api/v3/tags/:type`
- `/api/v3/assets/list`
- `/api/v3/assets/search`
- `/api/v3/assets/:id`

Notable fix:

- `/api/v3/assets/list` now respects legacy `p/page` semantics better

### Playlists

- `/api/playlists`
- `/api/playlists/public`
- `/api/playlists/accessible`
- `/api/playlists/mine`
- `/api/favoriteId`
- `/api/playlist`
- `/api/playlist/add`
- `/api/playlist/remove`
- `/api/playlist/:id`
- `/api/playlist/:id/musics`
- `/api/playlist/:id/favorite`
- `/api/playlist/:id`
- `/api/playlist/:id/restore`
- `/api/playlist/:id/hard`
- `/api/playlist/:id/music/:musicId/custom-title`
- `/api/playlist/:id/permissions`
- `/api/playlist/:id/metadata`
- `/api/playlist/:id/metadata/:key`
- `/api/playlist/publicItems`
- `/api/v2/playlist/:id/reorder`
- `/api/v2/playlist/:id/music/:musicId/order`
- `/api/v2/playlist/:id/like`
- `/api/v2/playlists/liked`
- `/api/v2/playlists/popular`
- `/api/v2/playlists/category/:category`
- `/api/v2/playlist/:id/duplicate`
- `/api/v2/playlist/:id/cover`

Notable fixes:

- playlist permission failures were shifted away from generic `403 English` responses toward legacy-style Korean validation errors
- playlist metadata and permission endpoints now return not-found errors more consistently
- `/api/playlist/:id/musics` now returns the legacy empty payload/message for `null` or `undefined` playlist ids
- `restore` and `publicItems` permission failures were moved toward legacy `400 ValidationError` behavior

### Redeem

- `/api/redeem`
- `/api/redeem/check/:code`
- `/api/redeem/history`
- `/api/redeem/stats`
- `/api/redeem/usage/:code`

Notable:

- reward granting stays transactional with code usage (membership + bonus credits + bonus download points)
- membership type → tier mapping is identical to legacy (`basic→1`, `pro→2`, `premium→3`, `edu→4`, `dev→5`)
- `current_uses` is incremented inside `FOR UPDATE` transaction
- admin-only endpoints enforce `requireAdminSessionFromRequest` like legacy `verifyAdmin`

### Payments / Billing

- `/api/payments`
- `/api/payments/confirm`
- `/api/payments/test/membership`
- `/api/payments/:paymentKey`
- `/api/payments/:paymentKey/cancellations`
- `/api/payments/user/history`
- `/api/payments/user/history-with-cancellations`
- `/api/payments/user/cancellations`
- `/api/payments/webhook`
- `/api/billing/issue-key`
- `/api/billing/create`
- `/api/billing/:id`
- `/api/billing/:id/pause`
- `/api/billing/:id/resume`
- `/api/billing/user/cycles`

Notable fixes:

- payment detail / confirm / cancel responses now use legacy-style camelCase payloads more closely
- payment history endpoints now return plain `success + data` envelopes like the legacy controllers
- billing read / pause / resume / create endpoints now follow the simpler legacy response style more closely

## Known Remaining Gaps

These are the important remaining contract risks inside the current cutover scope.

### 1. Some success/error messages are still not byte-for-byte legacy

Examples:

- some auth and playlist messages are close but not guaranteed identical
- payment/admin inspection endpoints are Worker-specific and intentionally not legacy-identical

Impact:

- low for backend behavior
- medium if frontend code compares messages literally

### 2. Payment and billing response payloads are closer now, but not fully audited line-by-line

Examples:

- timestamp placement
- some nested field naming in admin/payment inspection responses
- some optional fields may be omitted when legacy would include `null`
- some payment history and billing cycle rows still need live comparison for exact optional field presence

Impact:

- medium

### 3. Playlist metadata / restore / hard delete were added for parity but need staging verification

Worker implementations follow legacy route contracts closely, but they were not yet validated against real data in staging.

Impact:

- medium

### 4. `/api/v3/assets/search` is functionally similar, but source and fallback behavior are Worker-native

The response shape is close enough for current frontend usage, but internal ranking/fallback behavior is not guaranteed to match legacy exactly.

Impact:

- medium

### 5. Optional fields and nullability still need live comparisons

Most likely spots:

- user profile fields
- social binding helper responses
- payment cancellation nested objects
- billing cycle optional dates
- playlist metadata values

Impact:

- medium

## Out Of Current Cutover Scope

These are intentionally excluded from the current parity target:

- jobs routes
- workflow routes
- tailored routes

Code may exist in the Worker repository, but those families are not part of the current cutover decision.

## Next Recommended Checks

1. run `npm run compare:contract` against legacy and worker staging URLs
   - follow [contract-compare-runbook.md](./contract-compare-runbook.md)
2. confirm `null` vs omitted field behavior on payment and billing endpoints
3. confirm frontend-critical endpoints:
   - `/api/auth/me`
   - `/api/playlists`
   - `/api/playlist/:id/musics`
   - `/api/payments`
   - `/api/payments/confirm`
   - `/api/payments/:paymentKey`
   - `/api/payments/:paymentKey/cancellations`
   - `/api/billing/create`
