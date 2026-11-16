import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Errors } from '../../common/errors/domain-error';
import { Currency, SUPPORTED_CURRENCIES } from '../../common/money/currency';
import { formatMinor } from '../../common/money/money';
import { queryOne, queryRows } from '../../database/sql';
import { OutboxService } from '../outbox/outbox.service';
import { assertValidJournal } from './journal-validator';
import {
  AccountKind,
  AccountRef,
  Direction,
  isUserKind,
  JournalDraft,
  NORMAL_SIDE,
  PostedJournal,
  UserBalanceSnapshot,
} from './ledger.types';

/** Thrown when a journal with the same idempotencyRef already exists; the transaction stays usable. */
export class DuplicateJournalError extends Error {
  constructor(readonly idempotencyRef: string) {
    super(`journal ${idempotencyRef} was already posted`);
  }
}

interface ResolvedLine {
  accountId: string;
  account: AccountRef;
  direction: Direction;
  amount: bigint;
}

export interface LedgerItem {
  id: string;
  journalId: string;
  type: string;
  currency: Currency;
  account: 'AVAILABLE' | 'HELD' | 'RECEIVABLE';
  direction: Direction;
  amount: string;
  balanceAfter: string | null;
  referenceType: string;
  referenceId: string;
  description: string | null;
  createdAt: string;
}

const BUCKET: Record<string, LedgerItem['account']> = {
  USER_AVAILABLE: 'AVAILABLE',
  USER_HELD: 'HELD',
  USER_RECEIVABLE: 'RECEIVABLE',
};

/**
 * The posting engine. It is the only code that writes ledger tables; every money movement in the service is
 * a call to `post()` inside the caller's transaction.
 *
 * Concurrency: user balances are changed with a single conditional UPDATE per account
 * (`... WHERE balance + delta >= 0`). PostgreSQL row locks serialise concurrent writers on the same wallet
 * across any number of service instances, and the predicate is re-evaluated on the latest row version, so
 * two withdrawals can never both spend the same money. Accounts are locked in ascending id order to rule out
 * deadlocks between e.g. opposite transfers A→B / B→A.
 */
@Injectable()
export class LedgerService {
  private systemAccounts: Map<string, string> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxService,
  ) {}

  /** Wallet "created on first use": idempotent creation of the user's accounts for a currency. */
  async ensureUserAccounts(userId: string, currency: Currency, manager?: EntityManager): Promise<void> {
    await queryRows(
      manager ?? this.dataSource.manager,
      `INSERT INTO ledger_accounts (owner_user_id, currency, kind, normal_side, balance)
       VALUES ($1, $2, 'USER_AVAILABLE', 'CREDIT', 0),
              ($1, $2, 'USER_HELD', 'CREDIT', 0),
              ($1, $2, 'USER_RECEIVABLE', 'DEBIT', 0)
       ON CONFLICT DO NOTHING`,
      [userId, currency],
    );
  }

  async post(manager: EntityManager, draft: JournalDraft): Promise<PostedJournal> {
    assertValidJournal(draft);
    const lines = await this.resolve(manager, draft);

    const journal = await queryOne<{ id: string }>(
      manager,
      `INSERT INTO ledger_journals (type, idempotency_ref, reference_type, reference_id, description, reverses_journal_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_ref) DO NOTHING
       RETURNING id`,
      [
        draft.type,
        draft.idempotencyRef,
        draft.referenceType,
        draft.referenceId,
        draft.description ?? null,
        draft.reversesJournalId ?? null,
      ],
    );
    if (!journal) throw new DuplicateJournalError(draft.idempotencyRef);

    const balanceAfter = await this.applyUserBalanceChanges(manager, lines);

    await queryRows(
      manager,
      `INSERT INTO ledger_entries (journal_id, account_id, currency, owner_user_id, direction, amount, balance_after)
       SELECT $1, t.account_id, t.currency, t.owner_user_id, t.direction, t.amount, t.balance_after
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[])
              AS t (account_id, currency, owner_user_id, direction, amount, balance_after)`,
      [
        journal.id,
        lines.map((l) => l.accountId),
        lines.map((l) => l.account.currency),
        lines.map((l) => l.account.userId ?? null),
        lines.map((l) => l.direction),
        lines.map((l) => l.amount.toString()),
        lines.map((l) => balanceAfter.get(l.accountId)?.toString() ?? null),
      ],
    );

    const balances = await this.publishBalanceChanges(manager, journal.id, draft, lines);
    return { journalId: journal.id, balances };
  }

  /** Posts the mirror image of an existing journal (the ledger is append-only; mistakes are corrected, not edited). */
  async reverse(
    manager: EntityManager,
    journalId: string,
    meta: Omit<JournalDraft, 'lines' | 'reversesJournalId'>,
  ): Promise<PostedJournal> {
    const entries = await queryRows<{
      owner_user_id: string | null;
      currency: Currency;
      kind: AccountKind;
      direction: Direction;
      amount: string;
    }>(
      manager,
      `SELECT a.owner_user_id, e.currency, a.kind, e.direction, e.amount
         FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
        WHERE e.journal_id = $1 ORDER BY e.id`,
      [journalId],
    );
    if (!entries.length) throw new Error(`journal ${journalId} not found`);
    return this.post(manager, {
      ...meta,
      reversesJournalId: journalId,
      lines: entries.map((e) => ({
        account: { kind: e.kind, currency: e.currency, userId: e.owner_user_id ?? undefined },
        direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        amount: BigInt(e.amount),
      })),
    });
  }

  async getUserBalance(manager: EntityManager, userId: string, currency: Currency): Promise<UserBalanceSnapshot> {
    const rows = await queryRows<{ kind: AccountKind; balance: string }>(
      manager,
      `SELECT kind, balance FROM ledger_accounts WHERE owner_user_id = $1 AND currency = $2`,
      [userId, currency],
    );
    return this.snapshot(userId, currency, rows);
  }

  /** Same as getUserBalance but row-locks the user's accounts until the transaction ends. */
  async lockUserBalance(manager: EntityManager, userId: string, currency: Currency): Promise<UserBalanceSnapshot> {
    const rows = await queryRows<{ kind: AccountKind; balance: string }>(
      manager,
      `SELECT kind, balance FROM ledger_accounts WHERE owner_user_id = $1 AND currency = $2 ORDER BY id FOR UPDATE`,
      [userId, currency],
    );
    return this.snapshot(userId, currency, rows);
  }

  /** Balances for every supported currency; zero for currencies the user never touched (no write on read). */
  async getUserBalances(userId: string): Promise<UserBalanceSnapshot[]> {
    const rows = await queryRows<{ currency: Currency; kind: AccountKind; balance: string }>(
      this.dataSource.manager,
      `SELECT currency, kind, balance FROM ledger_accounts WHERE owner_user_id = $1`,
      [userId],
    );
    return SUPPORTED_CURRENCIES.map((currency) =>
      this.snapshot(
        userId,
        currency,
        rows.filter((r) => r.currency === currency),
      ),
    );
  }

  /** Keyset-paginated history, newest first. Cost is O(log n + limit) regardless of history size or depth. */
  async getUserLedgerPage(
    userId: string,
    options: { limit: number; beforeId?: string | null; currency?: Currency | null },
  ): Promise<{ items: LedgerItem[]; hasMore: boolean }> {
    const params: unknown[] = [userId];
    let where = 'e.owner_user_id = $1';
    if (options.beforeId) {
      params.push(options.beforeId);
      where += ` AND e.id < $${params.length}`;
    }
    if (options.currency) {
      params.push(options.currency);
      where += ` AND e.currency = $${params.length}`;
    }
    params.push(options.limit + 1);
    const rows = await queryRows<{
      id: string;
      journal_id: string;
      type: string;
      currency: Currency;
      kind: string;
      direction: Direction;
      amount: string;
      balance_after: string | null;
      reference_type: string;
      reference_id: string;
      description: string | null;
      created_at: Date;
    }>(
      this.dataSource.manager,
      `SELECT e.id, e.journal_id, j.type, e.currency, a.kind, e.direction, e.amount, e.balance_after,
              j.reference_type, j.reference_id, j.description, e.created_at
         FROM ledger_entries e
         JOIN ledger_journals j ON j.id = e.journal_id
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE ${where}
        ORDER BY e.id DESC
        LIMIT $${params.length}`,
      params,
    );
    const hasMore = rows.length > options.limit;
    const items = rows.slice(0, options.limit).map((r) => ({
      id: r.id,
      journalId: r.journal_id,
      type: r.type,
      currency: r.currency,
      account: BUCKET[r.kind],
      direction: r.direction,
      amount: formatMinor(r.currency, BigInt(r.amount)),
      balanceAfter: r.balance_after === null ? null : formatMinor(r.currency, BigInt(r.balance_after)),
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    }));
    return { items, hasMore };
  }

  // ---------------------------------------------------------------------------------------------------------

  private async resolve(manager: EntityManager, draft: JournalDraft): Promise<ResolvedLine[]> {
    const system = await this.loadSystemAccounts(manager);
    const userIds = new Map<string, Map<string, string>>(); // `${userId}|${currency}` -> kind -> id

    const resolved: ResolvedLine[] = [];
    for (const line of draft.lines) {
      const { account } = line;
      let accountId: string | undefined;
      if (isUserKind(account.kind)) {
        const groupKey = `${account.userId}|${account.currency}`;
        if (!userIds.has(groupKey)) {
          userIds.set(groupKey, await this.loadUserAccounts(manager, account.userId!, account.currency));
        }
        accountId = userIds.get(groupKey)!.get(account.kind);
      } else {
        accountId = system.get(`${account.currency}|${account.kind}`);
      }
      if (!accountId) throw new Error(`ledger account not found: ${JSON.stringify(account)}`);
      resolved.push({ accountId, account, direction: line.direction, amount: line.amount });
    }
    return resolved;
  }

  private async loadUserAccounts(manager: EntityManager, userId: string, currency: Currency) {
    const select = () =>
      queryRows<{ id: string; kind: string }>(
        manager,
        `SELECT id, kind FROM ledger_accounts WHERE owner_user_id = $1 AND currency = $2`,
        [userId, currency],
      );
    let rows = await select();
    if (rows.length < 3) {
      await this.ensureUserAccounts(userId, currency, manager);
      rows = await select();
    }
    return new Map(rows.map((r) => [r.kind, r.id]));
  }

  private async loadSystemAccounts(manager: EntityManager): Promise<Map<string, string>> {
    if (!this.systemAccounts) {
      const rows = await queryRows<{ id: string; currency: string; kind: string }>(
        manager,
        `SELECT id, currency, kind FROM ledger_accounts WHERE owner_user_id IS NULL`,
      );
      this.systemAccounts = new Map(rows.map((r) => [`${r.currency}|${r.kind}`, r.id]));
    }
    return this.systemAccounts;
  }

  private async applyUserBalanceChanges(manager: EntityManager, lines: ResolvedLine[]): Promise<Map<string, bigint>> {
    const after = new Map<string, bigint>();
    const userLines = lines
      .filter((l) => isUserKind(l.account.kind))
      .sort((a, b) => (BigInt(a.accountId) < BigInt(b.accountId) ? -1 : 1));

    for (const line of userLines) {
      const delta = line.direction === NORMAL_SIDE[line.account.kind] ? line.amount : -line.amount;
      const row = await queryOne<{ balance: string }>(
        manager,
        `UPDATE ledger_accounts
            SET balance = balance + $2, updated_at = now()
          WHERE id = $1 AND balance + $2 >= 0
        RETURNING balance`,
        [line.accountId, delta.toString()],
      );
      if (!row) {
        if (line.account.kind === AccountKind.USER_AVAILABLE) throw Errors.insufficientFunds();
        throw new Error(`invariant violated: ${line.account.kind} of ${line.account.userId} would become negative`);
      }
      after.set(line.accountId, BigInt(row.balance));
    }
    return after;
  }

  private async publishBalanceChanges(
    manager: EntityManager,
    journalId: string,
    draft: JournalDraft,
    lines: ResolvedLine[],
  ): Promise<UserBalanceSnapshot[]> {
    const touched = new Map<string, { userId: string; currency: Currency }>();
    for (const l of lines) {
      if (l.account.userId) {
        touched.set(`${l.account.userId}|${l.account.currency}`, {
          userId: l.account.userId,
          currency: l.account.currency,
        });
      }
    }
    const snapshots: UserBalanceSnapshot[] = [];
    for (const { userId, currency } of touched.values()) {
      const snapshot = await this.getUserBalance(manager, userId, currency);
      snapshots.push(snapshot);
      await this.outbox.enqueue(manager, {
        type: 'wallet.balance_changed',
        aggregateType: 'wallet',
        aggregateId: userId,
        payload: {
          userId,
          currency,
          available: formatMinor(currency, snapshot.available),
          held: formatMinor(currency, snapshot.held),
          journalId,
          journalType: draft.type,
          referenceType: draft.referenceType,
          referenceId: draft.referenceId,
        },
      });
    }
    return snapshots;
  }

  private snapshot(
    userId: string,
    currency: Currency,
    rows: { kind: AccountKind | string; balance: string }[],
  ): UserBalanceSnapshot {
    const get = (kind: AccountKind) => BigInt(rows.find((r) => r.kind === kind)?.balance ?? 0);
    return {
      userId,
      currency,
      available: get(AccountKind.USER_AVAILABLE),
      held: get(AccountKind.USER_HELD),
      receivable: get(AccountKind.USER_RECEIVABLE),
    };
  }
}
