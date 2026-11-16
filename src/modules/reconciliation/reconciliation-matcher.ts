import { normalizeReference, SettlementKind, SettlementRow } from './settlement-parser';

export type LedgerRecordKind = 'DEPOSIT' | 'WITHDRAWAL' | 'WITHDRAWAL_RETURN';

/** One of our own transactions, expressed the way the bank sees it (signed Rial). */
export interface LedgerRecord {
  kind: LedgerRecordKind;
  reference: string;
  amountRial: bigint;
  /** deposit / withdrawal id in this service */
  id: string;
}

export type MismatchType =
  | 'MISSING_IN_LEDGER'
  | 'MISSING_IN_SETTLEMENT'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE_IN_SETTLEMENT'
  | 'UNKNOWN_ROW_TYPE';

export interface Mismatch {
  type: MismatchType;
  kind: SettlementKind | LedgerRecordKind;
  reference: string;
  currency: 'IRR';
  settlementAmount: string | null;
  ledgerAmount: string | null;
  ledgerId?: string;
  rowNumbers?: number[];
  note?: string;
}

export interface MatchResult {
  matched: number;
  matchedOnOtherDay: number;
  bankFeeRows: number;
  bankFeesRial: bigint;
  mismatches: Mismatch[];
}

/**
 * Pure comparison of a settlement file against our records. It only *reports*; it never changes anything.
 *
 * @param dayRecords   our records whose value date is the requested day
 * @param otherDayRecords our records with the same references but another value date (midnight skew between
 *                     our clock and the PSP's), used to avoid false "missing in ledger" reports
 * @param knownWithdrawalRefs tracking ids of all our IBAN withdrawals — bank fee rows that point at them are
 *                     an expected cost (the bank charges 2,500 IRR per Paya transfer) rather than a mismatch
 */
export function matchSettlement(
  rows: SettlementRow[],
  dayRecords: LedgerRecord[],
  otherDayRecords: LedgerRecord[],
  knownWithdrawalRefs: Set<string>,
): MatchResult {
  const key = (kind: string, ref: string) => `${kind}|${normalizeReference(ref)}`;
  const ours = new Map(dayRecords.map((r) => [key(r.kind, r.reference), r]));
  const elsewhere = new Map(otherDayRecords.map((r) => [key(r.kind, r.reference), r]));
  const result: MatchResult = { matched: 0, matchedOnOtherDay: 0, bankFeeRows: 0, bankFeesRial: 0n, mismatches: [] };
  const seen = new Map<string, number[]>();

  for (const row of rows) {
    if (row.kind === 'BANK_FEE') {
      if (knownWithdrawalRefs.has(normalizeReference(row.reference))) {
        result.bankFeeRows++;
        result.bankFeesRial += row.amountRial;
      } else {
        result.mismatches.push(missingInLedger(row, 'bank fee for a transfer we do not know'));
      }
      continue;
    }
    if (row.kind === 'UNKNOWN') {
      result.mismatches.push({
        type: 'UNKNOWN_ROW_TYPE',
        kind: 'UNKNOWN',
        reference: row.reference,
        currency: 'IRR',
        settlementAmount: row.amountRial.toString(),
        ledgerAmount: null,
        rowNumbers: [row.rowNumber],
        note: `unrecognised transaction type "${row.rawType}"`,
      });
      continue;
    }

    const k = key(row.kind, row.reference);
    const rowsForKey = [...(seen.get(k) ?? []), row.rowNumber];
    seen.set(k, rowsForKey);
    if (rowsForKey.length > 1) {
      result.mismatches.push({
        type: 'DUPLICATE_IN_SETTLEMENT',
        kind: row.kind,
        reference: row.reference,
        currency: 'IRR',
        settlementAmount: row.amountRial.toString(),
        ledgerAmount: null,
        rowNumbers: rowsForKey,
        note: 'same reference settled more than once under different row numbers',
      });
      continue;
    }

    const record = ours.get(k) ?? elsewhere.get(k);
    if (!record) {
      result.mismatches.push(missingInLedger(row));
      continue;
    }
    if (record.amountRial !== row.amountRial) {
      result.mismatches.push({
        type: 'AMOUNT_MISMATCH',
        kind: row.kind,
        reference: row.reference,
        currency: 'IRR',
        settlementAmount: row.amountRial.toString(),
        ledgerAmount: record.amountRial.toString(),
        ledgerId: record.id,
        rowNumbers: [row.rowNumber],
      });
    } else if (ours.has(k)) {
      result.matched++;
    } else {
      result.matchedOnOtherDay++;
    }
    ours.delete(k);
  }

  for (const record of ours.values()) {
    result.mismatches.push({
      type: 'MISSING_IN_SETTLEMENT',
      kind: record.kind,
      reference: record.reference,
      currency: 'IRR',
      settlementAmount: null,
      ledgerAmount: record.amountRial.toString(),
      ledgerId: record.id,
    });
  }
  return result;
}

function missingInLedger(row: SettlementRow, note?: string): Mismatch {
  return {
    type: 'MISSING_IN_LEDGER',
    kind: row.kind,
    reference: row.reference,
    currency: 'IRR',
    settlementAmount: row.amountRial.toString(),
    ledgerAmount: null,
    rowNumbers: [row.rowNumber],
    ...(note ? { note } : {}),
  };
}
