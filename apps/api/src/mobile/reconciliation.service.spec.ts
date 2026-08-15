import { AttemptStatus, CallResultSource } from '@prisma/client';
import { CallReconciliationService } from './reconciliation.service';

describe('CallReconciliationService', () => {
  it('marks a 24-hour final attempt unknown and closes the assignment', async () => {
    const attempt = {
      id: 'attempt-2',
      assignmentId: 'assignment-1',
      customerId: 'customer-1',
      agentId: 'agent-1',
      deviceId: 'device-1',
      attemptNumber: 2,
    };
    const tx = {
      callAttempt: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      callResult: { upsert: jest.fn() },
      assignment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'assignment-1', customerId: 'customer-1', agentId: 'agent-1' }),
        update: jest.fn(),
      },
      customer: { update: jest.fn() },
      syncChange: { create: jest.fn() },
    };
    const prisma = {
      callAttempt: { findMany: jest.fn().mockResolvedValue([attempt]) },
      mobileAppPolicy: { upsert: jest.fn().mockResolvedValue({ maxCallAttempts: 2 }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new CallReconciliationService(prisma as any, audit as any, { cleanupExpired: jest.fn() } as any);

    await expect(service.reconcileExpired()).resolves.toBe(1);
    expect(tx.callAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AttemptStatus.UNKNOWN }),
    }));
    expect(tx.callResult.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ source: CallResultSource.TIMEOUT, deviceId: 'device-1' }),
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operation: 'REMOVE', targetUserId: 'agent-1' }),
    });
  });

  it('removes only retained technical data and acknowledged sync changes', async () => {
    const prisma = {
      idempotencyRecord: {
        findMany: jest.fn().mockResolvedValue([{ id: 'idem-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      refreshToken: {
        findMany: jest.fn().mockResolvedValue([{ id: 'token-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      importJob: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      importRow: {
        findMany: jest.fn().mockResolvedValue([{ id: 'row-1' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      device: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 'agent-1', lastSyncCursor: 10n },
          { userId: 'agent-1', lastSyncCursor: 8n },
        ]),
      },
      syncChange: {
        findMany: jest.fn().mockResolvedValue([{ cursor: 7n }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const recordings = { cleanupExpired: jest.fn().mockResolvedValue(2) };
    const service = new CallReconciliationService(prisma as any, {} as any, recordings as any);

    await expect(service.housekeeping()).resolves.toEqual({
      idempotencyRecords: 1,
      refreshTokens: 1,
      cancelledImports: 1,
      importRows: 1,
      syncChanges: 1,
      recordings: 2,
    });
    expect(prisma.syncChange.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        targetUserId: 'agent-1',
        cursor: { lte: 8n },
      }),
    }));
    expect(prisma.syncChange.deleteMany).toHaveBeenCalledWith({
      where: { cursor: { in: [7n] } },
    });
  });
});
