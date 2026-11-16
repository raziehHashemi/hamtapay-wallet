import { decideOnInquiry, decideOnVerify, nextDepositCheckDelayMs, VERIFY_RETRY_MS } from './deposit-policy';

describe('deposit policy', () => {
  describe('decideOnInquiry', () => {
    it('waits while the payer has not paid (never verifies an INIT payment: verify would say FAILED)', () => {
      expect(decideOnInquiry('INIT')).toEqual({ action: 'WAIT' });
    });
    it.each(['PAID', 'VERIFIED'])('verifies when %s', (status) => {
      expect(decideOnInquiry(status)).toEqual({ action: 'VERIFY' });
    });
    it('fails on FAILED and REVERSED', () => {
      expect(decideOnInquiry('FAILED')).toEqual({ action: 'FAIL', reason: 'PAYMENT_FAILED' });
      expect(decideOnInquiry('REVERSED')).toEqual({ action: 'FAIL', reason: 'PAYMENT_REVERSED' });
    });
    it('treats unknown tokens and statuses as anomalies, not failures', () => {
      expect(decideOnInquiry(null).action).toBe('ANOMALY');
      expect(decideOnInquiry('SOMETHING_NEW').action).toBe('ANOMALY');
    });
  });

  describe('decideOnVerify', () => {
    it('credits the verified amount converted from Rial to Toman', () => {
      expect(
        decideOnVerify(500_000n, {
          kind: 'VERIFIED',
          amountRial: 5_000_000n,
          refId: '123',
          alreadyVerified: false,
        }),
      ).toEqual({
        action: 'CREDIT',
        creditToman: 500_000n,
        refId: '123',
        verifiedRial: 5_000_000n,
        anomaly: null,
      });
    });

    it('treats ALREADY_VERIFIED (code 101) as success: crash between verify and credit is recoverable', () => {
      expect(
        decideOnVerify(500_000n, {
          kind: 'VERIFIED',
          amountRial: 5_000_000n,
          refId: '1',
          alreadyVerified: true,
        }).action,
      ).toBe('CREDIT');
    });

    it('credits what was really paid and flags a mismatch (never more than paid)', () => {
      const decision = decideOnVerify(500_000n, {
        kind: 'VERIFIED',
        amountRial: 4_000_005n,
        refId: '9',
        alreadyVerified: false,
      });
      expect(decision).toMatchObject({ action: 'CREDIT', creditToman: 400_000n });
      expect(decision.action === 'CREDIT' && decision.anomaly).toContain('AMOUNT_MISMATCH');
    });

    it('fails when the PSP reversed the payment (not verified in time)', () => {
      expect(decideOnVerify(1n, { kind: 'EXPIRED', code: -54, message: 'x' })).toEqual({
        action: 'FAIL',
        reason: 'PAYMENT_REVERSED',
      });
    });

    it.each([
      { kind: 'UNAVAILABLE', reason: '503' } as const,
      { kind: 'NOT_PAID', code: -51, message: 'x' } as const,
      { kind: 'UNKNOWN_TOKEN' } as const,
    ])('retries on %o (never fails a deposit on a transient answer)', (outcome) => {
      expect(decideOnVerify(1n, outcome).action).toBe('RETRY');
    });
  });

  describe('nextDepositCheckDelayMs', () => {
    const config = {
      depositFirstCheckMs: 5000,
      depositPollCapMs: 30000,
      depositStopPollingAfterMs: 86_400_000,
    };

    it('retries verification quickly (PSP reverses unverified payments after 10 minutes)', () => {
      expect(nextDepositCheckDelayMs({ verifying: true, attempts: 50, ageMs: 0 }, config)).toBe(
        VERIFY_RETRY_MS,
      );
    });
    it('backs off exponentially for unpaid deposits, capped', () => {
      const delays = [1, 2, 3, 4, 9].map((attempts) =>
        nextDepositCheckDelayMs({ verifying: false, attempts, ageMs: 1000 }, config),
      );
      expect(delays).toEqual([5000, 10000, 20000, 30000, 30000]);
    });
    it('stops polling abandoned deposits after a day (callbacks still work)', () => {
      expect(
        nextDepositCheckDelayMs({ verifying: false, attempts: 1, ageMs: 86_400_000 }, config),
      ).toBeNull();
    });
  });
});
