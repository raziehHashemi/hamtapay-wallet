/**
 * Parser for the PSP's daily settlement CSV. Every quirk below was observed in real files from the provider
 * (docs/provider-notes.md §S1, docs/evidence/settlement-sample.csv):
 *  - UTF-8 BOM, CRLF line endings, Persian header names;
 *  - digits mixed between ASCII and Persian (۰-۹) — also accept Arabic-Indic (٠-٩);
 *  - amounts quoted, with ',' or Arabic thousands separator '٬' (U+066C), negative for debits, in **Rial**;
 *  - references padded with leading zeros ("000TRK…", "0006122297631") or surrounding spaces;
 *  - exact duplicate lines (same row number) — de-duplicated, but counted;
 *  - Jalali dates.
 */
export type SettlementKind = 'DEPOSIT' | 'WITHDRAWAL' | 'WITHDRAWAL_RETURN' | 'BANK_FEE' | 'UNKNOWN';

export interface SettlementRow {
  rowNumber: number;
  date: string;
  reference: string;
  rawType: string;
  kind: SettlementKind;
  amountRial: bigint;
  description: string;
}

export interface ParsedSettlement {
  rows: SettlementRow[];
  duplicateLinesIgnored: number;
  warnings: string[];
}

const TYPE_MAP: Record<string, SettlementKind> = {
  'واریز درگاه': 'DEPOSIT',
  'برداشت پایا': 'WITHDRAWAL',
  'برگشت پایا': 'WITHDRAWAL_RETURN',
  کارمزد: 'BANK_FEE',
};

const HEADER = {
  row: 'ردیف',
  date: 'تاریخ',
  reference: 'شماره پیگیری',
  type: 'نوع تراکنش',
  amount: 'مبلغ',
  description: 'شرح',
};

export function normalizeDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

/** Canonical form used on both sides of the match: ASCII digits, trimmed, no leading zero padding. */
export function normalizeReference(value: string): string {
  const trimmed = normalizeDigits(value).trim();
  const stripped = trimmed.replace(/^0+/, '');
  return stripped || trimmed;
}

export function parseRialAmount(value: string): bigint {
  const cleaned = normalizeDigits(value)
    .trim()
    .replace(/[\s,٬،]/g, '')
    .replace(/^−/, '-');
  if (!/^-?\d+$/.test(cleaned)) throw new Error(`unparseable amount "${value}"`);
  return BigInt(cleaned);
}

/** RFC 4180 style line splitter (quoted fields, escaped quotes). */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

export function parseSettlementCsv(text: string): ParsedSettlement {
  const warnings: string[] = [];
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (!lines.length) return { rows: [], duplicateLinesIgnored: 0, warnings: ['empty settlement file'] };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.startsWith(name));
  const idx = {
    row: col(HEADER.row),
    date: col(HEADER.date),
    reference: col(HEADER.reference),
    type: col(HEADER.type),
    amount: col(HEADER.amount),
    description: col(HEADER.description),
  };
  if (idx.reference < 0 || idx.amount < 0 || idx.type < 0) {
    throw new Error(`unexpected settlement header: ${lines[0]}`);
  }
  if (idx.amount >= 0 && !header[idx.amount].includes('ریال')) {
    warnings.push(`amount column is "${header[idx.amount]}", expected Rial`);
  }

  const rows: SettlementRow[] = [];
  const seenLines = new Map<number, string>();
  let duplicates = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const rowNumber = idx.row >= 0 ? Number(normalizeDigits(cells[idx.row] ?? '').trim()) : i;
    const canonical = cells.map((c) => normalizeDigits(c).trim()).join('|');
    const previous = seenLines.get(rowNumber);
    if (previous !== undefined) {
      if (previous === canonical) {
        duplicates++;
        continue;
      }
      warnings.push(`row ${rowNumber} appears twice with different content`);
    }
    seenLines.set(rowNumber, canonical);
    try {
      const rawType = (cells[idx.type] ?? '').trim();
      rows.push({
        rowNumber,
        date: idx.date >= 0 ? normalizeDigits(cells[idx.date] ?? '').trim() : '',
        reference: normalizeReference(cells[idx.reference] ?? ''),
        rawType,
        kind: TYPE_MAP[rawType] ?? 'UNKNOWN',
        amountRial: parseRialAmount(cells[idx.amount] ?? ''),
        description: idx.description >= 0 ? (cells[idx.description] ?? '').trim() : '',
      });
    } catch (error) {
      warnings.push(`line ${i + 1} skipped: ${(error as Error).message}`);
    }
  }
  return { rows, duplicateLinesIgnored: duplicates, warnings };
}
