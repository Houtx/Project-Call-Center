import { Injectable, Logger } from '@nestjs/common';
import {
  AssignmentStatus,
  AttemptStatus,
  CallResultSource,
  CustomerStatus,
  DeviceStatus,
  ImportJobStatus,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from '../common/recording.service';

const DAY_MS = 86_400_000;
const DEFAULT_TECHNICAL_RETENTION_DAYS = 7;
const DEFAULT_HOUSEKEEPING_BATCH_SIZE = 5_000;

export interface HousekeepingResult {
  idempotencyRecords: number;
  refreshTokens: number;
  cancelledImports: number;
  importRows: number;
  syncChanges: number;
  recordings: number;
}

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

  async housekeeping(): Promise<HousekeepingResult> {
    const now = new Date();
    const retentionBefore = new Date(
      now.getTime() - this.positiveInteger(
        process.env.TECHNICAL_DATA_RETENTION_DAYS,
        DEFAULT_TECHNICAL_RETENTION_DAYS,
      ) * DAY_MS,
    );
    const batchSize = Math.min(
      this.positiveInteger(
        process.env.HOUSEKEEPING_BATCH_SIZE,
        DEFAULT_HOUSEKEEPING_BATCH_SIZE,
      ),
      50_000,
    );

    const expiredIdempotency = await this.prisma.idempotencyRecord.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true },
      take: batchSize,
    });
    const idempotencyRecords = expiredIdempotency.length
      ? (await this.prisma.idempotencyRecord.deleteMany({
          where: { id: { in: expiredIdempotency.map((row) => row.id) } },
        })).count
      : 0;

    const staleTokens = await this.prisma.refreshToken.findMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: retentionBefore } },
        ],
      },
      select: { id: true },
      take: batchSize,
    });
    const refreshTokens = staleTokens.length
      ? (await this.prisma.refreshToken.deleteMany({
          where: { id: { in: staleTokens.map((row) => row.id) } },
        })).count
      : 0;

    const cancelledImports = (await this.prisma.importJob.updateMany({
      where: {
        status: ImportJobStatus.PREVIEWED,
        createdAt: { lt: retentionBefore },
      },
      data: {
        status: ImportJobStatus.CANCELLED,
        completedAt: now,
        failureMessage: '导入预览超过保留期，系统已自动取消',
      },
    })).count;
    const staleImportRows = await this.prisma.importRow.findMany({
      where: {
        importJob: {
          status: {
            in: [
              ImportJobStatus.COMPLETED,
              ImportJobStatus.FAILED,
              ImportJobStatus.CANCELLED,
            ],
          },
          OR: [
            { completedAt: { lt: retentionBefore } },
            { completedAt: null, updatedAt: { lt: retentionBefore } },
          ],
        },
      },
      select: { id: true },
      take: batchSize,
    });
    const importRows = staleImportRows.length
      ? (await this.prisma.importRow.deleteMany({
          where: { id: { in: staleImportRows.map((row) => row.id) } },
        })).count
      : 0;

    const activeDevices = await this.prisma.device.findMany({
      where: { status: DeviceStatus.ACTIVE },
      select: { userId: true, lastSyncCursor: true },
    });
    const safeCursorByUser = new Map<string, bigint>();
    for (const device of activeDevices) {
      const current = safeCursorByUser.get(device.userId);
      if (current === undefined || device.lastSyncCursor < current) {
        safeCursorByUser.set(device.userId, device.lastSyncCursor);
      }
    }
    let syncChanges = 0;
    for (const [userId, safeCursor] of safeCursorByUser) {
      const remaining = batchSize - syncChanges;
      if (remaining <= 0) break;
      const staleChanges = await this.prisma.syncChange.findMany({
        where: {
          targetUserId: userId,
          cursor: { lte: safeCursor },
          createdAt: { lt: retentionBefore },
        },
        select: { cursor: true },
        take: remaining,
      });
      if (!staleChanges.length) continue;
      syncChanges += (await this.prisma.syncChange.deleteMany({
        where: { cursor: { in: staleChanges.map((row) => row.cursor) } },
      })).count;
    }

    const recordings = await this.recordings.cleanupExpired();
    const result = {
      idempotencyRecords,
      refreshTokens,
      cancelledImports,
      importRows,
      syncChanges,
      recordings,
    };
    if (Object.values(result).some((count) => count > 0)) {
      this.logger.log(`Housekeeping completed: ${JSON.stringify(result)}`);
    }
    return result;
  }

  private positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
}
