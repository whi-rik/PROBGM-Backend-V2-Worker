# PROBGM-Backend-V2-Worker — Test Strategy

> Generated: 2026-04-22
> Scope: `PROBGM-Backend-V2-Worker`
> Baseline: `PROBGM-Backend-TS` (contract-equivalent source of truth)
> Goal: 테스트가 "엔드포인트 계약·DB 스키마 불변" 을 실제로 보장하게 한다.

이 문서는 cutover 이전·이후 모두를 커버하는 테스트 전략을 규정한다. 기존 레포에 이미 존재하는 `scripts/smoke-*`, `scripts/compare-*` 인프라를 정식 레이어로 승격하고, 부족한 층(유닛·트랜잭션 단계 통합·CI 게이트) 을 명시한다.

---

## 1. 핵심 원칙

| 원칙 | 의미 |
|------|------|
| **Contract first** | 응답 `{success/data/message/statusCode}` 봉투, 에러 메시지, 상태 코드, 쿼리·바디 키가 legacy 와 동일해야 테스트 pass. 내부 구현 방식은 자유. |
| **Schema locked** | Worker 가 건드리는 테이블·컬럼은 legacy 와 동일. 스키마 드리프트를 탐지하는 테스트는 필수. |
| **Production-like path** | 가능한 한 실제 MySQL/R2/Typesense/Toss sandbox 를 사용. 레거시 mock 으로 덮이면 컷오버 시 터진다. |
| **Fast loop + hard gate** | 로컬/PR 에서는 빠른 typecheck + 유닛. cutover 이전에는 느리더라도 staging 컨트랙트 비교를 `npm run compare:contract` / `compare:write` 로 반드시 통과. |
| **Idempotency by test** | 웹훅·리딤·크론 같은 "두 번 실행되면 터지는 흐름" 은 동일 입력 두 번 실행 테스트를 반드시 가진다. |

---

## 2. 테스트 피라미드

```
          e2e / contract compare  (legacy vs worker, live DB)
        ───────────────────────────────
       staging smoke (smoke-live / smoke-admin / smoke-write)
     ─────────────────────────────────────
    integration (Miniflare + MariaDB docker, 단일 route 군)
   ────────────────────────────────────────
  unit (pure functions in src/lib/*)
 ─────────────────────────────────────
typecheck (tsc --noEmit)
```

위쪽으로 갈수록 느리고 비싸지만 신뢰도 높음. 아래쪽은 모든 PR 에서 돌리고, 위쪽은 cutover 직전 / nightly / release gate 로 돌린다.

---

## 3. 레이어별 정의

### 3.1 Layer 0 — Typecheck

- 도구: `tsc --noEmit` (`npm run typecheck`)
- 범위: 전 소스
- 언제: 모든 PR, 모든 로컬 save-after-change
- Fail 정책: 한 줄이라도 에러 → CI block
- 현재 상태: **구축 완료, 활용 중**

### 3.2 Layer 1 — Unit

- 도구 후보: `vitest` (Workers 호환 좋음. `node --test` 도 가능)
- 대상: `src/lib/*` 중 **DB 접근이 없는** 순수 함수
  - `src/lib/membership.ts` → `parsePlanFromOrderName`, `redeemMembershipTypeToTier`, `getMembershipCredits`, `getMembershipDownloadPoints`
  - `src/lib/promotion.ts` → `parseApplicablePlans`, `discountAmountFor`
  - `src/lib/redeem.ts` → `normalizeRedeemCode`
  - `src/routes/redeem.ts` → `reasonToMessage`, `remainingUses`
  - `src/lib/webhook.ts` → `verifyWebhookSignature` (crypto), `validateWebhookTimestamp`
  - `src/lib/response.ts` → `success`, `failure`, `legacyHttpFailure`
  - `src/lib/db.ts` → `getProvider`, `convertQuestionParamsToPg`, `normalizeSqlForD1`, `isReadQuery`
- 대상 밖: DB/네트워크/Bindings 에 의존하는 경로. 이건 Layer 2 로.
- 기준:
  - 각 파일당 최소 1개 유닛 (각 public export 는 이상적으로 1개)
  - 계약에 영향 주는 분기(예: `redeemMembershipTypeToTier` 의 `premium → MASTER`) 는 **반드시** 가진다
  - `discountAmountFor` 는 FIXED/PERCENTAGE 경계값(0/100/음수/초과) 표 기반 테스트
- 실행: `npm run test:unit` (신규 스크립트로 추가 권장)
- 속도 목표: 전체 <2s

### 3.3 Layer 2 — Integration (Miniflare + 실제 MariaDB)

Worker 를 Miniflare 로 기동하고 **실제 MariaDB 컨테이너** 에 연결. route 1 개씩 살펴보는 단계.

- 도구:
  - `miniflare` 또는 `wrangler dev --local` 로 Worker 기동
  - `docker compose`(repo root 의 MariaDB 23306 포트) 재사용 또는 전용 test DB
  - `vitest` + `fetch()` 기반 request 작성 권장
- 커버할 Seam:
  - `src/routes/*` 핸들러 레벨 (라우팅 + 세션 + DB + 응답 envelope)
  - 트랜잭션 무결성 (redeem `FOR UPDATE` 동시성, 결제 confirm 유실)
  - Worker 전용 런타임 변환 (formData 업로드, R2 mock, Toss mock)
- 필수 케이스 (최소):

  | 영역 | 케이스 |
  |------|--------|
  | Auth | Bearer 만료 → 401, 잘못된 토큰 → 401, 정상 세션 → 200 |
  | Redeem | POST `/redeem` 멀티 reward (combo), 같은 유저 재사용 → 400, 동시 두 요청 중 하나만 성공 |
  | Redeem | GET `/redeem/check/:code` 만료 코드 / 사용량 초과 / 정상 코드 3케이스 |
  | Playlist | 생성 → 추가 → 재정렬 → 삭제(soft) → 복원 → 하드삭제. legacy 와 응답 shape 동일 |
  | Billing | issue-key → create → pause → resume → delete 상태 전이, 잘못된 전이 → 400 |
  | Payments | confirm 후 DB 상태, 두 번째 confirm 호출 → 멱등 또는 명시적 에러 |
  | Webhook | 같은 `webhook_id` 두 번 → 두 번째는 `idempotent: true` 로 return. 본문 다른데 동일 id → 첫 처리 결과 고정 |
  | Webhook | `APP_ENV=staging` + secret 미설정 → 503 |
  | Promotion | 코드 validate + 결제 confirm 내에서 사용 기록 + `current_uses` 증가 |
  | Admin | 비관리자 → 403, 관리자 → 200 |
  | Provider guard | `APP_ENV=production` + `DB_PROVIDER=d1` → withConnection 에서 throw |

- 실행: `npm run test:integration` (신규, docker compose up → vitest → down)
- 속도 목표: <90s. 90s 넘으면 병렬화 또는 케이스 축소.

### 3.4 Layer 3 — Staging Smoke (기존 스크립트)

레포에 이미 있는 5 개 스크립트를 정식 레이어로 승격:

| 스크립트 | 용도 |
|----------|------|
| `scripts/provider-smoke.sh` | `/health`, `/health/db`, `/health/storage`, `/health/schema` 확인. `SMOKE_EXPECT_PROVIDER=mysql\|postgres\|d1` 로 provider 검증 |
| `scripts/smoke-live.sh` | 로그인 후 읽기 중심 엔드포인트 정상 응답 확인 (auth, discovery, playlists, payments history, download list) |
| `scripts/smoke-admin.sh` | 관리자 계정으로 `/api/admin/*` 응답 확인 (failed payments, webhook audit, 필요 시 promotion usage) |
| `scripts/smoke-write.sh` | 안전한 write 흐름 (playlist create/add/remove, username update, billing issue-key 빈바디 validation, payment confirm 빈바디 validation) |
| `scripts/compare-write.sh` | legacy vs worker 동시 호출 → diff |

신규 추가 권장:

- `scripts/smoke-redeem.sh` — test-only redeem 코드 2종(combo / 만료) 을 seed 후 POST /redeem 성공/실패 → `/redeem/history` 확인. 실제 유저 balance 와 membership 값 변화 확인.
- `scripts/smoke-webhook-idempotency.sh` — curl 로 동일 body 2 회 POST → 두 번째 응답에 `idempotent: true`.

실행: 모두 `BASE_URL`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`, `SMOKE_ADMIN_EMAIL` 등 env 로 파라미터화.

속도 목표: 각 스크립트 <60s.

### 3.5 Layer 4 — Contract Compare (legacy vs worker)

- 도구: `scripts/compare-contract.mjs`, `scripts/compare-write.sh`
- 방식: 같은 SSID / 같은 요청으로 legacy / worker 양쪽을 치고, 응답 봉투·본문 key 집합·값 shape 을 diff
- 범위:
  - 프론트 의존 핵심 엔드포인트 (`/api/auth/me`, `/api/playlists`, `/api/playlist/:id/musics`, `/api/payments`, `/api/payments/confirm`, `/api/payments/:paymentKey`, `/api/payments/:paymentKey/cancellations`, `/api/billing/create`)
  - **신규: redeem 5 엔드포인트** (이 레이어 추가 필수)
- Pass 기준:
  - 최상위 `success/message/statusCode` 완전 일치
  - `data` 객체 key 집합 동일 (값은 타입 / null 허용 여부까지)
  - 에러 시 `message` 가 프런트에서 literal compare 하는 부분만큼은 identical
- 실행: 주로 수동 / release 전 blocking step.

### 3.6 Layer 5 — E2E (Frontend → Worker → DB)

- 도구: `PROBGM-Frontend-V2` 의 react-router e2e 혹은 Playwright (별도 레포에서 이미 보유)
- 범위: 리딤 모달 · 결제 체크아웃 · 플레이리스트 CRUD · 다운로드 플로우 골든 패스
- 실행: staging URL 을 Worker 로 가리키고 수동/야간. cutover 전 최소 1 회 green 확인.

---

## 4. 교차 관심사 (Cross-cutting)

### 4.1 DB 스키마 드리프트 탐지

- **정기 체크**: `scripts/schema-parity-check.sh` (신규) 작성 권장
  1. legacy DB 의 `information_schema.columns` 에서 cutover scope 내 테이블 컬럼 덤프
  2. Worker 가 실제로 사용하는 컬럼 grep 결과와 교차
  3. Worker 코드가 참조하는 컬럼이 legacy 에 없거나 type 변이 있으면 fail
- **필수 대상 테이블**: `users`, `users_tokens`, `users_balance`, `users_membership`, `users_transaction`, `playlist`, `playlist_music`, `users_permission`, `billing_cycles`, `payments`, `payment_cancellations`, `promotion_codes`, `promotion_code_usage`, `redeem_codes`, `redeem_code_usage`, `user_channels`, `channel_verifications`
- **옵션 테이블** (Worker 전용): `worker_upload_metadata`, `worker_payment_webhook_audit` — legacy 에 없어도 OK 이나 env 가 설정된 경우 Worker 쪽에서는 반드시 존재해야 함

### 4.2 엔드포인트 드리프트 탐지

- **정기 체크**: `scripts/endpoint-parity-check.mjs` (신규)
  1. legacy `routes/*.ts` 의 `router.(get|post|put|delete|patch)(...)` 패턴을 전부 추출
  2. Worker `src/routes/*.ts` 의 Hono `routes.(get|post|...)(...)` 패턴을 전부 추출
  3. "cutover scope" allow-list 기준으로 양쪽 교집합 차집합 차이를 리포트
- 현재 `docs/implementation-coverage.md` 의 숫자는 수동 카운팅. 이걸 자동화로 대체.

### 4.3 멱등성 (Idempotency) 테스트

다음 흐름은 **반드시** "두 번 실행" 테스트를 가진다:

| 흐름 | 기대 동작 |
|------|-----------|
| Toss webhook 리플레이 | 2회차는 `idempotent: true` 응답, DB 변화 없음 |
| `/api/payments/confirm` 중복 호출 | 2회차는 이미 confirm 된 상태로 안전한 응답 (legacy 거동 확인 필요) |
| `/api/redeem` 동일 유저 + 동일 코드 | 2회차는 400 `이미 사용한 리딤 코드` |
| `/api/billing/process/pending` 중복 실행 | 같은 cycle 을 두 번 청구하지 않음 (retry_count 감시) |

### 4.4 트랜잭션 / 동시성 테스트

- redeem `FOR UPDATE` 경합: 두 유저가 동시에 같은 코드 요청 → 정확히 한쪽만 성공, 다른 한쪽은 400
- 리워드 적용 실패 시 코드 소모 여부: 현재는 코드 소모 후 별도 트랜잭션으로 grant. "grant 실패 → 코드는 이미 소진" 케이스를 integration test 로 재현하고, 로그에 `CRITICAL` 이 출력되며 사용자에게는 명확한 에러가 반환되는지 검증. (개선 사항: grant 실패 시 usage 롤백은 현 시점에서는 범위 밖. 단, 테스트로 현상을 pin 한다.)
- billing pause/resume 경합: `ACTIVE → PAUSED` + `PAUSED → ACTIVE` 를 연속 호출. 상태 검증 실패 시 400 유지.

### 4.5 보안 회귀 테스트

- 관리자 엔드포인트 모두: 비인증 → 401, 일반 유저 → 403, 관리자 → 200 3 케이스 커버
- Toss webhook: secret 미설정 + `APP_ENV=staging` → 503, 잘못된 서명 → 401
- 업로드: 허용되지 않은 MIME → 400, 사이즈 초과 → 400, 표 이름 injection 시도 (`UPLOAD_METADATA_TABLE=foo;DROP TABLE x`) → 500 refused
- SSID brute force: `/api/auth/check` 로 랜덤 토큰 N 회 호출 시 모두 401 이고 서버 500 없음

### 4.6 Provider 매트릭스

MySQL/Hyperdrive 가 default. Postgres/D1 는 "실험" 한정이므로 테스트 전략도 차별화:

| Provider | 테스트 수준 | 비고 |
|----------|------------|------|
| mysql / Hyperdrive | Full (Layer 1–5) | cutover 기준 provider |
| postgres | Layer 1 (unit) + Layer 3 provider-smoke 만 | 실제 스키마 호환 전에는 확대 금지 |
| d1 | Layer 1 only | production 에서는 guard 로 거부됨. 테스트는 보조 |

**가드 테스트**: `APP_ENV=production` + `DB_PROVIDER=d1` → `withConnection` 호출 즉시 throw. 이 케이스를 Layer 1 에 반드시 포함한다 (새 유닛).

---

## 5. CI 게이트 (GitHub Actions 권장)

Worker 레포는 현재 독립 GHA 가 없음. 아래 구성을 추가한다:

### 5.1 PR 단위 (fast, blocking)

```
jobs:
  pr-gate:
    steps:
      - npm ci
      - npm run typecheck
      - npm run test:unit
```

목표: PR 당 <3분. 실패 시 merge block.

### 5.2 Push-to-main / Nightly (fuller)

```
jobs:
  nightly:
    services:
      mariadb:
        image: mariadb:10.6
        ports: ["3306:3306"]
        env: { MYSQL_ROOT_PASSWORD: test, MYSQL_DATABASE: probgm }
    steps:
      - npm ci
      - scripts/load-fixtures.sh          # 최소 seed
      - npm run test:integration
      - npm run smoke:provider            # local wrangler dev
```

목표: <10분. 실패 시 슬랙 알림 (기존 알림 경로 재사용).

### 5.3 Pre-cutover (manual, hard gate)

Cutover 직전에 다음 모두를 staging 에 대해 수동으로 통과시킨다:

- [ ] `npm run smoke:provider` (mysql 선택 검증)
- [ ] `npm run smoke:live` (SSID 실사용자)
- [ ] `npm run smoke:write`
- [ ] `npm run smoke:admin`
- [ ] (신규) `npm run smoke:redeem`
- [ ] (신규) `npm run smoke:webhook-idempotency`
- [ ] `npm run compare:contract`
- [ ] `npm run compare:write`
- [ ] 프론트 V2 가 staging worker 를 바라보는 상태에서 리딤 모달 / 결제 체크아웃 / 플레이리스트 CRUD 골든 패스
- [ ] `docs/cutover-readiness.md` §6 rollback rule 전 항목 pass 확인

하나라도 실패하면 cutover 중단 + 블로커 기록.

---

## 6. 테스트 데이터 전략

| 카테고리 | 접근법 |
|----------|--------|
| 사용자 계정 | 전용 staging 계정 2 개 (일반 / 관리자). 비밀번호는 1Password. 프로덕션 계정 절대 금지. |
| 리딤 코드 | 테스트 prefix (`TEST-*`) 로 seed. smoke 실행 직전 재seed, 직후 정리 (max_uses=-1 로 두고 usage 테이블만 DELETE). |
| 프로모션 코드 | 위와 동일 규칙 (`TEST-PROMO-*`). |
| 결제 / billing | Toss sandbox 환경. 실결제 금지. webhook secret 도 sandbox 전용. |
| 업로드 | 고정된 작은 test fixture (`fixtures/*.json` 및 1KB 사운드 파일). |
| 플레이리스트 / 음원 | staging MariaDB 의 seed 덤프 (`~/dump.sql`) 를 월 1 회 리프레시. 민감정보 없는 익명화 덤프 권장. |

중요: **테스트 데이터 seed 는 반드시 트랜잭션으로 롤백 가능해야 한다**. 매 nightly run 이 DB 오염을 누적시키면 결국 비교 테스트가 의미 없어진다.

---

## 7. 테스트가 부족한 영역 (현재 알려진 gap)

아래는 2026-04-22 시점 구현 리뷰 기준으로 **아직 테스트가 없거나 약한** 영역. 우선 순위 순:

| 영역 | 위험도 | 제안 |
|------|--------|------|
| redeem 동시성 (FOR UPDATE) | 높음 | Layer 2 에서 Promise.all 로 동일 코드 2 요청 → 정확히 하나만 `rewardType` 응답, 나머지는 400 |
| redeem 리워드 grant 실패 복구 | 중간 | Layer 2 에서 `users_balance` 컬럼을 일시 drop 하고 `/redeem` 호출 → 500 + 로그 확인. 이후 수동 보상 runbook 연결 |
| webhook idempotency UNIQUE 보장 | 높음 | Layer 2: audit 테이블에 `UNIQUE KEY webhook_id` 가 **없을 때** 멱등성이 무너지는지 재현 → 문서의 "반드시 UNIQUE" 경고를 검증 |
| billing cron 경계 | 중간 | Layer 2 에서 `/billing/process/pending` 을 수동 2 회 호출. 같은 cycle 이 재청구되지 않아야 함 |
| 업로드 R2 failure 경로 | 중간 | R2 바인딩을 의도적으로 에러로 만들어 500 응답 경로 확인 |
| Typesense 다운 시 fallback | 낮음 | `/api/v3/assets/search` 가 Typesense 5xx 시 SQL fallback 로 떨어지는지 |
| d1 production 가드 | 낮음 | Layer 1 에서 `withConnection` 모킹하여 throw 검증 |

---

## 8. 구현 로드맵

| 단계 | 기간 목표 | 결과물 |
|------|-----------|--------|
| 1 | 1d | vitest 도입 + `npm run test:unit` 스크립트 + Layer 1 최소 10 케이스 |
| 2 | 2–3d | miniflare + docker-compose MariaDB 기반 Layer 2. redeem/webhook idempotency/billing 최소 케이스 |
| 3 | 1d | GitHub Actions PR gate (typecheck + unit), nightly (integration + provider-smoke) |
| 4 | 0.5d | `smoke-redeem.sh`, `smoke-webhook-idempotency.sh` 작성 |
| 5 | 0.5d | `schema-parity-check.sh`, `endpoint-parity-check.mjs` 자동화 |
| 6 | 진행 중 | cutover 직전 checklist (본 문서 §5.3) 를 `cutover-readiness.md` 에 링크 |

---

## 9. 문서 업데이트 규칙

테스트 관련 변경 시 반드시 같이 손보는 문서:

- 새 테스트 스크립트 추가 → `README.md`, `docs/test-strategy.md` (이 문서)
- 새 contract compare 추가 → `docs/contract-compare-runbook.md`
- 새 staging 체크리스트 → `docs/cutover-readiness.md`, `docs/staging-execution-checklist.md`
- 새 admin 케이스 → `docs/admin-incident-runbook.md`
- provider 테스트 결과 → `docs/provider-decision-record-*`

---

## 10. 요약

- **Typecheck + unit** 은 즉시 구축 가능 (가장 작은 투자, 가장 큰 rot 방지 효과)
- **Integration (miniflare + MariaDB)** 는 cutover 전 제일 중요. redeem 동시성 / webhook idempotency / billing 수동 트리거 3 케이스 이상이 이 레이어에 잡혀야 함
- **Staging smoke + contract compare** 는 이미 인프라가 있으므로 누락된 2 개(redeem, webhook idempotency) 만 추가
- **production 가드 테스트** (d1 refuse, webhook secret refuse) 를 Layer 1 에 반드시 넣어 회귀 방지
- cutover 게이트는 "redeem parity + production-safe webhook verification" 두 가지가 여전히 red-line. 이 둘이 테스트로 pin 되어야 cutover 가능

이 전략을 따르면 "엔드포인트와 DB 스키마가 legacy 와 1:1 이다" 라는 말이 매일 CI 에서 기계적으로 증명된다.
