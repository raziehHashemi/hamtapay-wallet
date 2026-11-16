import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { formatMinor } from '../../common/money/money';
import { Currency } from '../../common/money/currency';
import { queryRows } from '../../database/sql';

export interface IntegrityReport {
  ok: boolean;
  checkedAt: string;
  unbalancedJournals: { journalId: string; currency: string; difference: string }[];
  balanceDrift: {
    accountId: string;
    userId: string;
    currency: string;
    kind: string;
    stored: string;
    ledger: string;
  }[];
  negativeBalances: number;
  trialBalance: { currency: string; debits: string; credits: string }[];
  systemAccounts: { currency: string; kind: string; balance: string }[];
}

/**
 * Re-derives every invariant from the raw entries. This is exactly the check that would have caught the
 * incident in the brief ("ledger sums are right but stored wallet balances are not") within one run.
 * Production would run it per account range on a replica; here it is cheap enough to run on demand.
 */
@Injectable()
export class LedgerIntegrityService {
  constructor(private readonly dataSource: DataSource) {}

  async check(): Promise<IntegrityReport> {
    const m = this.dataSource.manager;
    const unbalanced = await queryRows<{ journal_id: string; currency: string; diff: string }>(
      m,
      `SELECT journal_id, currency, SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS diff
         FROM ledger_entries GROUP BY journal_id, currency
       HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
        LIMIT 50`,
    );
    const drift = await queryRows<{
      id: string;
      owner_user_id: string;
      currency: string;
      kind: string;
      balance: string;
      ledger_balance: string;
    }>(
      m,
      `SELECT a.id, a.owner_user_id, a.currency, a.kind, a.balance,
              COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END), 0) AS ledger_balance
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_user_id IS NOT NULL
        GROUP BY a.id
       HAVING a.balance <> COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END), 0)
        LIMIT 50`,
    );
    const [negative] = await queryRows<{ n: string }>(
      m,
      `SELECT count(*) AS n FROM ledger_accounts WHERE balance < 0`,
    );
    const trial = await queryRows<{ currency: string; debits: string; credits: string }>(
      m,
      `SELECT currency,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0) AS debits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0) AS credits
         FROM ledger_entries GROUP BY currency ORDER BY currency`,
    );
    const system = await queryRows<{ currency: string; kind: string; balance: string }>(
      m,
      `SELECT a.currency, a.kind,
              COALESCE(SUM(CASE WHEN e.direction = a.normal_side THEN e.amount ELSE -e.amount END), 0) AS balance
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_user_id IS NULL
        GROUP BY a.id ORDER BY a.currency, a.kind`,
    );

    const fmt = (currency: string, v: string) => formatMinor(currency as Currency, BigInt(v));
    const negativeBalances = Number(negative.n);
    const trialBalanced = trial.every((t) => t.debits === t.credits);
    return {
      ok: unbalanced.length === 0 && drift.length === 0 && negativeBalances === 0 && trialBalanced,
      checkedAt: new Date().toISOString(),
      unbalancedJournals: unbalanced.map((u) => ({
        journalId: u.journal_id,
        currency: u.currency,
        difference: fmt(u.currency, u.diff),
      })),
      balanceDrift: drift.map((d) => ({
        accountId: d.id,
        userId: d.owner_user_id,
        currency: d.currency,
        kind: d.kind,
        stored: fmt(d.currency, d.balance),
        ledger: fmt(d.currency, d.ledger_balance),
      })),
      negativeBalances,
      trialBalance: trial.map((t) => ({
        currency: t.currency,
        debits: fmt(t.currency, t.debits),
        credits: fmt(t.currency, t.credits),
      })),
      systemAccounts: system.map((s) => ({
        currency: s.currency,
        kind: s.kind,
        balance: fmt(s.currency, s.balance),
      })),
    };
  }
}
