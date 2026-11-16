# Scalability (bonus, analysis only)

> 50× load: **500 withdrawals/s**, **2M wallets**, and one corporate wallet doing **200 withdrawals/s**.
> Where is the first bottleneck, and what changes?

## The first bottleneck: the corporate wallet's row

Every withdrawal of one wallet must update that wallet's `AVAILABLE` row (and its `withdrawal_daily_usage` row).
PostgreSQL serialises writers on a row: the second transaction waits until the first **commits**. So one wallet's
throughput is about `1 / (time the row lock is held)`.

Today the lock is taken in the middle of the withdrawal transaction. The idempotency insert comes before it.
The journal and entry inserts, the outbox event, the cap upsert, the withdrawal insert, the idempotency update
and the commit (fsync) all come after it, and all of that runs while the lock is held: roughly **5–10 ms**. That
gives **~100–200 tx/s for one wallet**. At 200/s the corporate wallet is right at the ceiling. Latency spikes,
requests queue in the pool, and the queue then starves other users. Everything else (500/s spread over 2M
wallets) is far below PostgreSQL's limits. So the hot wallet fails first. Its daily-usage row is a second hot row
of the same kind.

**What is *not* a bottleneck, by design:** house accounts (`PSP_CLEARING`, `PAYOUT_CLEARING`, `FEE_REVENUE`) are
not materialised, so deposits and withdrawals of different users never contend on a shared row. 2M wallets × 3
accounts = 6M small rows, which is trivial. History reads are an index range scan, whatever the depth (tested
with 300k entries for one user).

## Changes, in the order I would make them

1. **Shrink the critical section (cheap, ~5–10× for the hot row).** Reorder the transaction so that everything
   that doesn't need the lock (idempotency row, journal, withdrawal row, outbox, cap) comes first, and the
   conditional `UPDATE` of the balance is the **last statement before COMMIT**. Enable group commit
   (`commit_delay`/`commit_siblings`) and put WAL on fast NVMe. The lock is then held only for the UPDATE plus
   the commit: ~1 ms, so ~1,000/s for one wallet.
2. **Split the hot wallet into balance buckets.** For wallets flagged as high-volume, keep `AVAILABLE` as N
   sub-account rows (e.g. 16). A withdrawal picks a bucket that can cover it (by hash or round-robin, falling
   back to the next one). Reads sum the buckets. A rebalancer moves funds between buckets with ordinary journals.
   The ledger stays double-entry, and throughput scales roughly linearly with N. The cap row is split the same
   way (per-bucket allowances), or corporate accounts get a contract-level limit instead of the retail 200M
   rule.
3. **Or batch the hot wallet.** Withdrawals for that wallet are written as *intents*. One worker per hot wallet
   applies them in order, 50–100 per transaction (one row lock, many entries). This trades a little latency
   (tens of ms) for an order-of-magnitude throughput increase and keeps strict ordering.
4. **Database for 500 withdrawals/s overall.** Each withdrawal is ~10 row writes across its lifecycle, so about
   5k writes/s plus WAL. That's fine on a tuned primary. Add PgBouncer (transaction pooling) in front of more
   app instances. Partition `ledger_entries` and `outbox_events` by month (old partitions get detached and
   archived, indexes stay small). Clean up or partition `idempotency_keys` by age. Serve wallet and history reads
   from replicas (they tolerate a few ms of lag; the money checks always run on the primary).
5. **Workers.** Give the dispatcher concurrency and a rate limit towards the provider (500 calls/s with 10 s
   timeouts needs ~thousands of in-flight requests across the fleet; use the provider's bulk API if it has one).
   Partition the outbox by aggregate, or replace polling with CDC (Debezium) if the relay lags.
6. **When one primary is not enough: shard by `user_id`** (Citus or app-level routing). This design shards
   cleanly. Every money movement touches one user's rows plus non-materialised house accounts. Transfers
   between shards become a two-step saga through a clearing account, which the ledger already models.

**Measure before and after:** row-lock wait time (`pg_locks`, `pg_stat_activity.wait_event`), p99 of the
withdrawal transaction, commit latency, connection-pool queueing, outbox lag.
