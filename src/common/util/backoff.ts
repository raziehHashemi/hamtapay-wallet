/** Exponential backoff: base * 2^attempt, capped. `attempt` starts at 0. */
export function exponentialBackoffMs(attempt: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(attempt, 0), 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
