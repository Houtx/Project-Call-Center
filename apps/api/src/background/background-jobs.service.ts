import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallReconciliationService, HousekeepingResult } from '../mobile/reconciliation.service';

const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;
const DEFAULT_HOUSEKEEPING_INTERVAL_MS = 60 * 60_000;

@Injectable()
export class BackgroundJobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundJobsService.name);
  private readonly enabled: boolean;
  private readonly reconciliationIntervalMs: number;
  private readonly housekeepingIntervalMs: number;
  private readonly shutdownController = new AbortController();
  private loopPromise?: Promise<void>;
  private running = false;
  private lastCycleStartedAt?: Date;
  private lastCycleCompletedAt?: Date;
  private lastHousekeepingAt?: Date;
  private lastHousekeepingResult?: HousekeepingResult;
  private lastErrorAt?: Date;
  private lastError?: 'BACKGROUND_JOB_FAILED';

  constructor(
    private readonly config: ConfigService,
    private readonly reconciliation: CallReconciliationService,
  ) {
    this.enabled = this.config.get<string>('BACKGROUND_JOBS_ENABLED') === 'true';
    this.reconciliationIntervalMs = this.readInterval(
      'BACKGROUND_RECONCILIATION_INTERVAL_MS',
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      5_000,
    );
    this.housekeepingIntervalMs = this.readInterval(
      'BACKGROUND_HOUSEKEEPING_INTERVAL_MS',
      DEFAULT_HOUSEKEEPING_INTERVAL_MS,
      60_000,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.enabled || this.loopPromise) return;
    this.loopPromise = this.runLoop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shutdownController.abort();
    await this.loopPromise;
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      reconciliationIntervalSeconds: Math.round(this.reconciliationIntervalMs / 1000),
      housekeepingIntervalSeconds: Math.round(this.housekeepingIntervalMs / 1000),
      lastCycleStartedAt: this.lastCycleStartedAt?.toISOString() ?? null,
      lastCycleCompletedAt: this.lastCycleCompletedAt?.toISOString() ?? null,
      lastHousekeepingAt: this.lastHousekeepingAt?.toISOString() ?? null,
      lastHousekeepingResult: this.lastHousekeepingResult ?? null,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      lastError: this.lastError ?? null,
    };
  }

  private async runLoop(): Promise<void> {
    this.running = true;
    let nextHousekeepingAt = 0;
    this.logger.log('Background reconciliation enabled');
    try {
      while (!this.shutdownController.signal.aborted) {
        this.lastCycleStartedAt = new Date();
        try {
          let count: number;
          do {
            count = await this.reconciliation.reconcileExpired();
          } while (count === 500 && !this.shutdownController.signal.aborted);

          if (Date.now() >= nextHousekeepingAt && !this.shutdownController.signal.aborted) {
            this.lastHousekeepingResult = await this.reconciliation.housekeeping();
            this.lastHousekeepingAt = new Date();
            nextHousekeepingAt = Date.now() + this.housekeepingIntervalMs;
          }
          this.lastCycleCompletedAt = new Date();
          this.lastError = undefined;
        } catch (error) {
          this.lastErrorAt = new Date();
          this.lastError = 'BACKGROUND_JOB_FAILED';
          this.logger.error(error instanceof Error ? error.stack : String(error));
        }
        await this.wait(this.reconciliationIntervalMs);
      }
    } finally {
      this.running = false;
    }
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.shutdownController.signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timeout);
        this.shutdownController.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timeout = setTimeout(finish, milliseconds);
      this.shutdownController.signal.addEventListener('abort', finish, { once: true });
    });
  }

  private readInterval(name: string, fallback: number, minimum: number): number {
    const parsed = Number(this.config.get<string>(name));
    return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
  }
}
