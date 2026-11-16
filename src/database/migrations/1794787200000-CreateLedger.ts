import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Double-entry ledger. Guarantees enforced by the database itself (defence in depth):
 *  - user balances can never be negative (CHECK)
 *  - journals and entries are append-only (trigger rejects UPDATE/DELETE)
 *  - every journal is balanced per currency at commit time (deferred constraint trigger)
 *  - a business event can be posted only once (UNIQUE idempotency_ref)
 *  - an entry's currency always matches its account's currency (composite FK)
 */
export class CreateLedger1794787200000 implements MigrationInterface {
  name = 'CreateLedger1794787200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ledger_accounts (
        id             BIGSERIAL PRIMARY KEY,
        owner_user_id  TEXT,
        currency       TEXT NOT NULL CHECK (currency IN ('IRT', 'USDT')),
        kind           TEXT NOT NULL CHECK (kind IN ('USER_AVAILABLE', 'USER_HELD', 'USER_RECEIVABLE',
                                                     'PSP_CLEARING', 'PAYOUT_CLEARING', 'FEE_REVENUE',
                                                     'OPS_ADJUSTMENTS')),
        normal_side    TEXT NOT NULL CHECK (normal_side IN ('DEBIT', 'CREDIT')),
        balance        BIGINT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_accounts_owner_kind_uq UNIQUE NULLS NOT DISTINCT (owner_user_id, currency, kind),
        CONSTRAINT ledger_accounts_id_currency_uq UNIQUE (id, currency),
        CONSTRAINT ledger_accounts_user_kind_ck
          CHECK ((owner_user_id IS NOT NULL) = (kind IN ('USER_AVAILABLE', 'USER_HELD', 'USER_RECEIVABLE'))),
        CONSTRAINT ledger_accounts_balance_materialised_ck CHECK ((owner_user_id IS NOT NULL) = (balance IS NOT NULL)),
        CONSTRAINT ledger_accounts_balance_non_negative_ck CHECK (balance IS NULL OR balance >= 0)
      )`);

    await q.query(`
      CREATE TABLE ledger_journals (
        id                  BIGSERIAL PRIMARY KEY,
        type                TEXT NOT NULL,
        idempotency_ref     TEXT NOT NULL,
        reference_type      TEXT NOT NULL,
        reference_id        TEXT NOT NULL,
        description         TEXT,
        reverses_journal_id BIGINT REFERENCES ledger_journals (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_journals_idempotency_ref_uq UNIQUE (idempotency_ref)
      )`);
    await q.query(`CREATE INDEX ledger_journals_reference_idx ON ledger_journals (reference_type, reference_id)`);

    await q.query(`
      CREATE TABLE ledger_entries (
        id             BIGSERIAL PRIMARY KEY,
        journal_id     BIGINT NOT NULL REFERENCES ledger_journals (id),
        account_id     BIGINT NOT NULL,
        currency       TEXT NOT NULL,
        owner_user_id  TEXT,
        direction      TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount         BIGINT NOT NULL CHECK (amount > 0),
        balance_after  BIGINT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ledger_entries_account_fk FOREIGN KEY (account_id, currency)
          REFERENCES ledger_accounts (id, currency)
      )`);
    await q.query(`CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id)`);
    await q.query(`CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id)`);
    // History pages: WHERE owner_user_id = $1 AND id < $cursor ORDER BY id DESC LIMIT n  -> index range scan.
    await q.query(`
      CREATE INDEX ledger_entries_owner_history_idx ON ledger_entries (owner_user_id, id DESC)
      WHERE owner_user_id IS NOT NULL`);

    await q.query(`
      CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'restrict_violation';
      END $$`);
    await q.query(`
      CREATE TRIGGER ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals
      FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()`);
    await q.query(`
      CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()`);

    await q.query(`
      CREATE FUNCTION ledger_assert_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        bad RECORD;
      BEGIN
        SELECT currency, SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS diff
          INTO bad
          FROM ledger_entries
         WHERE journal_id = NEW.journal_id
         GROUP BY currency
        HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
         LIMIT 1;
        IF FOUND THEN
          RAISE EXCEPTION 'journal % is unbalanced in % by %', NEW.journal_id, bad.currency, bad.diff
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$`);
    await q.query(`
      CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_assert_journal_balanced()`);

    // System (house) accounts. Their balances are derived from entries, never materialised: this keeps
    // them from becoming a single hot row that every deposit/withdrawal in the exchange would lock.
    await q.query(`
      INSERT INTO ledger_accounts (owner_user_id, currency, kind, normal_side, balance)
      SELECT NULL, c.currency, k.kind, k.normal_side, NULL
        FROM (VALUES ('IRT'), ('USDT')) AS c (currency)
       CROSS JOIN (VALUES ('PSP_CLEARING', 'DEBIT'),
                          ('PAYOUT_CLEARING', 'DEBIT'),
                          ('FEE_REVENUE', 'CREDIT'),
                          ('OPS_ADJUSTMENTS', 'DEBIT')) AS k (kind, normal_side)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ledger_entries`);
    await q.query(`DROP TABLE ledger_journals`);
    await q.query(`DROP TABLE ledger_accounts`);
    await q.query(`DROP FUNCTION ledger_assert_journal_balanced()`);
    await q.query(`DROP FUNCTION ledger_forbid_mutation()`);
  }
}
