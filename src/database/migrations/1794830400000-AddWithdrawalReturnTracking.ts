import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Added after probing the payout provider (docs/provider-notes.md §P7): an IBAN (Paya) transfer that was
 * reported SUCCEEDED can later come back as RETURNED (e.g. ACCOUNT_CLOSED). The money must be made available
 * to the user again, so we track the return and its journal, and keep watching successful IBAN withdrawals
 * for a while.
 */
export class AddWithdrawalReturnTracking1794830400000 implements MigrationInterface {
  name = 'AddWithdrawalReturnTracking1794830400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE withdrawals ADD COLUMN provider_returned_at TIMESTAMPTZ`);
    await q.query(`ALTER TABLE withdrawals ADD COLUMN return_journal_id BIGINT REFERENCES ledger_journals (id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE withdrawals DROP COLUMN return_journal_id`);
    await q.query(`ALTER TABLE withdrawals DROP COLUMN provider_returned_at`);
  }
}
