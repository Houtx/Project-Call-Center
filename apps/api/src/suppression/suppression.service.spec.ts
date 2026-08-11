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
        findMany: jest.fn().mockResolvedValue([{ id: 'customer-1', assignments: [{ id: 'assignment-1', agentId: 'agent-1' }] }]),
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
      data: { status: CustomerStatus.SUPPRESSED },
    }));
    expect(tx.assignment.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: AssignmentStatus.SUPPRESSED }),
    }));
    expect(tx.syncChange.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetUserId: 'agent-1', operation: 'REMOVE' }),
    });
    expect(result.withdrawnAssignments).toBe(1);
  });
});
