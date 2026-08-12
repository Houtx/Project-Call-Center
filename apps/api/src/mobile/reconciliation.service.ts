import { Injectable, Logger } from '@nestjs/common';
import {
  AssignmentStatus,
  AttemptStatus,
  CallResultSource,
  CustomerStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from '../common/recording.service';

@Injectable()
export class CallReconciliationService {
  private readonly logger = new Logger(CallReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recordings: RecordingService,
  ) {}

  async reconcileExpired(limit = 500): Promise<number> {
    const now = new Date();
    const [attempts, policy] = await Promise.all([
      this.prisma.callAttempt.findMany({
        where: {
          status: AttemptStatus.COLLECTING,
          collectingDeadlineAt: { lte: now },
        },
        orderBy: { collectingDeadlineAt: 'asc' },
        take: limit,
      }),
      this.prisma.mobileAppPolicy.upsert({
        where: { id: 'android' },
        create: { id: 'android' },
        update: {},
      }),
    ]);
    let reconciled = 0;
    for (const attempt of attempts) {
      const changed = await this.prisma.$transaction(
        async (tx) => {
          const claimed = await tx.callAttempt.updateMany({
            where: { id: attempt.id, status: AttemptStatus.COLLECTING },
            data: { status: AttemptStatus.UNKNOWN, completedAt: now },
          });
          if (!claimed.count) return false;
          await tx.callResult.upsert({
            where: { attemptId: attempt.id },
            create: {
              attemptId: attempt.id,
              deviceId: attempt.deviceId,
              source: CallResultSource.TIMEOUT,
              durationSeconds: null,
            },
            update: {
              deviceId: attempt.deviceId,
              source: CallResultSource.TIMEOUT,
              durationSeconds: null,
            },
          });
          const assignment = await tx.assignment.findFirst({
            where: { id: attempt.assignmentId, status: AssignmentStatus.ACTIVE },
          });
          if (!assignment) return true;
          if (attempt.attemptNumber >= policy.maxCallAttempts) {
            await tx.assignment.update({
              where: { id: assignment.id },
              data: {
                status: AssignmentStatus.COMPLETED,
                endedAt: now,
                endReason: 'ATTEMPT_LIMIT_UNKNOWN',
              },
            });
            await tx.customer.update({
              where: { id: assignment.customerId },
              data: { status: CustomerStatus.COMPLETED },
            });
            await tx.syncChange.create({
              data: {
                targetUserId: assignment.agentId,
                entityType: 'ASSIGNMENT',
                entityId: assignment.id,
                operation: 'REMOVE',
                payload: { assignmentId: assignment.id, reason: 'ATTEMPT_LIMIT_UNKNOWN' },
              },
            });
          } else {
            await tx.syncChange.create({
              data: {
                targetUserId: assignment.agentId,
                entityType: 'ASSIGNMENT',
                entityId: assignment.id,
                operation: 'UPSERT',
                payload: { assignmentId: assignment.id, customerId: assignment.customerId },
              },
            });
          }
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (changed) reconciled += 1;
    }
    if (reconciled) {
      await this.audit.record({
        action: 'CALL_ATTEMPTS_TIMED_OUT',
        entityType: 'call_attempt',
        metadata: { count: reconciled },
      });
      this.logger.log(`Marked ${reconciled} expired call attempts UNKNOWN`);
    }
    return reconciled;
  }

  async housekeeping(): Promise<void> {
    const now = new Date();
    await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.recordings.cleanupExpired();
  }
}
