import { AttemptStatus } from '@prisma/client';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  it('excludes unknown and collecting from the connection-rate denominator', async () => {
    const prisma = {
      callAttempt: {
        findMany: jest.fn().mockResolvedValue([
          { customerId: 'a', status: AttemptStatus.CONNECTED, result: { durationSeconds: 30 } },
          { customerId: 'a', status: AttemptStatus.NOT_CONNECTED, result: { durationSeconds: 0 } },
          { customerId: 'b', status: AttemptStatus.UNKNOWN, result: null },
          { customerId: 'c', status: AttemptStatus.COLLECTING, result: null },
        ]),
      },
    };
    const service = new ReportsService(prisma as any, { record: jest.fn() } as any, {} as any);

    await expect(service.summary({ page: 1, pageSize: 20 } as any)).resolves.toMatchObject({
      attempts: 4,
      uniqueCustomers: 3,
      connected: 1,
      notConnected: 1,
      unknown: 1,
      collecting: 1,
      dataCompletenessRate: 0.5,
      connectionRate: 0.5,
      totalDurationSeconds: 30,
      averageDurationSeconds: 30,
    });
  });

  it('returns per-agent dashboard totals for agents who called today', async () => {
    const attempts = [
      { agentId: 'agent-1', customerId: 'customer-1', status: AttemptStatus.CONNECTED, result: { durationSeconds: 30 }, agent: { id: 'agent-1', displayName: '坐席甲', username: 'agent01' } },
      { agentId: 'agent-1', customerId: 'customer-1', status: AttemptStatus.CONNECTED, result: { durationSeconds: 90 }, agent: { id: 'agent-1', displayName: '坐席甲', username: 'agent01' } },
      { agentId: 'agent-1', customerId: 'customer-2', status: AttemptStatus.NOT_CONNECTED, result: { durationSeconds: 0 }, agent: { id: 'agent-1', displayName: '坐席甲', username: 'agent01' } },
      { agentId: 'agent-1', customerId: 'customer-3', status: AttemptStatus.COLLECTING, result: null, agent: { id: 'agent-1', displayName: '坐席甲', username: 'agent01' } },
      { agentId: 'agent-1', customerId: 'customer-4', status: AttemptStatus.UNKNOWN, result: null, agent: { id: 'agent-1', displayName: '坐席甲', username: 'agent01' } },
      { agentId: 'agent-2', customerId: 'customer-5', status: AttemptStatus.CONNECTED, result: { durationSeconds: 10 }, agent: { id: 'agent-2', displayName: '坐席乙', username: 'agent02' } },
      { agentId: 'agent-2', customerId: 'customer-6', status: AttemptStatus.NOT_CONNECTED, result: { durationSeconds: 0 }, agent: { id: 'agent-2', displayName: '坐席乙', username: 'agent02' } },
    ];
    const prisma = {
      callAttempt: { findMany: jest.fn().mockResolvedValue(attempts) },
      customer: { count: jest.fn().mockResolvedValue(100) },
      assignment: { count: jest.fn().mockResolvedValue(8) },
      user: { count: jest.fn().mockResolvedValue(2) },
      device: { count: jest.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(2) },
      mobileAppPolicy: { findUnique: jest.fn().mockResolvedValue({ minimumVersionCode: 1 }) },
    };
    const service = new ReportsService(prisma as any, { record: jest.fn() } as any, {} as any);

    const result = await service.dashboard();

    expect(result).toMatchObject({
      attempts: 7,
      connected: 3,
      notConnected: 2,
      collecting: 1,
      unknown: 1,
      activeCustomers: 100,
      assignedPending: 8,
      activeAgents: 2,
      deviceCount: 3,
      healthyDevices: 2,
    });
    expect(result.agentStats).toEqual([
      expect.objectContaining({
        agentId: 'agent-1',
        agentName: '坐席甲',
        username: 'agent01',
        attempts: 5,
        uniqueCustomers: 4,
        connected: 2,
        notConnected: 1,
        collecting: 1,
        unknown: 1,
        connectionRate: 2 / 3,
        totalDurationSeconds: 120,
        averageDurationSeconds: 60,
        maxDurationSeconds: 90,
      }),
      expect.objectContaining({
        agentId: 'agent-2',
        attempts: 2,
        uniqueCustomers: 2,
        connected: 1,
        notConnected: 1,
        connectionRate: 0.5,
        totalDurationSeconds: 10,
        averageDurationSeconds: 10,
        maxDurationSeconds: 10,
      }),
    ]);
  });

  it('reveals a call number only on demand and records the masked value in audit', async () => {
    const audit = { record: jest.fn() };
    const crypto = { decryptPhone: jest.fn().mockReturnValue('+8613800000005') };
    const prisma = {
      callAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          customer: { phoneMasked: '138****0005', erasedAt: null },
        }),
      },
    };
    const service = new ReportsService(prisma as any, audit as any, crypto as any);

    await expect(service.revealCallPhone('attempt-1', 'admin-1')).resolves.toMatchObject({
      phone: '+8613800000005',
    });
    expect(audit.record).toHaveBeenCalledWith({
      actorId: 'admin-1',
      action: 'CALL_PHONE_REVEALED',
      entityType: 'call_attempt',
      entityId: 'attempt-1',
      metadata: { phone: '138****0005' },
    });
    expect(crypto.decryptPhone).toHaveBeenCalledWith(
      expect.objectContaining({ phoneMasked: '138****0005' }),
    );
  });
});
