import { AssignmentStatus, AttemptStatus, CustomerStatus } from '@prisma/client';
import { MobileService } from './mobile.service';

describe('MobileService call completion', () => {
  it('completes the assignment after the configured second zero-duration call', async () => {
    const attempt = {
      id: 'attempt-2',
      assignmentId: 'assignment-1',
      customerId: 'customer-1',
      attemptNumber: 2,
      callLogBaselineAt: new Date('2026-08-05T01:00:00.000Z'),
      result: null,
    };
    const tx = {
      callAttempt: {
        findFirst: jest.fn().mockResolvedValue(attempt),
        update: jest.fn(),
      },
      mobileAppPolicy: {
        upsert: jest.fn().mockResolvedValue({ maxCallAttempts: 2 }),
      },
      callResult: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      customer: { update: jest.fn() },
      assignment: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([{
          id: 'assignment-1',
          agentId: 'agent-1',
        }]),
        update: jest.fn(),
      },
      syncChange: { create: jest.fn() },
    };
    const prisma = {
      callResult: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const service = new MobileService(
      prisma as any,
      {} as any,
      { record: jest.fn() } as any,
      { createPending: jest.fn() } as any,
    );

    const result = await (service as any).recordObservation({
      eventId: 'event-2',
      attemptId: 'attempt-2',
      systemCallLogId: 'log-2',
      systemCallStartedAt: '2026-08-05T01:00:10.000Z',
      systemCallEndedAt: '2026-08-05T01:00:10.000Z',
      durationSeconds: 0,
      clientObservedAt: '2026-08-05T01:00:15.000Z',
    }, 'agent-1', 'device-1');

    expect(result).toBe('ACCEPTED');
    expect(tx.callAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AttemptStatus.NOT_CONNECTED }),
    }));
    expect(tx.assignment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: AssignmentStatus.COMPLETED,
        endReason: 'ATTEMPT_LIMIT',
      }),
    }));
    expect(tx.customer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: CustomerStatus.COMPLETED },
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operation: 'REMOVE', targetUserId: 'agent-1' }),
    });
  });

  it('allows an active device to reveal only its own call history number', async () => {
    const audit = { record: jest.fn() };
    const crypto = { decryptPhone: jest.fn().mockReturnValue('+8613800000004') };
    const prisma = {
      callAttempt: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          customer: { phoneMasked: '138****0004', erasedAt: null },
        }),
      },
    };
    const service = new MobileService(prisma as any, crypto as any, audit as any, { createPending: jest.fn() } as any);
    jest.spyOn(service as any, 'requireDevice').mockResolvedValue({ id: 'device-1' });

    await expect(service.revealHistoryPhone('attempt-1', {
      sub: 'agent-1',
      role: 'AGENT',
      deviceId: 'device-1',
      tokenVersion: 1,
    } as any)).resolves.toMatchObject({ phone: '+8613800000004' });
    expect(prisma.callAttempt.findFirst).toHaveBeenCalledWith({
      where: { id: 'attempt-1', agentId: 'agent-1' },
      include: { customer: true },
    });
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'agent-1',
      action: 'MOBILE_CALL_HISTORY_PHONE_REVEALED',
      entityType: 'call_attempt',
      entityId: 'attempt-1',
      metadata: { deviceId: 'device-1', phone: '138****0004' },
    });
  });

  it('deletes a collecting attempt when the system dialer fails to launch', async () => {
    const attempt = {
      id: 'attempt-1',
      assignmentId: 'assignment-1',
      agentId: 'agent-1',
      deviceId: 'device-1',
      status: AttemptStatus.COLLECTING,
      result: null,
    };
    const tx = {
      callAttempt: {
        findFirst: jest.fn().mockResolvedValue(attempt),
        delete: jest.fn().mockResolvedValue(attempt),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new MobileService(prisma as any, {} as any, audit as any, { createPending: jest.fn() } as any);
    jest.spyOn(service as any, 'requireDevice').mockResolvedValue({ id: 'device-1' });

    await expect(service.cancelCallAttempt('attempt-1', {
      sub: 'agent-1',
      role: 'AGENT',
      deviceId: 'device-1',
      tokenVersion: 1,
    } as any)).resolves.toEqual({ cancelled: true });
    expect(tx.callAttempt.delete).toHaveBeenCalledWith({ where: { id: 'attempt-1' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MOBILE_CALL_ATTEMPT_CANCELLED',
        entityId: 'attempt-1',
      }),
      tx,
    );
  });

  it('treats an already cancelled call attempt as successfully cancelled', async () => {
    const tx = {
      callAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
        delete: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const service = new MobileService(prisma as any, {} as any, { record: jest.fn() } as any, { createPending: jest.fn() } as any);
    jest.spyOn(service as any, 'requireDevice').mockResolvedValue({ id: 'device-1' });

    await expect(service.cancelCallAttempt('attempt-1', {
      sub: 'agent-1',
      role: 'AGENT',
      deviceId: 'device-1',
      tokenVersion: 1,
    } as any)).resolves.toEqual({ cancelled: true });
    expect(tx.callAttempt.delete).not.toHaveBeenCalled();
  });
});
