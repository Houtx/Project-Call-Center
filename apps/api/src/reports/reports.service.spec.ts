import { AttemptStatus } from '@prisma/client';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  it('excludes unknown and collecting from the connection-rate denominator', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{
        attempts: 4n,
        uniqueCustomers: 3n,
        connected: 1n,
        notConnected: 1n,
        unknown: 1n,
        collecting: 1n,
        totalDurationSeconds: 30n,
      }]),
    };
    const service = new ReportsService(prisma as any, { record: jest.fn() } as any, {} as any, { metadata: jest.fn((item) => item), open: jest.fn() } as any);

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
    const service = new ReportsService(prisma as any, { record: jest.fn() } as any, {} as any, { metadata: jest.fn((item) => item), open: jest.fn() } as any);

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

  it('does not require an allowlisted model when compatibility checks are disabled', async () => {
    const prisma = {
      callAttempt: { findMany: jest.fn().mockResolvedValue([]) },
      customer: { count: jest.fn().mockResolvedValue(0) },
      assignment: { count: jest.fn().mockResolvedValue(0) },
      user: { count: jest.fn().mockResolvedValue(0) },
      device: { count: jest.fn().mockResolvedValue(1) },
      mobileAppPolicy: {
        findUnique: jest.fn().mockResolvedValue({
          minimumVersionCode: 1,
          deviceCompatibilityRequired: false,
        }),
      },
    };
    const service = new ReportsService(prisma as any, { record: jest.fn() } as any, {} as any, { metadata: jest.fn((item) => item), open: jest.fn() } as any);

    await service.dashboard();

    expect(prisma.device.count).toHaveBeenLastCalledWith({
      where: expect.not.objectContaining({ allowedDeviceModel: expect.anything() }),
    });
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
    const service = new ReportsService(prisma as any, audit as any, crypto as any, { metadata: jest.fn((item) => item), open: jest.fn() } as any);

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

  it('streams call exports in bounded pages', async () => {
    const initiatedAt = new Date('2026-08-15T01:00:00.000Z');
    const audit = { record: jest.fn() };
    const prisma = {
      callAttempt: {
        findMany: jest.fn().mockResolvedValueOnce([{
          id: 'attempt-1',
          customerId: 'customer-1',
          agentId: 'agent-1',
          status: AttemptStatus.NOT_CONNECTED,
          initiatedAt,
          customer: {
            name: '张三',
            phoneMasked: '138****0001',
            batch: { id: 'batch-1', name: '八月批次' },
          },
          agent: { displayName: '坐席甲' },
          result: {
            durationSeconds: 0,
            systemCallStartedAt: initiatedAt,
            systemCallEndedAt: initiatedAt,
            receivedAt: initiatedAt,
          },
          recording: null,
        }]),
      },
    };
    const service = new ReportsService(
      prisma as any,
      audit as any,
      {} as any,
      { metadata: jest.fn(), open: jest.fn() } as any,
    );

    let content = '';
    for await (const chunk of service.exportCalls({ page: 1, pageSize: 20 }, 'admin-1')) {
      content += chunk.toString();
    }

    expect(content).toContain('"外呼ID","客户","号码"');
    expect(content).toContain('"attempt-1","张三","138****0001"');
    expect(prisma.callAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CALLS_EXPORTED',
      metadata: { maximumRows: 100_000, streamed: true },
    }));
  });
});
