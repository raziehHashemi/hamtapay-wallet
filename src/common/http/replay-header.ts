import type { Response } from 'express';

/** Signals to clients (and to people reading logs) that the response is a stored idempotent replay. */
export function markReplay(response: Response, replayed: boolean): void {
  if (replayed) response.setHeader('Idempotent-Replayed', 'true');
}
