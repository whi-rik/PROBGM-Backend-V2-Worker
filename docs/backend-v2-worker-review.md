# PROBGM-Backend-V2-Worker — 코드 리뷰

> Generated: 2026-04-22
> Scope: `PROBGM-Backend-V2-Worker` (Hono + Cloudflare Workers)
> 기준 (Source of truth): `PROBGM-Backend-TS` (Express + TypeScript)
> 핵심 원칙: **엔드포인트 / DB 스키마 불변**. Worker 런타임에 맞춘 구현 변환만 허용 (Express → Hono, multer → formData, node-cron → scheduled triggers).

---

## 1. 총평

현재 V2 Worker 는 **"프로토타입 이상, 완전 포팅 미만"** 상태로 볼 수 있음. 대다수 프론트엔드용 읽기·쓰기 경로는 커버되어 있고, 응답 봉투(envelope)·테이블 컬럼·인증 미들웨어 위치까지 정확히 레거시 계약을 따라가고 있음. 레포 내 `docs/` (20 문서) 역시 상당히 성숙해서 parity-matrix / contract-parity-gaps / cutover-readiness 축으로 이미 잘 정리됨.

그러나 **치명 누락 1건 (redeem 라우트 군 전체)** + **회귀 가능성 있는 보안/신뢰성 이슈 2-3건**이 기존 자체 문서에 명시되지 않고 남아 있어 cutover 이전에 반드시 닫아야 함.

| 항목 | 상태 |
|------|------|
| 구조 / 의존성 / wrangler 설정 | 양호 |
| Hono 라우팅 배선 (`src/index.ts`) | 양호 |
| DB 연결 lifecycle (withConnection) | **올바름** (Workers isolate 모델에 적합) |
| 응답 envelope 일치 (`success/data/message/statusCode`) | 양호 |
| 엔드포인트 path / method / auth 일치 | **1개 군 누락 (redeem)** 외 양호 |
| DB 스키마 일치 | **드리프트 없음** (검증 완료) |
| Worker 네이티브 전환 (R2 upload, cron, formData) | 의도대로 구현 |
| Toss webhook 보안 / idempotency | **위험 요소 존재** |
| 멀티 프로바이더 (mysql/postgres/d1) 추상화 | 개념적으로는 OK, d1 방언 정규화 취약 |
| 레포 자체 문서 | 양호 (아래 3절 참조) |

---

## 2. 구조 및 규모

```
PROBGM-Backend-V2-Worker/
├── src/
│   ├── index.ts          # Hono 앱 배선 + onError
│   ├── env.ts            # Bindings
│   ├── scheduled.ts      # cron 엔트리
│   ├── lib/              # db, auth, otp, promotion, toss, webhook, typesense, jobs, ...
│   ├── routes/           # 17 개 라우트 파일
│   └── types/            # 최소한의 런타임 바인딩 타입
├── scripts/              # smoke-*, compare-contract, compare-write
├── fixtures/             # 샘플 request body
├── docs/                 # 20 개 migration / parity / runbook 문서
├── wrangler.toml         # compat date 2026-04-21, nodejs_compat
└── package.json          # hono, mysql2, postgres, bcryptjs
```

라우트 핸들러 수 (대략): **170 + α**.
- cutover scope (auth/user/v3/playlists/downloads/promotion/billing/payments/upload/admin/sync): **≈ 163**
- cutover scope 밖 (jobs/workflow/tailored): ≈ 28

참고: 레포 자체 `docs/implementation-coverage.md` 에서도 같은 숫자대로 서술되어 있고, 수치 자체의 신뢰도는 높음.

---

## 3. 레포 내 `docs/` 현황 평가

이미 존재하는 문서는 아래와 같음. 각 문서의 역할은 실제로 제 기능을 하고 있었음:

| 파일 | 용도 | 상태 |
|------|------|------|
| `migration-notes.md` | 무엇을 먼저 포팅했고 무엇을 뒤로 뺐는지 | 정확함 |
| `phase-roadmap.md` | 단계별 이행 계획 | 정확함 |
| `parity-matrix.md` | 라우트 군별 ready / needs-work / not-parity 구분 | 정확함 |
| `contract-parity-gaps.md` | 응답 봉투 / 메시지 일치 현황 | 정확하나 누락 1건 있음 ↓ |
| `implementation-coverage.md` | 라우트 수 비교 | 정확함 |
| `sql-schema-examples.md` | optional 추가 테이블 (upload_metadata 등) | 유용 |
| `provider-test-matrix.md` / `provider-live-runbook.md` / `provider-decision-record-*` | mysql/postgres/d1 런타임 선택 | 유용 |
| `staging-execution-checklist.md` / `staging-write-checklist.md` / `write-compare-runbook.md` | 스테이징 검증 절차 | 유용 |
| `contract-compare-runbook.md` / `e2e-contract-check-2026-04-21.md` / `write-e2e-check-2026-04-21.md` | 레거시-워커 diff 실행 기록 | 유용, 2026-04-21 기준 |
| `admin-incident-runbook.md` | 운영 장애 대응 | 유용 |
| `cutover-readiness.md` | go/no-go 체크리스트 | 유용 |

**평가**: 문서는 정리되어 있고 잘 돌아감. 다만 아래 4절의 "숨어 있는 이슈" 가 문서에 반영되지 않아서 go/no-go 가 실제보다 낙관적으로 보일 수 있음.

---

## 4. 검증된 중요 발견

아래 항목들은 코드 직접 확인을 거친 결과. 하위 에이전트 보고 중 실제 코드와 맞지 않는 주장(예: `title` → `name` 컬럼 이름 드리프트, `playlists` 복수형 테이블 사용, grants admin 누락)은 모두 검증 과정에서 기각하고, 본 문서에는 **재검증된 것만** 싣는다.

### 4.0 [HIGH] `/user/*` vs `/api/user/*` 경로 접두사 드리프트 (2026-04-22 추가)

`scripts/endpoint-parity-check.mjs` 를 도입하면서 새로 드러난 드리프트.

- 레거시 Backend-TS: `userProvider.ts` / `userManagement.ts` 를 `/api` 아래에 mount → 최종 경로 `/api/user/info`, `/api/user/balance`, `/api/user/channel/:id`, `PUT /api/user/profile` 등 **14 개**.
- Worker: `src/routes/user.ts` 를 `""` 에 mount + 파일 내 핸들러가 `/user/info` 등 → 최종 경로 `/user/info`, `/user/balance`, ... 로 **`/api` 접두사 없음**.
- FE V2 (`PROBGM-Frontend-V2`): `/user/*` (Worker 와 일치) 로 호출 중. 문제 없음.
- FE V1 (`PROBGM-Frontend`): 일부 호출 지점에서 `/api/user/label` 를 쓰고 있음 (`lib/gtag.ts` 등에서 직접 확인됨). Worker 로 넘어가면 해당 호출은 **404 / 라우트 없음** 으로 실패.

**원칙 위반**: "엔드포인트 경로 불변" 규칙에 부분적으로 어긋남. 접두사를 드롭한 것은 Worker 저작 시점의 선택이었으나 CLAUDE.md §2.1 에 기록된 레거시 계약과 다르다.

**조치 후보**:
- 권장 A: Worker 에서 `/user/*` 와 `/api/user/*` 두 경로를 같은 핸들러로 노출 (얇은 alias). 추가 코드 ~20 줄. FE V1 무수정.
- 옵션 B: FE V1 를 `/user/*` 로 수정하고 legacy 를 은퇴시킬 때 동기화.
- 컷오버 이전 결정 필요.

**자동 감지**: `npm run parity:endpoints` 가 exit code 1 로 리포트. 조치 후 allowlist 에서 해제.

---

### 4.1 [CRITICAL] `/api/redeem/*` 5개 엔드포인트 전면 누락

- Backend-TS 는 프로모션(`promotionRoutes.ts`)과 리딤(`redeemRoutes.ts`)을 **별도 기능**으로 가지고 있음.
- `PROBGM-Backend-TS/routes/redeemRoutes.ts`:
  - `POST /api/redeem` (verifySSID)
  - `GET /api/redeem/check/:code` (rate-limited, no auth)
  - `GET /api/redeem/history` (verifySSID)
  - `GET /api/redeem/stats` (verifyAdmin)
  - `GET /api/redeem/usage/:code` (verifyAdmin)
- Worker 는 `/api/promotion/*` 만 이식했고 `/api/redeem/*` 에 해당하는 구현이 **없음** (`grep -r redeem src/` 결과 0건).
- 프론트의 "Preference → Redeem Code" 모달은 `/api/redeem/*` 를 호출한다 (`docs/redeem-code-audit.md` 참조). 즉 Worker 로 컷오버 시 **리딤 코드 기능 완전 차단**.

**원칙 위반**: "엔드포인트/스키마 불변" 규칙에 정면 반함 (누락은 드리프트의 일종).
**조치**: `src/routes/redeem.ts` 추가 + `redeem_codes` / `redeem_code_usage` 테이블 대응 쿼리 포팅 필요. 이미 존재하는 `src/lib/promotion.ts` 구조를 그대로 재사용 가능.
**참고**: 레포 자체 parity-gaps 문서에 redeem 언급이 전혀 없음 → 문서 업데이트 동반 필요.

### 4.2 [HIGH] Toss Webhook 서명 검증이 환경변수에 따라 무력화됨

- `src/routes/payments.ts:1682-1685`
  ```ts
  const webhookSecret = c.env.TOSS_WEBHOOK_SECRET?.trim();
  if (webhookSecret) {
    ...
    if (!(await verifyWebhookSignature(rawBody, signature, webhookSecret))) { ... }
  }
  ```
- `TOSS_WEBHOOK_SECRET` 가 비어 있으면 **서명 체크를 건너뛴다**. 설정 실수 = 무인증 웹훅 허용.
- Backend-TS 는 `verifyTossWebhookSignature` 미들웨어를 무조건 붙임 (`paymentsRoutes.ts:745`).
**조치**: production 환경에서는 시크릿 미설정 시 **fail-closed (5xx)** 하도록 바꾸고, development/staging 에서만 bypass 옵션 허용. 또는 `APP_ENV !== "development"` 일 때 반드시 secret 요구.

### 4.3 [HIGH] Webhook Idempotency 없음

- `src/routes/payments.ts:1668-1805` 흐름에서 `webhook.id` 기반 중복 처리 방지 로직이 보이지 않음 (`webhook.id || crypto.randomUUID()` 를 fallback 으로 쓰는 라인 존재 → idempotency key 없을 수 있음을 시인하고 있음).
- Toss 는 같은 이벤트를 리플레이할 수 있으므로, 동일 `eventId`/`paymentKey` 조합에 대해 멱등 처리 필요.
**조치**: `PAYMENT_WEBHOOK_AUDIT_TABLE` 에 이미 쓰도록 설계되어 있음 → 여기에 `eventId` UNIQUE 인덱스 두고 선삽입 → 중복 시 early-return 200. 레포 자체 `sql-schema-examples.md` 에 스키마 초안을 추가 권장.

### 4.4 [MEDIUM] Billing 관리 엔드포인트 3종 부재

Backend-TS 는 아래 엔드포인트를 사람이 호출해서 cron을 수동 트리거할 수 있게 해 둠:
- `POST /api/billing/process/pending`
- `POST /api/billing/process/expired-memberships`
- `GET /api/billing/cron/status`

Worker 는 Cloudflare Workers `scheduled()` 트리거 (`src/lib/jobs.ts`) 로 **자동 실행**으로 대체했으나 **수동 트리거 엔드포인트를 만들지 않았음**. 운영팀이 "지금 당장 밀린 과금 한 번 돌려줘" 를 할 수단이 없음.
**조치**: 동일 경로를 그대로 포트하거나, admin 전용 `/api/admin/billing/run` 같은 명시적 대체 엔드포인트 + `admin-incident-runbook.md` 보강.

### 4.5 [MEDIUM] 쿠키 기반 세션 fallback 없음

- Backend-TS 는 `Bearer` 헤더 + 쿠키 양쪽을 받는다.
- `src/lib/auth.ts` 는 `Authorization: Bearer <ssid>` 만 파싱.
- 프론트 V2 가 bearer-only 로 전환되었다면 문제 없음. 프론트 V1 혹은 외부 통합이 쿠키에 의존한다면 컷오버 시 로그아웃 폭발 가능.
**조치**: 프론트 V1/V2 의 실제 호출 방식 확인. 쿠키 의존 발견 시 Hono 미들웨어에 `cookie` → `Authorization` 승격 로직 추가.

### 4.6 [MEDIUM] `scheduled()` 에러 핸들링 취약

- `src/scheduled.ts` 가 `runScheduledJob` 호출을 try/catch 로 감싸지 않음. 실패 시 로그 한 줄 없이 종료, Workers 재시도 시그널 손실.
**조치**: try-catch + `console.error` + 실패 시 re-throw (Cloudflare 쪽 재시도 정책을 타도록).

### 4.7 [LOW] d1 프로바이더 방언 정규화 과도하게 느슨

- `src/lib/db.ts`
  - `NOW()` → `CURRENT_TIMESTAMP`
  - `TRUE`/`FALSE` → `1`/`0`
  - SELECT 판별을 정규식 `isReadQuery()` 으로 수행 (CTE `WITH ... UPDATE` 같은 쓰기 쿼리를 읽기로 오판할 수 있음)
- 현재 d1 은 "실험적 옵션"일 뿐이고 default 는 mysql 이라 **지금은 위험 없음**. 다만 누가 실수로 `DB_PROVIDER=d1` 로 스테이징에 돌리면 조용히 잘못된 결과가 나올 수 있음.
**조치**: d1 경로를 `APP_ENV=production` 에서 아예 거부(fail-fast) 하거나, d1 테스트 격리 환경에만 허용. 해당 의사결정은 `provider-decision-record-draft.md` 에 명시.

---

## 5. DB 스키마 — 드리프트 없음 (재검증)

다음 테이블/컬럼은 두 레포 모두 동일한 이름·의미로 사용 중임을 직접 grep 으로 확인:

| 테이블 | 검증 컬럼 | Backend-TS 사용처 | Worker 사용처 |
|--------|-----------|--------------------|----------------|
| `users_tokens` | `token`, `token_type`, `issued_in`, `is_expire`, `last_activity`, `client_ip`, `user_agent` | `classes/Auth.ts:167,204` | `src/lib/auth.ts:173,188` |
| `playlist` (단수) | `id`, `user_id`, `title`, `description`, `is_hide`, `is_default`, `is_public`, `created_in`, `updated_at`, `like_count` | `classes/Playlist.ts:139,658,686` | `src/routes/playlists.ts:617,718,734` |
| `playlist_music` (단수) | `playlist_id`, `music_id`, `added_at`, `sort_order`, `custom_title` | `classes/Playlist.ts:187,1846` | `src/routes/playlists.ts:515` |
| `users_permission` | `permission_id`, `user_id`, `asset_id`, `format`, `issued_in`, `is_expired` | `classes/Permission.ts:93,122,324` | `src/routes/download.ts:92-101` |
| `billing_cycles` | `customer_key`, `billing_key`, `cycle_type`, `status`, `next_billing_date`, `retry_count` 등 | `routes/billingRoutes.ts` | `src/routes/billing.ts` |
| `payments` | `payment_key`, `order_id`, `customer_key`, `billing_key`, `is_billing`, `toss_payment_data` | legacy | `src/routes/payments.ts` |
| `payment_cancellations` | `payment_id`, `cancel_amount`, `cancellation_type`, `status`, `transaction_key` | legacy | `src/routes/payments.ts` |
| `music_tags` / `tags_list` | 태그 조인 구조 | legacy | `src/routes/v3.ts:90` |

주의:
- 백엔드-TS 의 `userStatsHelper.ts` / `adminDashboardHelper.ts` 에 `FROM playlists` (복수형) 및 `is_deleted` 를 사용하는 잔존 SQL 이 있음. `classes/Playlist.ts` (실제 쓰기 경로) 는 `playlist` + `is_hide` 를 쓰므로, 복수형 참조는 legacy 내부 dead/stale code 로 보임. Worker 는 정상적으로 `playlist` + `is_hide` 만 사용. 별개 이슈로 백엔드-TS 쪽을 정리하는 것은 이 리뷰 범위 밖.

결론: **DB 스키마 측면에서 Worker 가 레거시 스키마를 변경하거나 추가 요구하는 부분은 없음.** upload_metadata / payment_webhook_audit 같은 Worker-전용 옵션 테이블은 `UPLOAD_METADATA_TABLE` / `PAYMENT_WEBHOOK_AUDIT_TABLE` 환경 변수로 **완전히 선택적**으로 유지되어 있으므로 "스키마 불변" 원칙을 위배하지 않음.

---

## 6. Workers 런타임 설계 — 평가

양호한 지점:
- `src/lib/db.ts:withConnection()` — 요청 스코프 오픈/파이널리 클로즈. Workers isolate 에 정합.
- `postgres.js` max pool 을 **1** 로 고정 (`src/lib/db.ts`). Workers 특성상 연결 재사용 불가한 현실 반영.
- 업로드 경로: `Request.formData()` + `R2.put()` + 선택적 SQL 메타데이터. multer 의존 제거, size/mime allow-list 있음 (`src/routes/upload.ts:127-134`).
- `bcryptjs` 사용 — 네이티브 `bcrypt` 회피로 Workers 호환.
- `crypto.randomUUID()` 사용 — Workers 네이티브.
- 응답 봉투 (`src/lib/response.ts`): 레거시 `ApiResponse` 와 키 순서까지 맞춤.
- 에러 핸들러 (`src/index.ts:29-57`): HTTPException → `legacyHttpFailure`, 그 외 → `failure`. 일관성 있음.
- 어드민 경로: `requireAdminSessionFromRequest` 를 모든 admin/v2-admin/sync 핸들러가 동일하게 호출 (레거시 `verifyAdmin` 미들웨어와 등가).

개선 여지:
- 시크릿을 `Bindings` (일반 env) 에 섞어 둠 — Cloudflare Secrets binding 분리 권장.
- `scheduled()` 에러 핸들링 (위 4.6).
- d1 dialect shim 의 경계 (위 4.7).
- `UPLOAD_METADATA_TABLE` / `PAYMENT_WEBHOOK_AUDIT_TABLE` 표 정의가 문서 예시에만 있고 실제 migrations 파일이 없음 — 스테이징 배포 시 DBA 수동 작업 필요. 별도 SQL 파일 `migrations/worker-optional/*.sql` 로 승격 권장.

---

## 7. Cutover 전 해야 할 일 (우선순위)

| 순위 | 항목 | 예상 | Blocker? |
|------|------|------|----------|
| P0 | `/api/redeem/*` 5개 엔드포인트 포팅 + 레포 parity 문서 업데이트 | 0.5-1d | **예** |
| P0 | Toss webhook 서명 검증 fail-closed 강제 (production) | 1h | **예** |
| P1 | Webhook idempotency (eventId UNIQUE + pre-insert) | 3-4h | 권장 |
| P1 | Billing 수동 트리거 엔드포인트 3종 또는 대체 admin API 1종 복구 | 2h | 권장 |
| P1 | Frontend V1/V2 쿠키 세션 의존 여부 점검 → 필요 시 cookie fallback | 0.5d | 프론트 의존 시 예 |
| P2 | `scheduled()` try/catch + 로깅 | 30m | 아니오 |
| P2 | d1 프로바이더 production 거부 가드 | 30m | 아니오 |
| P2 | optional table 스키마를 실제 SQL migration 파일로 승격 | 1h | 아니오 |

---

## 8. 결론

구현 품질과 문서화 모두 cutover 수준을 목전에 두고 있음. 특히 스키마 불변·응답 불변 측면에서 의도가 코드에 정직하게 반영되어 있고, 레거시 `classes/Playlist.ts` / `classes/Auth.ts` / `classes/Permission.ts` 의 테이블·컬럼을 그대로 사용하고 있어 **DB 마이그레이션 없이 Worker 를 붙일 수 있는 상태**.

그럼에도 불구하고 (a) redeem 기능 군 누락, (b) 웹훅 보안/멱등성 공백 두 가지는 go-live 전에 반드시 닫아야 하며, 나머지는 P1/P2 로 정리하면 안전하게 트래픽 일부 (read-heavy) 부터 Worker 로 넘길 수 있음. 레포 자체 `cutover-readiness.md` 의 "Do not cut over if …" 리스트에 **redeem 기능 parity** 와 **webhook 서명 필수** 두 줄을 추가하는 문서 개정도 같이 권함.
