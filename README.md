# HamtaPay Wallet & Ledger Service (T-103)

A wallet and **double-entry ledger** for a crypto exchange. It keeps IRT (Toman) and USDT balances, takes
deposits through a payment gateway, pays out to IBAN / TRC20, moves money between users, and supports manual
adjustments and settlement reconciliation. It is built so that **no money is lost or paid twice** under
concurrency, retries, crashes and an unreliable provider.

**Stack:** Node.js · TypeScript · NestJS 11 · PostgreSQL 16 (TypeORM, versioned migrations) · RabbitMQ
(transactional outbox) · Docker Compose. No Redis: every money invariant is enforced by PostgreSQL.

| Document | What it covers |
|---|---|
| [`docs/design.md`](docs/design.md) | Design (≤ 2 pages): boundaries, data model, state machines, ADRs, change history (v1 was the first commit) |
| [`docs/provider-notes.md`](docs/provider-notes.md) | 20+ observed behaviours of the PSP/payout simulator, with evidence ([`docs/evidence/`](docs/evidence)) |
| [`docs/ambiguities.md`](docs/ambiguities.md) | Deliberate ambiguities #1 (required), #2 and #3 |
| [`docs/incident-analysis.md`](docs/incident-analysis.md) | The negative-USDT-balance incident |
| [`docs/scalability.md`](docs/scalability.md) | 50× load analysis (bonus) |
| [`docs/openapi.yaml`](docs/openapi.yaml) · [`postman/`](postman) | API contract (also live at `/docs`) and a Postman collection + environment |

## Run it

The only requirement is Docker.

```bash
docker load -i t103-simulator.tar.gz        # once: the provided simulator image
docker compose up --build                   # everything: app, 2 API replicas, postgres, rabbitmq, simulator
```

| URL | What |
|---|---|
| http://localhost:3000 | API (`app` = nginx load-balancing **two** `wallet-api` replicas) |
| http://localhost:3000/docs | Swagger UI (OpenAPI JSON at `/docs-json`) |
| http://localhost:3000/health | Readiness: database, broker, outbox backlog |
| http://localhost:8080 | Simulator (PSP + payout) · http://localhost:15672 RabbitMQ UI (wallet / wallet) |

The defaults match the brief: `SIM_CHAOS=default`, `SIM_TIME_SCALE=1`, and webhooks at
`http://app:3000/webhooks/payout`. Ports, chaos mode, time scale, the number of replicas and an optional
internal API key can be changed in `.env` (see [`.env.example`](.env.example)). For the hostile demo:

```bash
SIM_CHAOS=hostile SIM_TIME_SCALE=10 docker compose up -d --build
```

### Try it in 30 seconds

```bash
curl -s -XPOST localhost:3000/internal/adjustments -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"userId":"alice","currency":"IRT","amount":"1000000","reason":"demo"}'
curl -s -XPOST localhost:3000/withdrawals -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"userId":"alice","currency":"IRT","amount":"250000","destination":"IR820540102680020817909002"}'
curl -s localhost:3000/wallets/alice
```

The Postman collection walks through everything, including paying a deposit on the simulator's page:
import `postman/hamtapay-wallet.postman_collection.json` and `postman/hamtapay-local.postman_environment.json`,
then run the folders in order. It also runs headless with newman:
`npx newman run postman/hamtapay-wallet.postman_collection.json -e postman/hamtapay-local.postman_environment.json`.

## Tests

```bash
npm ci
npm test                    # unit: 165 tests, pure logic, no I/O (≈ 5 s)
npm run test:integration    # 104 tests against a REAL PostgreSQL (Testcontainers; only Docker needed) (≈ 30 s)
npm run test:e2e            # 24 black-box tests against the running stack + real simulator (needs `docker compose up`)
```

| Suite | What it proves |
|---|---|
| **Unit** (`src/**/*.spec.ts`) | Money parsing (no floats), IBAN/TRC20 validation, the full withdrawal transition table, deposit decision rules, the settlement CSV parser (on the file captured from the provider), the reconciliation matcher, Jalali dates, HMAC verification, config validation |
| **Integration** (`test/integration`) | Real PostgreSQL, the real NestJS HTTP pipeline, fake PSP/payout adapters that reproduce every observed provider behaviour. **Required:** deposit and withdrawal flows on a real DB, and **100 concurrent withdrawals from two app instances on one balance** (exactly the affordable ones succeed, never negative), plus the **daily cap** under concurrency (exactly 66 × 3M succeed). Also: 50 concurrent requests with one Idempotency-Key = one effect, crash recovery, unknown outcomes never paid twice, late success, cancel, RETURNED, database-level defences, outbox/consumer de-duplication, 300k-entry history paging |
| **E2E** (`test/e2e`, bonus) | The deployed stack and the **real simulator**. Each provider fault is injected deterministically and cross-checked against the simulator's own records (exactly one executed transfer). A **hostile-mode** soak with users racing deposits, withdrawals and duplicate retries: no double payout, ledger = provider, integrity OK, outbox drained |

E2E reads `E2E_BASE_URL` (default `http://localhost:3000`), `E2E_SIM_URL` and `SIM_ADMIN_KEY`. Run it with
`SIM_TIME_SCALE=10` so it finishes in about 3 minutes. Two live demos for the presentation:

```bash
npm run demo:hostile        # hostile chaos, many users, prints an invariant report
npm run demo:crash          # SIGKILLs every API replica mid-flight, restarts, shows nothing lost or paid twice
```

`npm run lint`, `npm run typecheck`, `npm run openapi:export` (regenerates `docs/openapi.*` from code),
`npm run probe:simulator` (reproduces `docs/evidence/simulator-probe.log`).

## API (contract in Appendix A, plus extras)

All bodies are JSON. **All amounts are strings** (IRT = integer Toman, USDT ≤ 6 decimals); JSON numbers are
rejected. Every money-moving POST requires `Idempotency-Key`. Errors are `{ "code", "message" }`.
Keys are unique per operation (not per user), so reusing a key with *any* different body, another `userId`
included, is `422 IDEMPOTENCY_KEY_REUSED`, exactly as the contract defines it. Clients should send UUIDs.

| Method | Path | Notes |
|---|---|---|
| POST | `/deposits` | `{userId, amount}` → 201 `{depositId, status, paymentUrl, …}` |
| GET | `/deposits/{id}` | `PENDING` → `VERIFYING` → `SUCCEEDED` / `FAILED` |
| POST | `/withdrawals` | `{userId, currency, amount, destination}` → 201 `{withdrawalId, status, …}` |
| GET | `/withdrawals/{id}` | `PENDING` → `PROCESSING` → `SUCCEEDED` / `FAILED` (`failureReason` explains why) |
| POST | `/withdrawals/{id}/cancel` | Extra: only while `PENDING` (ambiguity #3) |
| GET | `/wallets/{userId}` | `balances: [{currency, available, held, total, debt}]` |
| GET | `/wallets/{userId}/ledger?limit=&cursor=&currency=` | `{items, nextCursor}`, keyset pagination |
| POST | `/internal/adjustments` | `{userId, currency, amount, reason, operator?}` → 201 |
| POST | `/internal/adjustments/{id}/reverse` | Extra: corrects a mistaken adjustment with a reversal journal |
| POST | `/transfers` | `{fromUserId, toUserId, currency, amount}` → 201 `{transferId, …}` |
| POST | `/reconciliation/run` | `{date: "YYYY-MM-DD"}` → 200 `{date, summary, mismatches: [{type, reference, …}]}` |
| GET | `/internal/ledger/integrity`, `/internal/withdrawals/review` | Extra: invariant check, review queue |
| POST | `/webhooks/psp/callback`, `/webhooks/payout` | Provider → us (HMAC-verified for payouts) |

Error codes: `400 INVALID_DESTINATION`, `422 INSUFFICIENT_FUNDS`, `422 DAILY_LIMIT_EXCEEDED`,
`422 BELOW_MINIMUM`, `422 IDEMPOTENCY_KEY_REUSED`, `409 IDEMPOTENCY_IN_PROGRESS` (contract), plus
`400 VALIDATION_ERROR`, `400 IDEMPOTENCY_KEY_MISSING`, `404 NOT_FOUND`, `409 WITHDRAWAL_NOT_CANCELLABLE`,
`422 ACCOUNT_RESTRICTED`, `401 INVALID_SIGNATURE`, `502 GATEWAY_UNAVAILABLE`.

Business rules: minimum withdrawal 100,000 IRT / 10 USDT. IRT withdrawals are free; USDT costs 1 USDT on top.
Daily cap 200,000,000 IRT per user (USDT counted at `USDT_IRT_RATE`, Asia/Tehran day). Minimum deposit 1,000 IRT
(the PSP minimum is 10,000 Rial). All of these are configurable.

## How the hard requirements are met

| Requirement | How |
|---|---|
| 100 concurrent withdrawals, many instances: never negative, cap holds | One conditional `UPDATE … WHERE balance + δ ≥ 0` per account, plus a `CHECK` constraint. The cap is a conditional upsert in the same transaction. Proven with 2 app instances. |
| Same Idempotency-Key, sequential or concurrent → one effect | The key row is written in the same transaction as the effect. A concurrent duplicate waits on the unique index and replays the committed response. |
| No float | `BIGINT` minor units in the DB, `bigint` in code, strings in the API, and lint forbids `parseFloat` |
| Events survive a crash right after commit; consumers apply once | Transactional outbox → RabbitMQ (publisher confirms, durable queues) → consumer inbox `(consumer, event_id)` |
| Crash at any step of a withdrawal → nothing unknown, nothing paid twice | `PROCESSING` is committed before the first call. Deterministic `requestId`, leases with `SKIP LOCKED`, no re-creation after ack. Demonstrated live: `npm run demo:crash` |
| Critical data survives losing Redis/broker | Postgres is the only store of record. A broker outage only delays events. |
| Versioned migrations, one-command startup | `src/database/migrations`, applied under an advisory lock by the `migrate` job in compose |

## Project layout

```
src/
  common/        money (bigint), errors, validation (IBAN/TRC20), idempotency header, background-worker base
  config/        typed, validated configuration (fails fast)
  database/      data source, SQL helpers, versioned migrations, advisory-locked migration runner
  integrations/  ports (PaymentGateway, PayoutGateway) + simulator HTTP adapters
  modules/
    ledger/        posting engine, chart of accounts, integrity check
    idempotency/   Idempotency-Key storage/replay
    wallets/       balances + history API
    deposits/      lifecycle, PSP callback, poller, pure decision policy
    withdrawals/   holds, daily cap, dispatcher, payout webhook, pure state machine, cancel
    transfers/  operations/  reconciliation/  outbox/  notifications/  health/
test/            integration (Testcontainers) and e2e suites, fakes, helpers
scripts/         simulator probe, hostile and crash demos, OpenAPI export
docs/            design, provider notes + evidence, ambiguities, incident, scalability, OpenAPI
```

## Scope: done and not done

Everything in the **required** column is done. All **bonus** items are done too: USDT with TRC20 and the fee,
transfers, the message broker with an outbox and an idempotent consumer, reconciliation, E2E tests, ambiguities
#2/#3 and the scalability analysis.

Deliberately left out, and how I would do each:
- **Settling a user's debt** (after a late success, ambiguity #1): withdrawals and transfers are blocked while
  debt > 0. Collecting it is an ops procedure. Next step: `POST /internal/receivables/{userId}/settle`, which
  posts Dr AVAILABLE / Cr RECEIVABLE.
- **Running the integrity check and reconciliation on a schedule with alerting.** Today they're on-demand
  endpoints. I'd add a cron worker plus a metric/alert on any drift or mismatch.
- **Authentication/authorization.** The brief needs no UI or auth. `/internal/*` and `/reconciliation/*` accept
  an optional `INTERNAL_API_KEY`. In production they sit behind the ops network with service-to-service auth.
- **TRC20 base58check checksum.** Today it's a format check, the same as the provider applies. I'd add
  double-SHA256 checksum validation.
- **A live USDT/IRT rate source** for the cap (today a configured rate, see ambiguity #2).
- **Metrics/tracing** (Prometheus, OpenTelemetry). Today: structured logs with request ids, `/health` with the
  outbox backlog, and the `inbound_events` audit table.
