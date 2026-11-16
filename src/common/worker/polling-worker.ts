import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * Minimal background loop: runs `tick()` repeatedly, never overlapping, sleeping `intervalMs` when idle.
 * `nudge()` wakes it up early (e.g. right after a withdrawal is created) so latency is not bound to the
 * interval. All state lives in PostgreSQL, so any number of instances can run the same worker safely
 * (claims use `FOR UPDATE SKIP LOCKED` or leases) and a crashed instance's work is picked up by the others.
 */
export abstract class PollingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  protected readonly logger = new Logger(this.constructor.name);
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  protected abstract readonly intervalMs: number;
  protected abstract enabled(): boolean;
  /** Processes one batch. Returns true when more work is probably waiting (loop again immediately). */
  protected abstract tick(): Promise<boolean>;

  onApplicationBootstrap(): void {
    if (this.enabled()) this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  nudge(): void {
    this.wake?.();
  }

  /** Runs a single batch synchronously (used by tests and by the poller itself). */
  async runOnce(): Promise<boolean> {
    return this.tick();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let more = false;
      try {
        more = await this.tick();
      } catch (error) {
        this.logger.error(`tick failed: ${(error as Error).message}`, (error as Error).stack);
      }
      if (!more && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }
}
