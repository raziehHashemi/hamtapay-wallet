import { LedgerRecord, matchSettlement } from './reconciliation-matcher';
import { SettlementRow } from './settlement-parser';

const row = (
  rowNumber: number,
  kind: SettlementRow['kind'],
  reference: string,
  amountRial: bigint,
): SettlementRow => ({
  rowNumber,
  date: '1405/08/25',
  reference,
  rawType: kind,
  kind,
  amountRial,
  description: '',
});
const rec = (kind: LedgerRecord['kind'], reference: string, amountRial: bigint, id = 'x'): LedgerRecord => ({
  kind,
  reference,
  amountRial,
  id,
});

describe('matchSettlement', () => {
  it('matches identical records and books Paya fees of known transfers as expected costs', () => {
    const result = matchSettlement(
      [
        row(1, 'DEPOSIT', '111', 1_000_000n),
        row(2, 'WITHDRAWAL', 'TRKa', -5_000_000n),
        row(3, 'BANK_FEE', 'TRKa', -2500n),
      ],
      [rec('DEPOSIT', '111', 1_000_000n), rec('WITHDRAWAL', 'TRKa', -5_000_000n)],
      [],
      new Set(['TRKa']),
    );
    expect(result).toMatchObject({ matched: 2, bankFeeRows: 1, bankFeesRial: -2500n, mismatches: [] });
  });

  it('reports every kind of mismatch', () => {
    const result = matchSettlement(
      [
        row(1, 'DEPOSIT', '111', 1_000_000n), // amount differs
        row(2, 'DEPOSIT', '999', 500_000n), // unknown to us ("پرداخت اینترنتی نامشخص")
        row(3, 'BANK_FEE', 'TRKzzz', -2500n), // fee for a transfer we do not know
        row(4, 'UNKNOWN', 'abc', 10n),
        row(5, 'WITHDRAWAL_RETURN', 'TRKb', 7_000_000n),
        row(6, 'WITHDRAWAL_RETURN', 'TRKb', 7_000_000n), // same ref twice under different row numbers
      ],
      [
        rec('DEPOSIT', '111', 900_000n, 'dep-1'),
        rec('WITHDRAWAL', 'TRKmissing', -1n, 'wd-1'),
        rec('WITHDRAWAL_RETURN', 'TRKb', 7_000_000n),
      ],
      [],
      new Set(),
    );
    const types = result.mismatches.map((m) => `${m.type}:${m.reference}`).sort();
    expect(types).toEqual(
      [
        'AMOUNT_MISMATCH:111',
        'MISSING_IN_LEDGER:999',
        'MISSING_IN_LEDGER:TRKzzz',
        'UNKNOWN_ROW_TYPE:abc',
        'DUPLICATE_IN_SETTLEMENT:TRKb',
        'MISSING_IN_SETTLEMENT:TRKmissing',
      ].sort(),
    );
    const amount = result.mismatches.find((m) => m.type === 'AMOUNT_MISMATCH')!;
    expect(amount).toMatchObject({
      settlementAmount: '1000000',
      ledgerAmount: '900000',
      ledgerId: 'dep-1',
      currency: 'IRR',
    });
    expect(result.matched).toBe(1);
  });

  it('does not report records booked on the neighbouring day (midnight clock skew) as missing', () => {
    const result = matchSettlement(
      [row(1, 'DEPOSIT', '111', 100n)],
      [],
      [rec('DEPOSIT', '111', 100n)],
      new Set(),
    );
    expect(result).toMatchObject({ matched: 0, matchedOnOtherDay: 1, mismatches: [] });
  });

  it('matches padded references against stored ones', () => {
    const result = matchSettlement(
      [row(1, 'DEPOSIT', '0006122297631', 100n)],
      [rec('DEPOSIT', '6122297631', 100n)],
      [],
      new Set(),
    );
    expect(result.mismatches).toEqual([]);
  });
});
