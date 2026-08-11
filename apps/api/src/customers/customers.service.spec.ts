import { ConflictException } from '@nestjs/common';
import { CustomerStatus } from '@prisma/client';
import { CustomersService } from './customers.service';

describe('CustomersService personal-data erasure', () => {
  const prisma = {
    batch: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
    customer: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      updateMany: jest.fn(),
      groupBy: jest.fn(),
    },
    suppressionEntry: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
  const crypto = {
    normalizePhone: jest.fn(() => '+8613800001001'),
    encryptPhone: jest.fn(() => ({
      phoneCiphertext: new Uint8Array([1]),
      phoneIv: new Uint8Array([2]),
      phoneTag: new Uint8Array([3]),
    })),
    hashPhone: jest.fn(() => 'erased-phone-hash'),
    maskPhone: jest.fn(() => '138****1001'),
  };
  const phoneAttribution = { lookup: jest.fn() };
  const audit = { record: jest.fn() };
  const service = new CustomersService(
    prisma as never,
    crypto as never,
    phoneAttribution as never,
    audit as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((operation) =>
      Array.isArray(operation) ? Promise.all(operation) : operation(prisma));
  });

  it('requires the customer to be archived first', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'customer-1',
      status: CustomerStatus.AVAILABLE,
      erasedAt: null,
    });

    await expect(service.erasePersonalData('customer-1', '客户申请', 'admin-1'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });

  it('replaces personal fields while retaining the customer record', async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: 'customer-1',
      status: CustomerStatus.ARCHIVED,
      erasedAt: null,
    });
    prisma.customer.updateMany.mockResolvedValue({ count: 1 });

    await service.erasePersonalData('customer-1', '客户依法申请删除', 'admin-1');

    expect(prisma.customer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'customer-1', status: CustomerStatus.ARCHIVED, erasedAt: null },
      data: expect.objectContaining({
        name: '已删除客户',
        phoneHash: 'erased-phone-hash',
        phoneMasked: '***',
        province: null,
        city: null,
        carrier: null,
        notes: null,
        tags: [],
        erasedAt: expect.any(Date),
      }),
    }));
    expect(audit.record.mock.calls[0][0]).toEqual(expect.objectContaining({
      action: 'CUSTOMER_PERSONAL_DATA_ERASED',
      metadata: { reason: '客户依法申请删除' },
    }));
  });

  it('aggregates batch counters without loading customer rows', async () => {
    prisma.batch.findMany.mockResolvedValue([{
      id: 'batch-1',
      name: '批次一',
      code: 'B-1',
      description: null,
      createdAt: new Date('2026-08-05T00:00:00.000Z'),
    }]);
    prisma.batch.count.mockResolvedValue(1);
    prisma.customer.groupBy
      .mockResolvedValueOnce([{ batchId: 'batch-1', _count: { _all: 100_000 } }])
      .mockResolvedValueOnce([{ batchId: 'batch-1', _count: { _all: 20_000 } }])
      .mockResolvedValueOnce([{ batchId: 'batch-1', _count: { _all: 7_000 } }]);

    const result = await service.listBatches({ page: 1, pageSize: 20 });

    expect(prisma.batch.findMany).toHaveBeenCalledWith(expect.not.objectContaining({
      include: expect.anything(),
    }));
    expect(result.items[0]).toMatchObject({
      customerCount: 100_000,
      assignedCount: 20_000,
      completedCount: 7_000,
    });
  });

  it('fills missing attribution when a customer is created manually', async () => {
    prisma.suppressionEntry.findFirst.mockResolvedValue(null);
    phoneAttribution.lookup.mockReturnValue({
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
    });
    prisma.customer.create.mockResolvedValue({
      id: 'customer-1',
      name: '手工客户',
      phoneMasked: '138****1001',
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
      notes: null,
      tags: [],
      status: CustomerStatus.AVAILABLE,
      version: 1,
      lastContactAt: null,
      erasedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      batch: null,
      assignments: [],
      _count: { callAttempts: 0 },
    });

    await service.create({
      name: '手工客户',
      phone: '13800001001',
      province: ' ',
      carrier: '自定义运营商',
    }, 'admin-1');

    expect(prisma.customer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        province: '江苏',
        city: '徐州',
        carrier: '自定义运营商',
      }),
    }));
  });

  it('filters and labels customers whose latest assigned call was not connected', async () => {
    prisma.$queryRaw.mockResolvedValue([{ total: 1, ids: ['customer-1'] }]);
    prisma.customer.findMany.mockResolvedValue([{
      id: 'customer-1',
      name: '待重试客户',
      phoneMasked: '138****1001',
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
      notes: null,
      tags: [],
      status: CustomerStatus.COMPLETED,
      version: 1,
      lastContactAt: new Date('2026-08-09T01:00:00.000Z'),
      erasedAt: null,
      createdAt: new Date('2026-08-09T00:00:00.000Z'),
      updatedAt: new Date('2026-08-09T01:00:00.000Z'),
      batch: null,
      assignments: [{
        id: 'assignment-1',
        status: 'COMPLETED',
        assignedAt: new Date('2026-08-09T00:00:00.000Z'),
        agent: { id: 'agent-1', displayName: '坐席一', username: 'agent001' },
        callAttempts: [{ status: 'NOT_CONNECTED' }],
      }],
      _count: { callAttempts: 2 },
    }]);
    prisma.customer.count.mockResolvedValue(1);

    const result = await service.list({
      page: 1,
      pageSize: 15,
      status: 'ACTIVE',
      assignmentStatus: 'NOT_CONNECTED',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['customer-1'] } },
    }));
    expect(result.items[0]).toMatchObject({
      id: 'customer-1',
      assignmentStatus: 'NOT_CONNECTED',
      lastCallStatus: 'NOT_CONNECTED',
      attemptCount: 2,
    });
  });
});
