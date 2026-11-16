import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gregorianToJalali, isoDateToJalali } from './jalali';
import {
  normalizeDigits,
  normalizeReference,
  parseRialAmount,
  parseSettlementCsv,
  splitCsvLine,
} from './settlement-parser';

const fixture = readFileSync(join(__dirname, '__fixtures__', 'settlement-sample.csv'), 'utf8');

describe('settlement CSV parser', () => {
  describe('primitives', () => {
    it('normalises Persian and Arabic-Indic digits', () => {
      expect(normalizeDigits('۱۴۰۵/۰۸/۲۵')).toBe('1405/08/25');
      expect(normalizeDigits('٣٤٥')).toBe('345');
    });

    it('parses Rial amounts with any thousands separator and sign', () => {
      expect(parseRialAmount('1,000,000')).toBe(1_000_000n);
      expect(parseRialAmount('۱٬۰۰۰٬۰۰۰')).toBe(1_000_000n);
      expect(parseRialAmount('-۲٬۵۰۰')).toBe(-2500n);
      expect(parseRialAmount('−500')).toBe(-500n);
      expect(() => parseRialAmount('12.5')).toThrow();
    });

    it('strips reference padding but keeps case', () => {
      expect(normalizeReference('0006122297631')).toBe('6122297631');
      expect(normalizeReference(' TRK01a5380ec978c05a ')).toBe('TRK01a5380ec978c05a');
      expect(normalizeReference('000TRK65909d0f684067ff')).toBe('TRK65909d0f684067ff');
    });

    it('splits quoted CSV fields', () => {
      expect(splitCsvLine('1,"1,000","a ""b"""')).toEqual(['1', '1,000', 'a "b"']);
    });
  });

  describe('real file captured from the provider', () => {
    const parsed = parseSettlementCsv(fixture);

    it('starts with a UTF-8 BOM and uses CRLF (as delivered)', () => {
      expect(fixture.charCodeAt(0)).toBe(0xfeff);
      expect(fixture).toContain('\r\n');
    });

    it('removes exact duplicate lines and counts them', () => {
      expect(parsed.duplicateLinesIgnored).toBe(5);
      const rowNumbers = parsed.rows.map((r) => r.rowNumber);
      expect(new Set(rowNumbers).size).toBe(rowNumbers.length);
      expect(parsed.rows).toHaveLength(24);
    });

    it('classifies rows and converts amounts to signed Rial', () => {
      const byKind = (kind: string) => parsed.rows.filter((r) => r.kind === kind);
      expect(byKind('DEPOSIT')).toHaveLength(5);
      expect(byKind('WITHDRAWAL')).toHaveLength(9);
      expect(byKind('BANK_FEE')).toHaveLength(9);
      expect(byKind('WITHDRAWAL_RETURN')).toHaveLength(1);
      expect(byKind('UNKNOWN')).toHaveLength(0);
      expect(byKind('WITHDRAWAL').every((r) => r.amountRial === -1_000_000n)).toBe(true);
      expect(byKind('BANK_FEE').every((r) => r.amountRial === -2500n)).toBe(true);
      expect(byKind('WITHDRAWAL_RETURN')[0].amountRial).toBe(1_000_000n);
    });

    it('normalises padded references and Jalali dates', () => {
      const first = parsed.rows[0];
      expect(first).toMatchObject({ rowNumber: 1, reference: '6122297631', date: '1405/08/25', amountRial: 1_000_000n });
      expect(parsed.rows.some((r) => r.reference.startsWith('0') || r.reference !== r.reference.trim())).toBe(false);
    });

    it('produces no warnings for a well-formed file', () => {
      expect(parsed.warnings).toEqual([]);
    });
  });

  it('warns about a row number reused with different content', () => {
    const csv = 'ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح\n1,1405/08/25,111,واریز درگاه,"100",x\n1,1405/08/25,222,واریز درگاه,"200",y\n';
    const parsed = parseSettlementCsv(csv);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.warnings[0]).toContain('row 1 appears twice');
  });

  it('rejects a file without the expected columns', () => {
    expect(() => parseSettlementCsv('a,b,c\n1,2,3\n')).toThrow('unexpected settlement header');
  });
});

describe('Jalali calendar', () => {
  it.each([
    ['2026-11-16', '1405/08/25'],
    ['2026-03-21', '1405/01/01'],
    ['2025-03-21', '1404/01/01'],
    ['2024-03-20', '1403/01/01'],
    ['2023-09-23', '1402/07/01'],
  ])('%s is %s', (iso, jalali) => {
    expect(isoDateToJalali(iso)).toBe(jalali);
  });

  it('returns numeric parts', () => {
    expect(gregorianToJalali(2026, 11, 16)).toEqual([1405, 8, 25]);
  });
});
