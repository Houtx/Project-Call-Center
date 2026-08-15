import { ConflictException } from '@nestjs/common';
import { AssignmentStatus, AttemptStatus, CustomerStatus, Prisma } from '@prisma/client';
import { AssignmentsService } from './assignments.service';

describe('AssignmentsService', () => {
  it('maps a serializable allocation race to a refreshable conflict', async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError('serialization conflict', {
      code: 'P2034',
      clientVersion: '6.13.0',
    });
    const prisma = { $transaction: jest.fn().mockRejectedValue(conflict) };
    const service = new AssignmentsService(prisma as any, { record: jest.fn() } as any, {} as any);

    await expect(service.assign(['customer-1'], 'agent-1', 'admin-1'))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(service.assign(['customer-1'], 'agent-1', 'admin-1'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ASSIGNMENT_CONFLICT' }),
      });
  });

  it('previews only available or assigned customers and skips active suppression entries', async () => {
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          username: 'agent',
          displayName: '坐席一',
        }),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'available', phoneHash: 'hash-available', status: 'AVAILABLE' },
          { id: 'assigned', phoneHash: 'hash-assigned', status: 'ASSIGNED' },
          { id: 'completed', phoneHash: 'hash-completed', status: 'COMPLETED' },
        ]),
      },
      suppressionEntry: {
        findMany: jest.fn().mockResolvedValue([{ phoneHash: 'hash-assigned' }]),
      },
    };
    const crypto = {
      normalizePhone: jest.fn((value: string) => value),
      hashPhone: jest.fn((value: string) => `hash:${value}`),
    };
    const service = new AssignmentsService(
      prisma as any,
      { record: jest.fn() } as any,
      crypto as any,
    );

    await expect(service.previewBulk({
      scope: 'FILTER',
      agentIds: ['agent-1'],
      quantity: 1,
      search: '客户',
      status: 'ACTIVE',
    })).resolves.toMatchObject({
      matchedCount: 3,
      assignableCount: 1,
      skippedCount: 2,
      requestedCount: 1,
      allocations: [{ agent: { displayName: '坐席一' }, quantity: 1 }],
    });
    expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { status: { notIn: ['ARCHIVED', 'SUPPRESSED'] } },
        ]),
      }),
    }));
  });

  it('executes bulk assignment in chunks larger than the single-request limit', async () => {
    const customers = Array.from({ length: 1001 }, (_, index) => ({
      id: `customer-${index}`,
      phoneHash: `hash-${index}`,
      status: 'AVAILABLE',
    }));
    const audit = { record: jest.fn() };
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          username: 'agent',
          displayName: '坐席一',
        }),
      },
      customer: { findMany: jest.fn().mockResolvedValue(customers) },
      suppressionEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AssignmentsService(
      prisma as any,
      audit as any,
      { normalizePhone: jest.fn(), hashPhone: jest.fn() } as any,
    );
    const assignOrReassign = jest.spyOn(service, 'assignOrReassign').mockResolvedValue(1);

    await expect(service.bulkAssign({
      scope: 'ALL',
      agentIds: ['agent-1'],
      quantity: 1001,
    }, 'admin-1')).resolves.toMatchObject({
      assignableCount: 1001,
      requestedCount: 1001,
      assigned: 2,
    });
    expect(assignOrReassign).toHaveBeenCalledTimes(2);
    expect(assignOrReassign.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 1]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMERS_BULK_ASSIGNED',
        metadata: expect.objectContaining({ assignableCount: 1001 }),
      }),
      prisma,
    );
  });

  it('splits one stable customer range evenly across multiple target agents', async () => {
    const customers = Array.from({ length: 5 }, (_, index) => ({
      id: `customer-${index}`,
      phoneHash: `hash-${index}`,
      status: 'AVAILABLE',
    }));
    const prisma = {
      user: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve({
          id: where.id,
          username: where.id,
          displayName: where.id === 'agent-1' ? '坐席一' : '坐席二',
        })),
      },
      customer: { findMany: jest.fn().mockResolvedValue(customers) },
      suppressionEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AssignmentsService(
      prisma as any,
      { record: jest.fn() } as any,
      { normalizePhone: jest.fn(), hashPhone: jest.fn() } as any,
    );
    const assignOrReassign = jest.spyOn(service, 'assignOrReassign')
      .mockImplementation(async (ids) => ids.length);

    await expect(service.bulkAssign({
      scope: 'ALL',
      agentIds: ['agent-1', 'agent-2'],
      quantity: 5,
    }, 'admin-1')).resolves.toMatchObject({
      requestedCount: 5,
      assigned: 5,
      allocations: [
        { agent: { id: 'agent-1' }, quantity: 3, assigned: 3 },
        { agent: { id: 'agent-2' }, quantity: 2, assigned: 2 },
      ],
    });
    expect(assignOrReassign.mock.calls.map(([ids, agentId]) => ({ ids, agentId }))).toEqual([
      { ids: ['customer-0', 'customer-1', 'customer-2'], agentId: 'agent-1' },
      { ids: ['customer-3', 'customer-4'], agentId: 'agent-2' },
    ]);
  });

  it('rejects a multi-agent plan larger than the current assignable range', async () => {
    const prisma = {
      user: {
        findFirst: jest.fn(({ where }: { where: { id: string } }) => Promise.resolve({
          id: where.id,
          username: where.id,
          displayName: where.id,
        })),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'customer-1', phoneHash: 'hash-1', status: 'AVAILABLE' },
        ]),
      },
      suppressionEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AssignmentsService(
      prisma as any,
      { record: jest.fn() } as any,
      { normalizePhone: jest.fn(), hashPhone: jest.fn() } as any,
    );

    await expect(service.bulkAssign({
      scope: 'ALL',
      agentIds: ['agent-1', 'agent-2'],
      quantity: 2,
    }, 'admin-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ASSIGNMENT_QUANTITY_EXCEEDS_AVAILABLE' }),
    });
  });

  it('requires at least one customer for every selected agent', async () => {
    const service = new AssignmentsService({} as any, { record: jest.fn() } as any, {} as any);

    await expect(service.previewBulk({
      scope: 'ALL',
      agentIds: ['agent-1', 'agent-2'],
      quantity: 1,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ASSIGNMENT_QUANTITY_LESS_THAN_AGENT_COUNT' }),
    });
  });

  it('enforces the configured low-resource bulk quantity limit', async () => {
    const previous = process.env.BULK_ASSIGNMENT_MAX_QUANTITY;
    process.env.BULK_ASSIGNMENT_MAX_QUANTITY = '2';
    const service = new AssignmentsService({} as any, { record: jest.fn() } as any, {} as any);
    try {
      await expect(service.previewBulk({
        scope: 'ALL',
        agentIds: ['agent-1'],
        quantity: 3,
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ASSIGNMENT_QUANTITY_LIMIT' }),
      });
    } finally {
      if (previous === undefined) delete process.env.BULK_ASSIGNMENT_MAX_QUANTITY;
      else process.env.BULK_ASSIGNMENT_MAX_QUANTITY = previous;
    }
  });

  it('requires narrower filters when the candidate scan limit is exceeded', async () => {
    const previous = process.env.BULK_ASSIGNMENT_SCAN_MAX_ROWS;
    process.env.BULK_ASSIGNMENT_SCAN_MAX_ROWS = '2';
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({ id: 'agent-1', username: 'agent', displayName: '坐席一' }),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'customer-1', phoneHash: 'hash-1', status: 'AVAILABLE' },
          { id: 'customer-2', phoneHash: 'hash-2', status: 'AVAILABLE' },
          { id: 'customer-3', phoneHash: 'hash-3', status: 'AVAILABLE' },
        ]),
      },
    };
    const service = new AssignmentsService(prisma as any, { record: jest.fn() } as any, {} as any);
    try {
      await expect(service.previewBulk({
        scope: 'ALL',
        agentIds: ['agent-1'],
        quantity: 1,
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ASSIGNMENT_SCOPE_TOO_LARGE' }),
      });
      expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    } finally {
      if (previous === undefined) delete process.env.BULK_ASSIGNMENT_SCAN_MAX_ROWS;
      else process.env.BULK_ASSIGNMENT_SCAN_MAX_ROWS = previous;
    }
  });

  it('includes completed customers in a latest-not-connected bulk preview', async () => {
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'agent-1',
          username: 'agent001',
          displayName: '坐席一',
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{
        id: 'customer-1',
        phoneHash: 'hash-1',
        status: CustomerStatus.COMPLETED,
      }]),
      suppressionEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AssignmentsService(
      prisma as any,
      { record: jest.fn() } as any,
      { normalizePhone: jest.fn(), hashPhone: jest.fn() } as any,
    );

    await expect(service.previewBulk({
      scope: 'FILTER',
      agentIds: ['agent-1'],
      quantity: 1,
      status: 'ACTIVE',
      assignmentStatus: 'NOT_CONNECTED',
    })).resolves.toMatchObject({
      matchedCount: 1,
      assignableCount: 1,
      requestedCount: 1,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh assignment for a completed customer whose latest call was not connected', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-2' }) },
      customer: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-1',
          phoneHash: 'hash-1',
          status: CustomerStatus.COMPLETED,
          assignments: [{
            id: 'assignment-1',
            agentId: 'agent-1',
            status: AssignmentStatus.COMPLETED,
            callAttempts: [{ status: AttemptStatus.NOT_CONNECTED }],
          }],
        }]),
        update: jest.fn(),
      },
      suppressionEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      assignment: {
        create: jest.fn().mockResolvedValue({ id: 'assignment-2' }),
        update: jest.fn(),
      },
      syncChange: { create: jest.fn() },
    };
    const audit = { record: jest.fn() };
    const prisma = {
      $transaction: jest.fn((operation) => operation(tx)),
    };
    const service = new AssignmentsService(prisma as any, audit as any, {} as any);

    await expect(service.retryAssign(['customer-1'], 'agent-2', 'admin-1')).resolves.toBe(1);

    expect(tx.assignment.create).toHaveBeenCalledWith({
      data: { customerId: 'customer-1', agentId: 'agent-2', assignedById: 'admin-1' },
    });
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'customer-1' },
      data: { status: CustomerStatus.ASSIGNED },
    });
    expect(tx.assignment.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CUSTOMERS_RETRY_ASSIGNED' }),
      prisma,
    );
  });

  it('ends an active unsuccessful assignment before retrying it with another agent', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-2' }) },
      customer: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-1',
          phoneHash: 'hash-1',
          status: CustomerStatus.ASSIGNED,
          assignments: [{
            id: 'assignment-1',
            agentId: 'agent-1',
            status: AssignmentStatus.ACTIVE,
            callAttempts: [{ status: AttemptStatus.NOT_CONNECTED }],
          }],
        }]),
        update: jest.fn(),
      },
      suppressionEntry: { findFirst: jest.fn().mockResolvedValue(null) },
      assignment: {
        create: jest.fn().mockResolvedValue({ id: 'assignment-2' }),
        update: jest.fn(),
      },
      syncChange: { create: jest.fn() },
    };
    const service = new AssignmentsService(
      { $transaction: jest.fn((operation) => operation(tx)) } as any,
      { record: jest.fn() } as any,
      {} as any,
    );

    await service.retryAssign(['customer-1'], 'agent-2', 'admin-1');

    expect(tx.assignment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'assignment-1' },
      data: expect.objectContaining({ status: AssignmentStatus.REASSIGNED }),
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        targetUserId: 'agent-1',
        operation: 'REMOVE',
      }),
    }));
  });

  it('rejects retry assignment when the latest call is connected', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-2' }) },
      customer: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-1',
          phoneHash: 'hash-1',
          status: CustomerStatus.COMPLETED,
          assignments: [{
            id: 'assignment-1',
            agentId: 'agent-1',
            status: AssignmentStatus.COMPLETED,
            callAttempts: [{ status: AttemptStatus.CONNECTED }],
          }],
        }]),
      },
      suppressionEntry: { findFirst: jest.fn() },
      assignment: { create: jest.fn() },
      syncChange: { create: jest.fn() },
    };
    const service = new AssignmentsService(
      { $transaction: jest.fn((operation) => operation(tx)) } as any,
      { record: jest.fn() } as any,
      {} as any,
    );

    await expect(service.retryAssign(['customer-1'], 'agent-2', 'admin-1'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'LATEST_CALL_NOT_UNCONNECTED' }),
      });
    expect(tx.assignment.create).not.toHaveBeenCalled();
  });

  it('rejects archived or suppressed customers before retry assignment', async () => {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'agent-2' }) },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AssignmentsService(
      { $transaction: jest.fn((operation) => operation(tx)) } as any,
      { record: jest.fn() } as any,
      {} as any,
    );

    await expect(service.retryAssign(['customer-1'], 'agent-2', 'admin-1'))
      .rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CUSTOMER_NOT_RETRY_ASSIGNABLE' }),
      });
  });
});
