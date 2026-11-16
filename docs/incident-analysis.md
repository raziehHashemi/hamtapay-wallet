# Incident analysis — negative USDT balances after a deploy

> 02:10, after a deploy: 17 users' USDT balances went negative, by 4,210 USDT in total. Every one of them had
> made ≥ 2 withdrawals in the previous 10 minutes. Redis CPU hit 100%, and the withdrawal service went from 2
> to 6 instances. For each user the ledger sum is right, but the stored wallet balance doesn't match it.

**Reading the facts.** The ledger is right and the *stored* balance is wrong, so the balance is changed on a path
separate from (not atomic with) the ledger write. The stored balance went *down* more than the ledger did (≈ 248
USDT per user, about one typical withdrawal), and only users with concurrent withdrawals are affected. That
points to concurrency control that broke under load.

## Likely causes and how to confirm each

| # | Hypothesis | Data that confirms it |
|---|---|---|
| 1 | A **Redis lock/cache guards the balance**. Under 100% CPU, lock calls time out or a TTL expires mid-operation. Two pods then debit the same user from a stale balance. | Redis `SLOWLOG`, latency, `expired_keys`; lock logs with pod ids; overlapping withdrawals of one user on different pods |
| 2 | A **non-atomic read-modify-write** (`SELECT balance` → `UPDATE SET balance = :x`) introduced or exposed by the deploy. More pods means more lost updates. | Deploy diff of the balance path; `pg_stat_statements`; WAL/audit of the wallet table vs ledger inserts |
| 3 | **Double application.** The 2→6 rebalance or a Redis-timeout retry redelivers work. The ledger insert is de-duplicated, but the balance update isn't in the same transaction. | Broker redelivery logs around 02:0x; duplicate event or idempotency ids; Δ = an exact withdrawal amount |
| 4 | **Mixed versions** during the rollout, with different fee or balance semantics | Pod version per request; Δ = n × fee |

`Δ = stored − Σledger` per user, lined up with each user's withdrawal timeline, tells these apart quickly.

## First 30 minutes

1. **0–5 min:** open the incident. **Pause USDT payouts** (kill switch at the dispatcher). Freeze the affected
   accounts. **Roll back the deploy.** Return to the last known-good instance count.
2. **5–15 min:** check whether money really left twice (our withdrawals vs provider/chain records). Ask the
   provider to hold anything still pending. Run the integrity check over **all** accounts (stored ≠ Σ ledger),
   because drift may also hide in positive balances.
3. **15–30 min:** snapshot logs, Redis and the DB. Test the hypotheses. Rebuild the drifted balances **from the
   ledger** with a reviewed, logged job (no ad-hoc SQL). Prepare support messaging. Re-enable payouts only after
   the root cause is fixed.

## Is this design immune?

**To this failure, yes, by construction.** The stored balance changes **in the same transaction** as the ledger
entries, through one atomic `UPDATE … WHERE balance + δ ≥ 0`, so "ledger right, balance wrong" can't happen.
A `CHECK balance ≥ 0` makes a negative balance impossible even through raw SQL. There's **no Redis in the money
path**: mutual exclusion is a PostgreSQL row lock (no TTL, released on commit or crash). Correctness doesn't
depend on the instance count (the 100-way concurrency test runs on two instances). Redelivery can't apply twice
(unique posting references, status re-checks under lock). `GET /internal/ledger/integrity` is exactly the query
that would have caught this.
**Not immune to:** a deploy that posts a *wrong but balanced* journal (e.g. a wrong fee). Mitigations: one
posting module with tests per journal type, daily reconciliation, and the integrity check **on a schedule with
alerting** (today it runs on demand; scheduling it is the first production follow-up).
