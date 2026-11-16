import type { ProviderTransferStatus } from '../../integrations/payout/payout-gateway';
import { WithdrawalStatus } from './withdrawal.entity';
import { decideTransition, isNewerProviderStatus } from './withdrawal-state-machine';

const view = (status: WithdrawalStatus, failureReason: string | null = null) => ({ status, failureReason });

describe('withdrawal state machine', () => {
  describe.each([WithdrawalStatus.PENDING, WithdrawalStatus.PROCESSING])('from %s', (status) => {
    it.each<[ProviderTransferStatus, string]>([
      ['ACCEPTED', 'TRACK'],
      ['PROCESSING', 'TRACK'],
      ['SUCCEEDED', 'SUCCEED'],
      ['FAILED', 'FAIL'],
      ['RETURNED', 'RETURN'],
    ])('%s -> %s', (observed, kind) => {
      expect(decideTransition(view(status), observed, null).kind).toBe(kind);
    });

    it('carries the provider reason into the failure reason', () => {
      expect(decideTransition(view(status), 'FAILED', 'BANK_REJECTED')).toEqual({
        kind: 'FAIL',
        reason: 'PROVIDER_FAILED:BANK_REJECTED',
      });
    });

    it('settles before refunding when RETURNED is the first final signal we see', () => {
      expect(decideTransition(view(status), 'RETURNED', 'ACCOUNT_CLOSED')).toEqual({
        kind: 'RETURN',
        reason: 'RETURNED:ACCOUNT_CLOSED',
        settleFirst: true,
      });
    });
  });

  describe('from SUCCEEDED', () => {
    it.each<ProviderTransferStatus>(['ACCEPTED', 'PROCESSING', 'SUCCEEDED'])(
      'ignores stale/duplicate %s (provider sends PROCESSING after the final webhook)',
      (observed) => {
        expect(decideTransition(view(WithdrawalStatus.SUCCEEDED), observed, null).kind).toBe('NOOP');
      },
    );

    it('refunds a RETURNED transfer without settling twice', () => {
      expect(decideTransition(view(WithdrawalStatus.SUCCEEDED), 'RETURNED', 'ACCOUNT_CLOSED')).toEqual({
        kind: 'RETURN',
        reason: 'RETURNED:ACCOUNT_CLOSED',
        settleFirst: false,
      });
    });

    it('never auto-applies a FAILED that contradicts a success', () => {
      expect(decideTransition(view(WithdrawalStatus.SUCCEEDED), 'FAILED', null).kind).toBe('ANOMALY');
    });
  });

  describe('from FAILED', () => {
    it('turns a later SUCCEEDED into the late-success compensation (ambiguity #1)', () => {
      for (const reason of [
        'PROVIDER_FAILED:BANK_REJECTED',
        'PROVIDER_REJECTED:400 INVALID_AMOUNT',
        'CANCELLED_BY_USER',
      ]) {
        expect(decideTransition(view(WithdrawalStatus.FAILED, reason), 'SUCCEEDED', null).kind).toBe(
          'LATE_SUCCESS',
        );
      }
    });

    it.each<ProviderTransferStatus>(['ACCEPTED', 'PROCESSING', 'FAILED'])('ignores %s', (observed) => {
      expect(decideTransition(view(WithdrawalStatus.FAILED, 'PROVIDER_FAILED:X'), observed, null).kind).toBe(
        'NOOP',
      );
    });

    it('is fully terminal once returned', () => {
      for (const observed of ['ACCEPTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'RETURNED'] as const) {
        expect(
          decideTransition(view(WithdrawalStatus.FAILED, 'RETURNED:ACCOUNT_CLOSED'), observed, null).kind,
        ).toBe('NOOP');
      }
    });

    it('flags RETURNED for a withdrawal we had failed', () => {
      expect(
        decideTransition(view(WithdrawalStatus.FAILED, 'PROVIDER_FAILED:X'), 'RETURNED', null).kind,
      ).toBe('ANOMALY');
    });
  });

  it('every (state, observation) pair has a defined, idempotent outcome', () => {
    const statuses = Object.values(WithdrawalStatus);
    const observations: ProviderTransferStatus[] = [
      'ACCEPTED',
      'PROCESSING',
      'SUCCEEDED',
      'FAILED',
      'RETURNED',
    ];
    for (const s of statuses) {
      for (const o of observations) {
        expect(
          decideTransition(view(s, s === WithdrawalStatus.FAILED ? 'PROVIDER_FAILED:X' : null), o, 'r'),
        ).toBeDefined();
      }
    }
  });

  it('keeps provider_status monotonic', () => {
    expect(isNewerProviderStatus(null, 'ACCEPTED')).toBe(true);
    expect(isNewerProviderStatus('ACCEPTED', 'PROCESSING')).toBe(true);
    expect(isNewerProviderStatus('SUCCEEDED', 'PROCESSING')).toBe(false);
    expect(isNewerProviderStatus('SUCCEEDED', 'RETURNED')).toBe(true);
    expect(isNewerProviderStatus('RETURNED', 'SUCCEEDED')).toBe(false);
  });
});
