import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { queryRows } from '../../database/sql';
import { PaymentGateway, PaymentGatewayUnavailableError } from '../../integrations/psp/payment-gateway';
import { isoDateToJalali } from './jalali';
import { LedgerRecord, matchSettlement, Mismatch } from './reconciliation-matcher';
import { normalizeReference, parseSettlementCsv } from './settlement-parser';

export interface ReconciliationReport {
  date: string;
  jalaliDate: string;
  generatedAt: string;
  summary: {
    settlementRows: number;
    duplicateLinesIgnored: number;
    ledgerRecords: number;
    matched: number;
    matchedOnOtherDay: number;
    mismatches: number;
    bankFeeRows: number;
    bankFeesRial: string;
  };
  mismatches: Mismatch[];
  warnings: string[];
}

/**
 * Daily reconciliation against the PSP settlement report. Read-only by design: it produces a report (stored
 * in `reconciliation_reports`) for operations and never posts or corrects anything.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: PaymentGateway,
    private readonly config: AppConfig,
  ) {}

  async run(date: string): Promise<ReconciliationReport> {
    let csv: string;
    try {
      csv = await this.gateway.fetchSettlementCsv(date);
    } catch (error) {
      if (error instanceof PaymentGatewayUnavailableError) {
        throw Errors.gatewayUnavailable('settlement report is not available right now');
      }
      throw error;
    }
    const parsed = parseSettlementCsv(csv);
    const jalaliDate = isoDateToJalali(date);
    for (const row of parsed.rows) {
      if (row.date && row.date !== jalaliDate) {
        parsed.warnings.push(`row ${row.rowNumber} is dated ${row.date}, expected ${jalaliDate}`);
      }
    }

    const dayRecords = await this.loadDayRecords(date);
    const references = parsed.rows.map((r) => r.reference);
    const onThisDay = new Set(dayRecords.map((r) => `${r.kind}|${r.reference}`));
    const otherDayRecords = (await this.loadRecordsByReference(references)).filter(
      (r) => !onThisDay.has(`${r.kind}|${r.reference}`),
    );
    const knownWithdrawalRefs = await this.loadWithdrawalRefs(references);
    const result = matchSettlement(parsed.rows, dayRecords, otherDayRecords, knownWithdrawalRefs);

    const report: ReconciliationReport = {
      date,
      jalaliDate,
      generatedAt: new Date().toISOString(),
      summary: {
        settlementRows: parsed.rows.length,
        duplicateLinesIgnored: parsed.duplicateLinesIgnored,
        ledgerRecords: dayRecords.length,
        matched: result.matched,
        matchedOnOtherDay: result.matchedOnOtherDay,
        mismatches: result.mismatches.length,
        bankFeeRows: result.bankFeeRows,
        bankFeesRial: result.bankFeesRial.toString(),
      },
      mismatches: result.mismatches,
      warnings: parsed.warnings,
    };
    await queryRows(
      this.dataSource.manager,
      `INSERT INTO reconciliation_reports (settlement_date, mismatch_count, report) VALUES ($1, $2, $3)`,
      [date, result.mismatches.length, JSON.stringify(report)],
    );
    this.logger.log(`reconciliation ${date}: ${result.matched} matched, ${result.mismatches.length} mismatches`);
    return report;
  }

  /** Our transactions whose value date (Asia/Tehran) is `date`, as signed Rial amounts. */
  private async loadDayRecords(date: string): Promise<LedgerRecord[]> {
    const tz = this.config.rules.limitTimezone;
    const rows = await queryRows<{ kind: LedgerRecord['kind']; reference: string; amount_rial: string; id: string }>(
      this.dataSource.manager,
      `SELECT 'DEPOSIT' AS kind, psp_ref_id AS reference, verified_amount_rial AS amount_rial, id::text
         FROM deposits
        WHERE status = 'SUCCEEDED' AND (verified_at AT TIME ZONE $2)::date = $1::date
       UNION ALL
       SELECT 'WITHDRAWAL', provider_tracking_id, -(amount * 10), id::text
         FROM withdrawals
        WHERE currency = 'IRT' AND settle_journal_id IS NOT NULL AND provider_tracking_id IS NOT NULL
          AND (provider_succeeded_at AT TIME ZONE $2)::date = $1::date
       UNION ALL
       SELECT 'WITHDRAWAL_RETURN', provider_tracking_id, amount * 10, id::text
         FROM withdrawals
        WHERE currency = 'IRT' AND return_journal_id IS NOT NULL AND provider_tracking_id IS NOT NULL
          AND (provider_returned_at AT TIME ZONE $2)::date = $1::date`,
      [date, tz],
    );
    return rows.map((r) => ({ kind: r.kind, reference: r.reference, amountRial: BigInt(r.amount_rial), id: r.id }));
  }

  /** Our records carrying any of these references, whatever their value date. */
  private async loadRecordsByReference(references: string[]): Promise<LedgerRecord[]> {
    if (!references.length) return [];
    const rows = await queryRows<{ kind: LedgerRecord['kind']; reference: string; amount_rial: string; id: string }>(
      this.dataSource.manager,
      `SELECT 'DEPOSIT' AS kind, psp_ref_id AS reference, verified_amount_rial AS amount_rial, id::text
         FROM deposits WHERE status = 'SUCCEEDED' AND psp_ref_id = ANY($1::text[])
       UNION ALL
       SELECT 'WITHDRAWAL', provider_tracking_id, -(amount * 10), id::text
         FROM withdrawals WHERE currency = 'IRT' AND settle_journal_id IS NOT NULL AND provider_tracking_id = ANY($1::text[])
       UNION ALL
       SELECT 'WITHDRAWAL_RETURN', provider_tracking_id, amount * 10, id::text
         FROM withdrawals WHERE currency = 'IRT' AND return_journal_id IS NOT NULL AND provider_tracking_id = ANY($1::text[])`,
      [references],
    );
    return rows.map((r) => ({ kind: r.kind, reference: r.reference, amountRial: BigInt(r.amount_rial), id: r.id }));
  }

  private async loadWithdrawalRefs(references: string[]): Promise<Set<string>> {
    if (!references.length) return new Set();
    const rows = await queryRows<{ ref: string }>(
      this.dataSource.manager,
      `SELECT provider_tracking_id AS ref FROM withdrawals WHERE provider_tracking_id = ANY($1::text[])`,
      [references],
    );
    return new Set(rows.map((r) => normalizeReference(r.ref)));
  }
}
