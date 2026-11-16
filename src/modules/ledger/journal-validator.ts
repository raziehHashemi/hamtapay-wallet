import { isUserKind, JournalDraft } from './ledger.types';

/**
 * Structural checks that run before a journal touches the database. Violations are programming errors
 * (not user errors), so they throw plain `Error`s. The database re-checks balance with a deferred trigger.
 */
export function assertValidJournal(draft: JournalDraft): void {
  if (!draft.idempotencyRef) throw new Error('journal needs an idempotencyRef');
  if (draft.lines.length < 2) throw new Error('a journal needs at least two lines');

  const seen = new Set<string>();
  const net = new Map<string, bigint>();
  for (const line of draft.lines) {
    if (line.amount <= 0n) throw new Error(`journal line amounts must be positive (got ${line.amount})`);
    if (isUserKind(line.account.kind) !== Boolean(line.account.userId)) {
      throw new Error(`account ${line.account.kind} ${line.account.userId ? 'cannot' : 'must'} have a userId`);
    }
    const key = `${line.account.userId ?? '*'}|${line.account.currency}|${line.account.kind}`;
    if (seen.has(key)) throw new Error(`account ${key} appears twice in one journal`);
    seen.add(key);
    const signed = line.direction === 'DEBIT' ? line.amount : -line.amount;
    net.set(line.account.currency, (net.get(line.account.currency) ?? 0n) + signed);
  }
  for (const [currency, diff] of net) {
    if (diff !== 0n) throw new Error(`journal is unbalanced in ${currency} by ${diff}`);
  }
}
