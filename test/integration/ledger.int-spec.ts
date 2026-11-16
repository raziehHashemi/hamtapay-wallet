import { Currency } from '../../src/common/money/currency';
import { DomainError } from '../../src/common/errors/domain-error';
import { DuplicateJournalError, LedgerService } from '../../src/modules/ledger/ledger.service';
import { AccountKind, JournalType, systemAccount, userAccount } from '../../src/modules/ledger/ledger.types';
import { createTestApp, expectLedgerIntact, TestApp, uniqueUser } from '../support/test-app';

/** Guarantees that hold even if application code is wrong: they are enforced by PostgreSQL itself. */
describe('ledger (real PostgreSQL)', () => {
  let t: TestApp;
  let ledger: LedgerService;

  beforeAll(async () => {
    t = await createTestApp();
    ledger = t.app.get(LedgerService);
  });
  afterAll(() => t.close());

  const credit = (userId: string, amount: bigint, ref = `test:${userId}:${amount}:${Math.random()}`) =>
    t.dataSource.transaction((m) =>
      ledger.post(m, {
        type: JournalType.ADJUSTMENT,
        idempotencyRef: ref,
        referenceType: 'test',
        referenceId: userId,
        lines: [
          { account: systemAccount(Currency.IRT, AccountKind.OPS_ADJUSTMENTS), direction: 'DEBIT', amount },
          { account: userAccount(userId, Currency.IRT, AccountKind.USER_AVAILABLE), direction: 'CREDIT', amount },
        ],
      }),
    );

  it('posts a balanced journal, materialises the balance and records balance_after', async () => {
    const user = uniqueUser();
    const posted = await credit(user, 700n);
    await credit(user, 300n);
    const balance = await ledger.getUserBalance(t.dataSource.manager, user, Currency.IRT);
    expect(balance.available).toBe(1000n);
    const entries = await t.dataSource.query(
      `SELECT direction, amount, balance_after FROM ledger_entries WHERE owner_user_id = $1 ORDER BY id`,
      [user],
    );
    expect(entries).toEqual([
      { direction: 'CREDIT', amount: '700', balance_after: '700' },
      { direction: 'CREDIT', amount: '300', balance_after: '1000' },
    ]);
    expect(posted.balances[0]).toMatchObject({ userId: user, available: 700n });
  });

  it('writes the balance-changed outbox event in the same transaction (rollback => no event, no balance)', async () => {
    const user = uniqueUser();
    await expect(
      t.dataSource.transaction(async (m) => {
        await ledger.post(m, {
          type: JournalType.ADJUSTMENT,
          idempotencyRef: `rollback:${user}`,
          referenceType: 'test',
          referenceId: user,
          lines: [
            { account: systemAccount(Currency.IRT, AccountKind.OPS_ADJUSTMENTS), direction: 'DEBIT', amount: 5n },
            { account: userAccount(user, Currency.IRT, AccountKind.USER_AVAILABLE), direction: 'CREDIT', amount: 5n },
          ],
        });
        throw new Error('crash after posting, before commit');
      }),
    ).rejects.toThrow('crash');
    const [events] = await t.dataSource.query(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [user]);
    expect(events.n).toBe(0);
    expect((await ledger.getUserBalance(t.dataSource.manager, user, Currency.IRT)).available).toBe(0n);

    await credit(user, 5n);
    const [after] = await t.dataSource.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'wallet.balance_changed'`,
      [user],
    );
    expect(after.n).toBe(1);
  });

  it('refuses to spend more than the available balance (INSUFFICIENT_FUNDS, nothing written)', async () => {
    const user = uniqueUser();
    await credit(user, 100n);
    const spend = t.dataSource.transaction((m) =>
      ledger.post(m, {
        type: JournalType.TRANSFER,
        idempotencyRef: `overspend:${user}`,
        referenceType: 'test',
        referenceId: user,
        lines: [
          { account: userAccount(user, Currency.IRT, AccountKind.USER_AVAILABLE), direction: 'DEBIT', amount: 101n },
          { account: userAccount(`${user}-b`, Currency.IRT, AccountKind.USER_AVAILABLE), direction: 'CREDIT', amount: 101n },
        ],
      }),
    );
    await expect(spend).rejects.toBeInstanceOf(DomainError);
    expect((await ledger.getUserBalance(t.dataSource.manager, user, Currency.IRT)).available).toBe(100n);
  });

  it('posts a business event only once (unique idempotency ref)', async () => {
    const user = uniqueUser();
    await credit(user, 10n, `once:${user}`);
    await expect(credit(user, 10n, `once:${user}`)).rejects.toBeInstanceOf(DuplicateJournalError);
    expect((await ledger.getUserBalance(t.dataSource.manager, user, Currency.IRT)).available).toBe(10n);
  });

  describe('database-level defences (bypassing the application)', () => {
    it('ledger entries and journals are append-only', async () => {
      const user = uniqueUser();
      await credit(user, 10n);
      await expect(t.dataSource.query(`UPDATE ledger_entries SET amount = 1 WHERE owner_user_id = $1`, [user])).rejects.toThrow(
        /append-only/,
      );
      await expect(t.dataSource.query(`DELETE FROM ledger_entries WHERE owner_user_id = $1`, [user])).rejects.toThrow(
        /append-only/,
      );
      await expect(
        t.dataSource.query(`UPDATE ledger_journals SET description = 'x' WHERE reference_id = $1`, [user]),
      ).rejects.toThrow(/append-only/);
    });

    it('an unbalanced journal cannot be committed', async () => {
      const [{ id: accountId }] = await t.dataSource.query(
        `SELECT id FROM ledger_accounts WHERE owner_user_id IS NULL AND kind = 'PSP_CLEARING' AND currency = 'IRT'`,
      );
      await expect(
        t.dataSource.transaction(async (m) => {
          const [{ id }] = await m.query(
            `INSERT INTO ledger_journals (type, idempotency_ref, reference_type, reference_id)
             VALUES ('TEST', $1, 'test', 'x') RETURNING id`,
            [`unbalanced:${Math.random()}`],
          );
          await m.query(
            `INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount) VALUES ($1, $2, 'IRT', 'DEBIT', 50)`,
            [id, accountId],
          );
        }),
      ).rejects.toThrow(/unbalanced/);
    });

    it('a user balance can never be negative, even by direct SQL', async () => {
      const user = uniqueUser();
      await credit(user, 10n);
      await expect(
        t.dataSource.query(`UPDATE ledger_accounts SET balance = -1 WHERE owner_user_id = $1 AND kind = 'USER_AVAILABLE'`, [
          user,
        ]),
      ).rejects.toThrow(/ledger_accounts_balance_non_negative_ck/);
    });

    it("an entry's currency must match its account's currency", async () => {
      const [{ id: accountId }] = await t.dataSource.query(
        `SELECT id FROM ledger_accounts WHERE owner_user_id IS NULL AND kind = 'PSP_CLEARING' AND currency = 'IRT'`,
      );
      await expect(
        t.dataSource.transaction(async (m) => {
          const [{ id }] = await m.query(
            `INSERT INTO ledger_journals (type, idempotency_ref, reference_type, reference_id) VALUES ('TEST', $1, 'test', 'x') RETURNING id`,
            [`fx:${Math.random()}`],
          );
          await m.query(
            `INSERT INTO ledger_entries (journal_id, account_id, currency, direction, amount) VALUES ($1, $2, 'USDT', 'DEBIT', 1)`,
            [id, accountId],
          );
        }),
      ).rejects.toThrow(/ledger_entries_account_fk/);
    });
  });

  it('leaves the whole ledger consistent', async () => {
    await expectLedgerIntact(t);
  });
});
