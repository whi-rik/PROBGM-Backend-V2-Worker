# Provider Test Matrix

Use this matrix before choosing whether to stay on MySQL, or move to Postgres or D1.

## Goal

Choose the database provider based on runtime behavior, not preference.

## Baseline rule

- Start with `mysql` or Hyperdrive for parity.
- Only promote `postgres` or `d1` after the same route families behave correctly against the real schema.

## Minimum checks per provider

### 1. Runtime health

- `GET /health`
- `GET /health/db`
- `GET /health/schema`
- `GET /health/storage`
- `GET /api/upload/health`

### 2. Auth and session

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/refresh`
- `POST /api/auth/signout`

### 3. Discovery

- `GET /api/v3/tags`
- `GET /api/v3/assets/list`
- `GET /api/v3/assets/search`
- `GET /api/v3/assets/:id`

### 4. Playlist writes

- `POST /api/playlist`
- `POST /api/playlist/add`
- `POST /api/playlist/remove`
- `PUT /api/v2/playlist/:id/reorder`
- `POST /api/v2/playlist/:id/duplicate`

### 5. User/account

- `GET /user/info`
- `GET /user/balance`
- `GET /user/membership`
- `GET /user/channels`
- `POST /user/channel`
- `POST /user/channel/:id/verify`

### 6. Payments

- `POST /api/payments/confirm`
- `DELETE /api/payments/:paymentKey`
- `POST /api/payments/webhook`
- `GET /api/payments/user/history-with-cancellations`

### 7. Upload

- `POST /api/upload`
- verify optional metadata row if `UPLOAD_METADATA_TABLE` is enabled

## Decision rubric

Choose `mysql` if:
- parity is highest
- query portability issues appear
- migrations are not yet justified

Choose `postgres` if:
- all core reads and writes pass
- JSON/text/date behavior matches expectations
- payment and playlist writes stay consistent

Choose `d1` if:
- the route set is narrowed
- portability is explicitly verified
- operational simplicity outweighs SQL differences

## Local smoke

You can run the base runtime smoke against a local worker:

```bash
BASE_URL=http://127.0.0.1:8787 npm run smoke:provider
```

Require a specific provider and a successful DB ping:

```bash
BASE_URL=http://127.0.0.1:8787 \
SMOKE_EXPECT_PROVIDER=mysql \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

With an authenticated token:

```bash
BASE_URL=http://127.0.0.1:8787 SMOKE_AUTH_TOKEN=<ssid> npm run smoke:provider
```

With a real account against staging or production-like environments:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

## Recommended execution order

### MySQL / Hyperdrive

1. Set `DB_PROVIDER=mysql`
2. Configure Hyperdrive or `DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS`
3. Run:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=mysql \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

4. Then run authenticated smoke:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EMAIL=user@example.com \
SMOKE_PASSWORD=secret \
npm run smoke:live
```

### Postgres

1. Set `DB_PROVIDER=postgres`
2. Configure `POSTGRES_URL` or `PG_*`
3. Run:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=postgres \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

4. Then repeat authenticated smoke and compare playlist/payment behavior with MySQL baseline.

### D1

1. Set `DB_PROVIDER=d1`
2. Bind `DB` in `wrangler.toml`
3. Run:

```bash
BASE_URL=https://your-worker.example.com \
SMOKE_EXPECT_PROVIDER=d1 \
SMOKE_REQUIRE_DB_OK=1 \
npm run smoke:provider
```

4. Only proceed to authenticated smoke after schema portability for the tested route family is confirmed.
