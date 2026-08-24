import { AssignmentStatus, AttemptStatus, CallResultSource, CustomerStatus } from '@prisma/client';
import { MobileService } from './mobile.service';

describe('MobileService call completion', () => {
  it('snapshots the agent recording switch when creating a new attempt', async () => {
    const customer = {
      id: 'customer-1',
      phoneCiphertext: new Uint8Array([1]),
      phoneIv: new Uint8Array([2]),
      phoneTag: new Uint8Array([3]),
      phoneHash: 'hash-1',
      phoneMasked: '138****0001',
      status: CustomerStatus.ASSIGNED,
    };
    const created = {
      id: 'attempt-1',
      assignmentId: 'assignment-1',
      customerId: 'customer-1',
      agentId: 'agent-1',
      deviceId: 'device-1',
      attemptNumber: 1,
      recordingRequested: true,
      dialTokenExpiresAt: new Date(Date.now() + 60_000),
      collectingDeadlineAt: new Date(Date.now() + 86_400_000),
      customer,
    };
    const tx = {
      assignment: {
        findFirst: jest.fn().mockResolvedValue({ id: 'assignment-1', customerId: 'customer-1', agentId: 'agent-1', status: AssignmentStatus.ACTIVE, customer }),
      },
      suppressionEntry: { count: jest.fn().mockResolvedValue(0) },
      mobileAppPolicy: { upsert: jest.fn().mockResolvedValue({ maxCallAttempts: 2 }) },
      user: { findUnique: jest.fn().mockResolvedValue({ recordingEnabled: true }) },
      callAttempt: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma = {
      callAttempt: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const recordings = { createPending: jest.fn().mockResolvedValue({ id: 'recording-1' }) };
    const service = new MobileService(prisma as any, { decryptPhone: jest.fn().mockReturnValue('+8613800000001') } as any, { record: jest.fn() } as any, recordings as any);
    jest.spyOn(service as any, 'requireDevice').mockResolvedValue({ id: 'device-1' });

    await expect(service.createCallAttempt({
      assignmentId: 'assignment-1',
      clientAttemptId: 'client-attempt-1',
      callLogBaselineId: '0',
      callLogBaselineAt: new Date().toISOString(),
    }, { sub: 'agent-1', role: 'AGENT', deviceId: 'device-1', tokenVersion: 1 } as any)).resolves.toMatchObject({ recordingRequested: true });
    expect(tx.callAttempt.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ recordingRequested: true }) }));
    expect(recordings.createPending).toHaveBeenCalledWith('attempt-1', 'agent-1', 'device-1', tx);
  });

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

  it('settles an unobservable system-managed call and releases the assignment', async () => {
    const attempt = {
      id: 'attempt-1',
      assignmentId: 'assignment-1',
      customerId: 'customer-1',
      agentId: 'agent-1',
      deviceId: 'device-1',
      attemptNumber: 1,
      status: AttemptStatus.COLLECTING,
      result: null,
    };
    const tx = {
      callAttempt: {
        findFirst: jest.fn().mockResolvedValue(attempt),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      callResult: { upsert: jest.fn() },
      assignment: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'assignment-1',
          agentId: 'agent-1',
          customerId: 'customer-1',
        }),
      },
      mobileAppPolicy: { upsert: jest.fn().mockResolvedValue({ maxCallAttempts: 2 }) },
      syncChange: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new MobileService(prisma as any, {} as any, audit as any, { createPending: jest.fn() } as any);
    jest.spyOn(service as any, 'requireDevice').mockResolvedValue({ id: 'device-1' });

    await expect(service.settleUnobservedCallAttempt('attempt-1', {
      sub: 'agent-1',
      role: 'AGENT',
      deviceId: 'device-1',
      tokenVersion: 1,
    } as any)).resolves.toEqual({ settled: true, status: AttemptStatus.UNKNOWN });
    expect(tx.callResult.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ source: CallResultSource.TIMEOUT, durationSeconds: null }),
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ operation: 'UPSERT', targetUserId: 'agent-1' }),
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'MOBILE_CALL_ATTEMPT_UNOBSERVED',
      entityId: 'attempt-1',
    }));
  });
});
