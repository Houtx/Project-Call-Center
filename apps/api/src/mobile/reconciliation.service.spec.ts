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
});
