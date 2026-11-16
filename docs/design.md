# HamtaPay Wallet & Ledger Service — Design

> Status: **v1 (pre-implementation)** · Scope: T-103 · Owner: Amir Saffarzadeh
> Change history is at the end of this document.

## 1. Boundaries

One deployable **NestJS modular monolith** in front of **PostgreSQL**, which is the *only* source of truth
for money. No Redis: every invariant (balance ≥ 0, daily cap, idempotency, exactly-once posting) is enforced by
the database inside a single transaction, so losing any other component cannot lose or corrupt money.

| Module | Owns | Talks to |
|---|---|---|
| `ledger` | chart of accounts, journals, entries, materialised user balances; the **only writer** of ledger tables | — |
| `wallets` | read API: balances + keyset-paginated history | ledger |
| `deposits` | deposit lifecycle, PSP callback, PSP poller | ledger, PSP adapter |
| `withdrawals` | holds, daily cap, payout dispatcher, payout webhook, state machine | ledger, Payout adapter |
| `transfers`, `operations` | user→user transfers; manual adjustments (with reason) | ledger |
| `idempotency` | `Idempotency-Key` storage/replay, used by every money-moving POST | — |
| `outbox` → RabbitMQ | transactional outbox + relay; sample consumer with inbox de-dup | broker |
| `reconciliation` | parse PSP settlement CSV, report mismatches (never fixes) | PSP adapter |

External services sit behind ports (`PaymentGateway`, `PayoutGateway`) so tests can swap in deterministic fakes.

## 2. Data model (PostgreSQL 16, versioned migrations)

Money is `BIGINT` in **minor units** (IRT: 1 Toman; USDT: 10⁻⁶) and `bigint` in TypeScript. No float anywhere.

| Table | Key / important columns | Constraints & indexes |
|---|---|---|
| `ledger_accounts` | `id`, `owner_user_id` (NULL = system), `currency`, `kind`, `normal_side`, `balance` | UNIQUE NULLS NOT DISTINCT(owner, currency, kind); `CHECK balance >= 0`; balance materialised for **user** accounts only (system accounts are derived → no hot row) |
| `ledger_journals` | `id`, `type`, `idempotency_ref`, `reference_type/id`, `reverses_journal_id` | `UNIQUE(idempotency_ref)` ⇒ a business event can be posted **once**; UPDATE/DELETE blocked by trigger |
| `ledger_entries` | `journal_id`, `account_id`, `currency`, `direction`, `amount > 0`, `balance_after`, `owner_user_id` | FK(account_id, currency); deferred trigger: Σdebit = Σcredit per journal & currency; index `(owner_user_id, id DESC)` for O(log n) history pages |
| `deposits` | `id uuid`, `user_id`, `amount`, `status`, `psp_token` UNIQUE, `psp_ref_id`, `next_check_at` | partial index on open deposits for the poller |
| `withdrawals` | `id uuid` (= payout `requestId`), `user_id`, `currency`, `amount`, `fee`, `destination`, `status`, provider fields, `next_attempt_at`, `limit_day`, `limit_amount_irt` | partial index on open withdrawals for the dispatcher |
| `withdrawal_daily_usage` | PK(`user_id`, `day`), `used_irt` | conditional upsert enforces the cap atomically |
| `transfers`, `adjustments` | business records pointing to their journal | |
| `idempotency_keys` | PK(`scope`, `key`), `request_hash`, stored response | written in the **same transaction** as the effect |
| `outbox_events` / `processed_events` | event id, payload, `published_at` / PK(consumer, event_id) | at-least-once publish, exactly-once apply |

**Chart of accounts** (per currency): user `AVAILABLE` and `HELD` (liabilities), system `PSP_CLEARING`,
`PAYOUT_CLEARING` (assets), `FEE_REVENUE`, `OPS_ADJUSTMENTS` (expense). Wallet `available` = AVAILABLE balance;
a pending withdrawal moves money AVAILABLE → HELD, so it cannot be spent twice.

| Event | Journal |
|---|---|
| Deposit verified | Dr PSP_CLEARING / Cr user AVAILABLE |
| Withdrawal requested | Dr AVAILABLE (amount+fee) / Cr HELD |
| Withdrawal succeeded | Dr HELD / Cr PAYOUT_CLEARING (amount) + Cr FEE_REVENUE (fee) |
| Withdrawal failed / cancelled | Dr HELD / Cr AVAILABLE (reversal of the hold) |
| Transfer | Dr AVAILABLE(from) / Cr AVAILABLE(to) |
| Manual adjustment | Dr OPS_ADJUSTMENTS / Cr AVAILABLE |

## 3. State machines

**Deposit**: `PENDING` (link issued) → `VERIFYING` (PSP reports paid; verify call in progress/retrying) →
`SUCCEEDED` (verified & credited) | `FAILED` (PSP says failed). The callback is only a *trigger*: amount and
status always come from the PSP's server-side verify. A poller covers lost callbacks.

**Withdrawal**: `PENDING` (funds held, not yet sent; cancellable) → `PROCESSING` (persisted *before* the first
HTTP call; outcome may be unknown) → `SUCCEEDED` | `FAILED`.

| Error case | Handling |
|---|---|
| Payout 5xx / timeout / connection reset | stays `PROCESSING`; retried with the **same** `requestId` |
| Webhook missing | poller asks the provider |
| Webhook duplicated / out of order | transitions are monotonic; a final state is never regressed |
| Webhook bad signature | rejected (401), never applied |
| Provider rejects request (4xx) | `FAILED` + hold released |
| No answer for a long time | **never** auto-failed; flagged `needs_review` (see ADR-3) |

## 4. Key invariants & how they hold

1. **Balance never negative / no double spend** — hold = one conditional `UPDATE … WHERE balance >= x`
   on the user's row, plus a `CHECK` constraint as a backstop. Works across any number of instances.
2. **Daily cap under concurrency** — `INSERT … ON CONFLICT DO UPDATE … WHERE used + x <= cap`, same transaction.
3. **Idempotency** — key row inserted in the business transaction; a concurrent duplicate blocks on the unique
   index and then replays the committed response. Different body ⇒ `422 IDEMPOTENCY_KEY_REUSED`.
4. **Crash safety** — every step is a committed state; workers resume from the table after restart
   (`FOR UPDATE SKIP LOCKED`), external calls are idempotent by our own ids.

## 5. Assumptions

Users need no registration (accounts created on first credit/debit). IRT amounts are integer Toman, USDT ≤ 6
decimals. Minimum withdrawal 100,000 Toman (business rules; the error table's "50,000" is read as an example).
Payout amounts must be sent in **IRR** (×10). The PSP amount unit is unknown until probed (assume Rial).
"Day" for the cap = Asia/Tehran calendar day. `/internal/*` is reachable only from the ops network.

## 6. Architecture decisions

**ADR-1 — Concurrency control for balances.** Options: Redis distributed lock; optimistic version + retry;
`SERIALIZABLE`; atomic conditional `UPDATE` in PostgreSQL. **Chosen:** conditional `UPDATE` + CHECK.
*Cost:* a single very hot wallet is bounded by row-lock throughput (~1–2k tx/s); mitigation analysed in
`scalability.md`. Gain: no second store whose failure/lag can break the invariant.

**ADR-2 — Idempotency storage.** Options: Redis `SETNX` with TTL; separate table with `IN_PROGRESS` + recovery;
row in the *same* DB transaction as the effect. **Chosen:** same transaction (business errors kept via a
savepoint so a retry returns the same answer). *Cost:* the deposit request keeps its transaction open during the
(bounded, side-effect-free) PSP "create payment" call; keys live in the main DB.

**ADR-3 — Unknown withdrawal outcome.** Options: fail after timeout and release funds; keep funds held until a
definitive provider answer. **Chosen:** hold until definitive; deterministic `requestId` = withdrawal id.
*Cost:* user funds can stay held for a long time; needs an ops review queue.

**ADR-4 — Event delivery.** Options: publish after commit; CDC (Debezium); transactional outbox. **Chosen:**
outbox + relay (at-least-once) and consumer inbox (exactly-once effect). *Cost:* extra table and latency of one
relay tick.

## Change history

| Version | Date | Change |
|---|---|---|
| v1 | 2026-11-16 | Initial design from the brief, before implementation. |
