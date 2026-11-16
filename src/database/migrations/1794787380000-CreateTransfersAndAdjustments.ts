import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTransfersAndAdjustments1794787380000 implements MigrationInterface {
  name = 'CreateTransfersAndAdjustments1794787380000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE transfers (
        id           UUID PRIMARY KEY,
        from_user_id TEXT NOT NULL,
        to_user_id   TEXT NOT NULL,
        currency     TEXT NOT NULL CHECK (currency IN ('IRT', 'USDT')),
        amount       BIGINT NOT NULL CHECK (amount > 0),
        journal_id   BIGINT NOT NULL REFERENCES ledger_journals (id),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT transfers_distinct_users_ck CHECK (from_user_id <> to_user_id)
      )`);
    await q.query(`CREATE INDEX transfers_from_idx ON transfers (from_user_id, created_at DESC)`);
    await q.query(`CREATE INDEX transfers_to_idx ON transfers (to_user_id, created_at DESC)`);

    await q.query(`
      CREATE TABLE adjustments (
        id                  UUID PRIMARY KEY,
        user_id             TEXT NOT NULL,
        currency            TEXT NOT NULL CHECK (currency IN ('IRT', 'USDT')),
        amount              BIGINT NOT NULL CHECK (amount > 0),
        reason              TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
        operator            TEXT,
        journal_id          BIGINT NOT NULL REFERENCES ledger_journals (id),
        reversal_journal_id BIGINT REFERENCES ledger_journals (id),
        reversal_reason     TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        reversed_at         TIMESTAMPTZ
      )`);
    await q.query(`CREATE INDEX adjustments_user_idx ON adjustments (user_id, created_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE adjustments`);
    await q.query(`DROP TABLE transfers`);
  }
}
