import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDepositsAndWithdrawals1794787320000 implements MigrationInterface {
  name = 'CreateDepositsAndWithdrawals1794787320000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE deposits (
        id                   UUID PRIMARY KEY,
        user_id              TEXT NOT NULL,
        amount               BIGINT NOT NULL CHECK (amount > 0),
        status               TEXT NOT NULL CHECK (status IN ('PENDING', 'VERIFYING', 'SUCCEEDED', 'FAILED')),
        psp_token            TEXT UNIQUE,
        payment_url          TEXT,
        psp_status           TEXT,
        psp_ref_id           TEXT,
        verified_amount_rial BIGINT,
        credited_amount      BIGINT,
        failure_reason       TEXT,
        anomaly              TEXT,
        needs_review         BOOLEAN NOT NULL DEFAULT false,
        journal_id           BIGINT REFERENCES ledger_journals (id),
        check_attempts       INT NOT NULL DEFAULT 0,
        next_check_at        TIMESTAMPTZ,
        verified_at          TIMESTAMPTZ,
        finalized_at         TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT deposits_final_has_no_schedule_ck
          CHECK (status IN ('PENDING', 'VERIFYING') OR next_check_at IS NULL)
      )`);
    await q.query(`CREATE INDEX deposits_user_idx ON deposits (user_id, created_at DESC)`);
    await q.query(
      `CREATE INDEX deposits_due_idx ON deposits (next_check_at) WHERE next_check_at IS NOT NULL`,
    );
    await q.query(`CREATE INDEX deposits_ref_idx ON deposits (psp_ref_id) WHERE psp_ref_id IS NOT NULL`);

    await q.query(`
      CREATE TABLE withdrawals (
        id                       UUID PRIMARY KEY,
        user_id                  TEXT NOT NULL,
        currency                 TEXT NOT NULL CHECK (currency IN ('IRT', 'USDT')),
        amount                   BIGINT NOT NULL CHECK (amount > 0),
        fee                      BIGINT NOT NULL DEFAULT 0 CHECK (fee >= 0),
        destination              TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
        failure_reason           TEXT,
        provider_status          TEXT,
        provider_tracking_id     TEXT,
        provider_acknowledged_at TIMESTAMPTZ,
        provider_succeeded_at    TIMESTAMPTZ,
        limit_day                DATE NOT NULL,
        limit_amount_irt         BIGINT NOT NULL CHECK (limit_amount_irt >= 0),
        usdt_irt_rate            BIGINT,
        attempts                 INT NOT NULL DEFAULT 0,
        next_attempt_at          TIMESTAMPTZ,
        last_error               TEXT,
        needs_review             BOOLEAN NOT NULL DEFAULT false,
        anomaly                  TEXT,
        hold_journal_id          BIGINT NOT NULL REFERENCES ledger_journals (id),
        settle_journal_id        BIGINT REFERENCES ledger_journals (id),
        release_journal_id       BIGINT REFERENCES ledger_journals (id),
        submitted_at             TIMESTAMPTZ,
        finalized_at             TIMESTAMPTZ,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC)`);
    await q.query(
      `CREATE INDEX withdrawals_due_idx ON withdrawals (next_attempt_at) WHERE next_attempt_at IS NOT NULL`,
    );
    await q.query(`
      CREATE INDEX withdrawals_tracking_idx ON withdrawals (provider_tracking_id)
      WHERE provider_tracking_id IS NOT NULL`);
    await q.query(`CREATE INDEX withdrawals_review_idx ON withdrawals (created_at) WHERE needs_review`);

    // One row per user per (Asia/Tehran) day. The cap is enforced by a conditional upsert on this row.
    await q.query(`
      CREATE TABLE withdrawal_daily_usage (
        user_id    TEXT NOT NULL,
        day        DATE NOT NULL,
        used_irt   BIGINT NOT NULL CHECK (used_irt >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, day)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE withdrawal_daily_usage`);
    await q.query(`DROP TABLE withdrawals`);
    await q.query(`DROP TABLE deposits`);
  }
}
