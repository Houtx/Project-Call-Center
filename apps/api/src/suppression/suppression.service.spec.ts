import { AssignmentStatus, CustomerStatus } from '@prisma/client';
import { SuppressionService } from './suppression.service';

describe('SuppressionService', () => {
  it('withdraws active assignments and emits a mobile tombstone', async () => {
    const tx = {
      suppressionEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'suppression-1',
          phoneMasked: '138****8000',
          reason: '客户拒绝',
          source: 'MANUAL',
          createdAt: new Date(),
          createdBy: { displayName: '管理员' },
        }),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-1',
          status: CustomerStatus.ASSIGNED,
          assignments: [{ id: 'assignment-1', agentId: 'agent-1' }],
        }]),
        update: jest.fn(),
      },
      assignment: { update: jest.fn() },
      syncChange: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const crypto = {
      normalizePhone: jest.fn(() => '+8613800000001'),
      hashPhone: jest.fn(() => 'phone-hash'),
      encryptPhone: jest.fn(() => ({ phoneCiphertext: new Uint8Array(), phoneIv: new Uint8Array(), phoneTag: new Uint8Array() })),
      maskPhone: jest.fn(() => '138****0001'),
    };
    const audit = { record: jest.fn() };
    const service = new SuppressionService(prisma as any, crypto as any, audit as any);

    const result = await service.add({ phone: '13800000001', reason: '客户拒绝' }, 'admin-1');

    expect(tx.customer.update).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        status: CustomerStatus.SUPPRESSED,
        suppressionPreviousStatus: CustomerStatus.ASSIGNED,
      },
    }));
    expect(tx.assignment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AssignmentStatus.SUPPRESSED }),
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetUserId: 'agent-1', operation: 'REMOVE' }),
    });
    expect(result.withdrawnAssignments).toBe(1);
  });

  it.each([
    [CustomerStatus.COMPLETED, CustomerStatus.COMPLETED],
    [CustomerStatus.ASSIGNED, CustomerStatus.AVAILABLE],
    [CustomerStatus.AVAILABLE, CustomerStatus.AVAILABLE],
  ])('restores %s customers to %s when suppression is revoked', async (previous, expected) => {
    const tx = {
      suppressionEntry: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'suppression-1',
          phoneHash: 'phone-hash',
          phoneMasked: '138****0001',
        }),
        update: jest.fn(),
      },
      customer: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'customer-1',
          suppressionPreviousStatus: previous,
        }]),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
    };
    const audit = { record: jest.fn() };
    const service = new SuppressionService(prisma as any, {} as any, audit as any);

    await service.revoke('suppression-1', 'admin-1');

    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'customer-1' },
      data: { status: expected, suppressionPreviousStatus: null },
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SUPPRESSION_REVOKED',
    }), tx);
  });
});
