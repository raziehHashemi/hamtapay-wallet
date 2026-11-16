import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReconciliationReports1794830460000 implements MigrationInterface {
  name = 'CreateReconciliationReports1794830460000';

  async up(q: QueryRunner): Promise<void> {
    // Append-only history of reconciliation runs (the process reports, it never fixes anything).
    await q.query(`
      CREATE TABLE reconciliation_reports (
        id               BIGSERIAL PRIMARY KEY,
        settlement_date  DATE NOT NULL,
        mismatch_count   INT NOT NULL,
        report           JSONB NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX reconciliation_reports_date_idx ON reconciliation_reports (settlement_date, id DESC)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE reconciliation_reports`);
  }
}
