import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `X-Signature: hex(HMAC-SHA256(rawBody, secret))`. Must be computed over the exact bytes received
 * (re-serialising parsed JSON can change key order/spacing). Constant-time comparison.
 */
export function verifyWebhookSignature(rawBody: Buffer | undefined, signature: unknown, secret: string): boolean {
  if (!rawBody || typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function signWebhook(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}
