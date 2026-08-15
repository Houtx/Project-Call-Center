import { BackgroundJobsService } from './background-jobs.service';

describe('BackgroundJobsService', () => {
  it('runs reconciliation and housekeeping and exposes freshness state', async () => {
    const config = {
      get: jest.fn((name: string) => ({
        BACKGROUND_JOBS_ENABLED: 'true',
        BACKGROUND_RECONCILIATION_INTERVAL_MS: '5000',
        BACKGROUND_HOUSEKEEPING_INTERVAL_MS: '60000',
      })[name]),
    };
    const housekeepingResult = {
      idempotencyRecords: 1,
      refreshTokens: 2,
      cancelledImports: 0,
      importRows: 3,
      syncChanges: 4,
      recordings: 0,
    };
    const reconciliation = {
      reconcileExpired: jest.fn().mockResolvedValue(0),
      housekeeping: jest.fn().mockResolvedValue(housekeepingResult),
    };
    const service = new BackgroundJobsService(config as any, reconciliation as any);

    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(reconciliation.reconcileExpired).toHaveBeenCalledTimes(1);
    expect(reconciliation.housekeeping).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({
      enabled: true,
      running: true,
      reconciliationIntervalSeconds: 5,
      housekeepingIntervalSeconds: 60,
      lastHousekeepingResult: housekeepingResult,
      lastError: null,
    });

    await service.onApplicationShutdown();
    expect(service.status().running).toBe(false);
  });

  it('stays idle when background jobs are disabled', async () => {
    const reconciliation = {
      reconcileExpired: jest.fn(),
      housekeeping: jest.fn(),
    };
    const service = new BackgroundJobsService(
      { get: jest.fn().mockReturnValue(undefined) } as any,
      reconciliation as any,
    );

    service.onApplicationBootstrap();
    await service.onApplicationShutdown();

    expect(reconciliation.reconcileExpired).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ enabled: false, running: false });
  });
});
