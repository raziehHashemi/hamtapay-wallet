import { Currency } from '../../common/money/currency';
import { assertValidJournal } from './journal-validator';
import { AccountKind, JournalDraft, JournalType, systemAccount, userAccount } from './ledger.types';

const draft = (lines: JournalDraft['lines']): JournalDraft => ({
  type: JournalType.TRANSFER,
  idempotencyRef: 'ref',
  referenceType: 'test',
  referenceId: '1',
  lines,
});

describe('assertValidJournal', () => {
  it('accepts a balanced journal', () => {
    expect(() =>
      assertValidJournal(
        draft([
          { account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING), direction: 'DEBIT', amount: 10n },
          {
            account: userAccount('u', Currency.IRT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: 10n,
          },
        ]),
      ),
    ).not.toThrow();
  });

  it('accepts a multi-leg journal (withdrawal settle with fee)', () => {
    expect(() =>
      assertValidJournal(
        draft([
          {
            account: userAccount('u', Currency.USDT, AccountKind.USER_HELD),
            direction: 'DEBIT',
            amount: 11n,
          },
          {
            account: systemAccount(Currency.USDT, AccountKind.PAYOUT_CLEARING),
            direction: 'CREDIT',
            amount: 10n,
          },
          { account: systemAccount(Currency.USDT, AccountKind.FEE_REVENUE), direction: 'CREDIT', amount: 1n },
        ]),
      ),
    ).not.toThrow();
  });

  it('rejects unbalanced journals', () => {
    expect(() =>
      assertValidJournal(
        draft([
          { account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING), direction: 'DEBIT', amount: 10n },
          {
            account: userAccount('u', Currency.IRT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: 9n,
          },
        ]),
      ),
    ).toThrow('unbalanced');
  });

  it('balances per currency, not in total', () => {
    expect(() =>
      assertValidJournal(
        draft([
          { account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING), direction: 'DEBIT', amount: 10n },
          {
            account: userAccount('u', Currency.USDT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: 10n,
          },
        ]),
      ),
    ).toThrow('unbalanced');
  });

  it.each([0n, -5n])('rejects non-positive amount %p', (amount) => {
    expect(() =>
      assertValidJournal(
        draft([
          { account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING), direction: 'DEBIT', amount },
          {
            account: userAccount('u', Currency.IRT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount,
          },
        ]),
      ),
    ).toThrow('positive');
  });

  it('rejects a user account without user and a system account with one', () => {
    expect(() =>
      assertValidJournal(
        draft([
          {
            account: { kind: AccountKind.USER_AVAILABLE, currency: Currency.IRT },
            direction: 'DEBIT',
            amount: 1n,
          },
          { account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING), direction: 'CREDIT', amount: 1n },
        ]),
      ),
    ).toThrow('must have a userId');
    expect(() =>
      assertValidJournal(
        draft([
          {
            account: { kind: AccountKind.FEE_REVENUE, currency: Currency.IRT, userId: 'u' },
            direction: 'DEBIT',
            amount: 1n,
          },
          {
            account: userAccount('u', Currency.IRT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: 1n,
          },
        ]),
      ),
    ).toThrow('cannot have a userId');
  });

  it('rejects the same account twice and single-line journals', () => {
    const a = userAccount('u', Currency.IRT, AccountKind.USER_AVAILABLE);
    expect(() =>
      assertValidJournal(
        draft([
          { account: a, direction: 'DEBIT', amount: 1n },
          { account: a, direction: 'CREDIT', amount: 1n },
        ]),
      ),
    ).toThrow('appears twice');
    expect(() => assertValidJournal(draft([{ account: a, direction: 'DEBIT', amount: 1n }]))).toThrow(
      'two lines',
    );
  });
});
