import { Currency } from '../../common/money/currency';

export enum AccountKind {
  /** Liability: money the user can spend right now (`available`). */
  USER_AVAILABLE = 'USER_AVAILABLE',
  /** Liability: money reserved for in-flight withdrawals (`held`). */
  USER_HELD = 'USER_HELD',
  /** Asset: money the user owes the exchange (only after a reconciled double payout, see ambiguities.md #1). */
  USER_RECEIVABLE = 'USER_RECEIVABLE',
  /** Asset: money collected by the payment gateway on our behalf. */
  PSP_CLEARING = 'PSP_CLEARING',
  /** Asset: our float at the payout provider / bank (decreases when a withdrawal is paid out). */
  PAYOUT_CLEARING = 'PAYOUT_CLEARING',
  /** Revenue: withdrawal fees. */
  FEE_REVENUE = 'FEE_REVENUE',
  /** Expense: manual balance increases performed by the operations team. */
  OPS_ADJUSTMENTS = 'OPS_ADJUSTMENTS',
}

export type Direction = 'DEBIT' | 'CREDIT';

export const USER_ACCOUNT_KINDS: readonly AccountKind[] = [
  AccountKind.USER_AVAILABLE,
  AccountKind.USER_HELD,
  AccountKind.USER_RECEIVABLE,
];

export const NORMAL_SIDE: Readonly<Record<AccountKind, Direction>> = {
  [AccountKind.USER_AVAILABLE]: 'CREDIT',
  [AccountKind.USER_HELD]: 'CREDIT',
  [AccountKind.USER_RECEIVABLE]: 'DEBIT',
  [AccountKind.PSP_CLEARING]: 'DEBIT',
  [AccountKind.PAYOUT_CLEARING]: 'DEBIT',
  [AccountKind.FEE_REVENUE]: 'CREDIT',
  [AccountKind.OPS_ADJUSTMENTS]: 'DEBIT',
};

export enum JournalType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL_HOLD = 'WITHDRAWAL_HOLD',
  WITHDRAWAL_SETTLE = 'WITHDRAWAL_SETTLE',
  WITHDRAWAL_RELEASE = 'WITHDRAWAL_RELEASE',
  WITHDRAWAL_RETURN = 'WITHDRAWAL_RETURN',
  WITHDRAWAL_LATE_SUCCESS = 'WITHDRAWAL_LATE_SUCCESS',
  TRANSFER = 'TRANSFER',
  ADJUSTMENT = 'ADJUSTMENT',
  ADJUSTMENT_REVERSAL = 'ADJUSTMENT_REVERSAL',
}

export interface AccountRef {
  kind: AccountKind;
  currency: Currency;
  /** Required for USER_* kinds, absent for system accounts. */
  userId?: string;
}

export interface PostingLine {
  account: AccountRef;
  direction: Direction;
  amount: bigint;
}

export interface JournalDraft {
  type: JournalType;
  /** Globally unique business key, e.g. `deposit:<id>:credit`. The DB refuses a second posting. */
  idempotencyRef: string;
  referenceType: string;
  referenceId: string;
  description?: string;
  reversesJournalId?: string;
  lines: PostingLine[];
}

export interface UserBalanceSnapshot {
  userId: string;
  currency: Currency;
  available: bigint;
  held: bigint;
  receivable: bigint;
}

export interface PostedJournal {
  journalId: string;
  balances: UserBalanceSnapshot[];
}

export const userAccount = (userId: string, currency: Currency, kind: AccountKind): AccountRef => ({
  userId,
  currency,
  kind,
});

export const systemAccount = (currency: Currency, kind: AccountKind): AccountRef => ({ currency, kind });

export const isUserKind = (kind: AccountKind): boolean => USER_ACCOUNT_KINDS.includes(kind);
