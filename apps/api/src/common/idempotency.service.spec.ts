import { IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  it('commits the business write and completed response through the same transaction client', async () => {
    const tx = {
      idempotencyRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'record-1' }),
        update: jest.fn().mockResolvedValue({ id: 'record-1' }),
      },
      customer: {
        create: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      },
    };
    const prisma = {
      idempotencyRecord: { findFirst: jest.fn() },
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const service = new IdempotencyService(prisma as any);

    const result = await service.execute(
      'admin-1',
      'customers.create',
      'request-key-1',
      { name: '客户' },
      async (client) => {
        const customer = await client.customer.create({ data: { name: '客户' } } as any);
        return { id: customer.id };
      },
    );

    expect(result).toEqual({ id: 'customer-1' });
    expect(tx.customer.create).toHaveBeenCalled();
    expect(tx.idempotencyRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMPLETED',
        responseBody: { id: 'customer-1' },
      }),
    }));
    expect(prisma.idempotencyRecord.findFirst).not.toHaveBeenCalled();
  });

  it('replays a completed response without executing the business operation', async () => {
    const tx = {
      idempotencyRecord: {
        findFirst: jest.fn().mockResolvedValue({
          requestHash: '4edb87c082ecb8568b49e64f52a2c505c0abb1ea832fc3b5bf821c01d6541a94',
          responseBody: { id: 'customer-1' },
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const service = new IdempotencyService(prisma as any);
    const operation = jest.fn();

    await expect(service.execute(
      'admin-1',
      'customers.create',
      'request-key-1',
      { name: '客户' },
      operation,
    )).resolves.toEqual({ id: 'customer-1' });
    expect(operation).not.toHaveBeenCalled();
  });
});
