import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  AttemptStatus,
  CallResultSource,
  CustomerStatus,
  DeviceStatus,
  PermissionState,
  Prisma,
  Role,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import type { AuthPrincipal } from '../common/contracts';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from '../common/recording.service';
import {
  CallObservationBatchDto,
  CallObservationDto,
  CreateCallAttemptDto,
  HeartbeatDto,
} from './mobile.dto';
import { callEligibility, classifyDuration, RETRY_INTERVAL_MS } from './call-policy';

const COLLECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const DIAL_NUMBER_TTL_MS = 60 * 1000;

@Injectable()
export class MobileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly recordings: RecordingService,
  ) {}

  async bootstrap(principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    const policy = await this.getPolicy();
    const allowlisted = !policy.deviceCompatibilityRequired || Boolean(device.allowedDeviceModel?.enabled);
    const versionAllowed = device.appVersionCode >= policy.minimumVersionCode &&
      (!policy.forceUpgrade || device.appVersionCode >= policy.latestVersionCode);
    const compatible = device.status === DeviceStatus.ACTIVE && allowlisted && versionAllowed;
    return {
      serverTime: new Date().toISOString(),
      minimumVersionCode: policy.minimumVersionCode,
      latestVersionCode: policy.latestVersionCode,
      forceUpgrade: !versionAllowed,
      downloadUrl: policy.downloadUrl,
      maxCallAttempts: policy.maxCallAttempts,
      device: {
        id: device.id,
        status: device.status,
        compatible,
        reason: compatible
          ? null
          : !allowlisted
            ? 'DEVICE_NOT_ALLOWLISTED'
            : !versionAllowed
              ? 'APP_UPDATE_REQUIRED'
              : 'DEVICE_NOT_ACTIVE',
      },
    };
  }

  async sync(principal: AuthPrincipal, cursorText?: string, limit = 200) {
    const device = await this.requireDevice(principal, false, false);
    const cursor = this.parseCursor(cursorText);
    const [changes, policy] = await Promise.all([
      this.prisma.syncChange.findMany({
        where: { targetUserId: principal.sub, cursor: { gt: cursor } },
        orderBy: { cursor: 'asc' },
        take: limit,
      }),
      this.getPolicy(),
    ]);
    const responseChanges = [];
    for (const change of changes) {
      if (change.entityType !== 'ASSIGNMENT' || change.operation === 'REMOVE') {
        responseChanges.push({
          operation: change.operation,
          entityType: change.entityType,
          entityId: change.entityId,
          assignment: null,
        });
        continue;
      }
      const assignment = await this.assignmentPayload(
        change.entityId,
        principal.sub,
        policy.maxCallAttempts,
      );
      responseChanges.push({
        operation: assignment ? 'UPSERT' : 'REMOVE',
        entityType: 'ASSIGNMENT',
        entityId: change.entityId,
        assignment,
      });
    }
    const nextCursor = changes.at(-1)?.cursor ?? cursor;
    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSyncCursor: nextCursor, lastSyncAt: new Date() },
    });
    return {
      cursor: nextCursor.toString(),
      maxCallAttempts: policy.maxCallAttempts,
      changes: responseChanges,
    };
  }

  async revealPhone(assignmentId: string, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, true, true);
    const assignment = await this.requireActiveAssignment(assignmentId, principal.sub);
    await this.ensureNotSuppressed(assignment.customer.phoneHash);
    await this.audit.record({
      actorId: principal.sub,
      action: 'MOBILE_PHONE_REVEALED',
      entityType: 'assignment',
      entityId: assignment.id,
      metadata: { deviceId: device.id, phone: assignment.customer.phoneMasked },
    });
    return {
      phone: this.crypto.decryptPhone(assignment.customer),
      expiresAt: new Date(Date.now() + DIAL_NUMBER_TTL_MS).toISOString(),
    };
  }

  async createCallAttempt(body: CreateCallAttemptDto, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, true, true);
    const existing = await this.prisma.callAttempt.findUnique({
      where: { clientAttemptId: body.clientAttemptId },
      include: { customer: true },
    });
    if (existing) {
      if (existing.deviceId !== device.id || existing.assignmentId !== body.assignmentId) {
        throw new ConflictException({ code: 'CLIENT_ATTEMPT_ID_REUSED' });
      }
      if (!existing.dialTokenExpiresAt || existing.dialTokenExpiresAt <= new Date()) {
        throw new ConflictException({ code: 'DIAL_AUTHORIZATION_EXPIRED' });
      }
      return this.attemptResponse(existing, existing.customer);
    }
    const baselineAt = new Date(body.callLogBaselineAt);
    if (baselineAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException({ code: 'DEVICE_TIME_INVALID' });
    }

    const attempt = await this.prisma.$transaction(
      async (tx) => {
        const assignment = await tx.assignment.findFirst({
          where: {
            id: body.assignmentId,
            agentId: principal.sub,
            status: AssignmentStatus.ACTIVE,
          },
          include: { customer: true },
        });
        if (!assignment) throw new ConflictException({ code: 'ASSIGNMENT_NOT_ACTIVE' });
        const suppressed = await tx.suppressionEntry.count({
          where: { phoneHash: assignment.customer.phoneHash, revokedAt: null },
        });
        if (suppressed || assignment.customer.status === CustomerStatus.SUPPRESSED) {
          throw new ConflictException({ code: 'PHONE_SUPPRESSED' });
        }
        const policy = await tx.mobileAppPolicy.upsert({
          where: { id: 'android' },
          create: { id: 'android' },
          update: {},
        });
        const agent = await tx.user.findUnique({ where: { id: principal.sub }, select: { recordingEnabled: true } });
        const previous = await tx.callAttempt.findMany({
          where: { assignmentId: assignment.id },
          orderBy: { initiatedAt: 'desc' },
          take: policy.maxCallAttempts,
        });
        const eligibility = callEligibility(previous, policy.maxCallAttempts);
        if (!eligibility.allowed && eligibility.reason === 'ATTEMPT_LIMIT_REACHED') {
          throw new ConflictException({
            code: eligibility.reason,
            detail: `该客户已达 ${policy.maxCallAttempts} 次外呼上限`,
          });
        }
        if (!eligibility.allowed && eligibility.reason === 'RETRY_INTERVAL_NOT_REACHED') {
          throw new ConflictException({
            code: eligibility.reason,
            detail: '距上次外呼未满 30 分钟',
            retryAt: eligibility.retryAt.toISOString(),
          });
        }
        const now = new Date();
        const created = await tx.callAttempt.create({
          data: {
            assignmentId: assignment.id,
            customerId: assignment.customerId,
            agentId: principal.sub,
            deviceId: device.id,
            clientAttemptId: body.clientAttemptId,
            attemptNumber: eligibility.attemptNumber,
            status: AttemptStatus.COLLECTING,
            recordingRequested: Boolean(agent?.recordingEnabled),
            dialTokenHash: createHash('sha256').update(`${body.clientAttemptId}:${now.toISOString()}`).digest('hex'),
            dialTokenExpiresAt: new Date(now.getTime() + DIAL_NUMBER_TTL_MS),
            callLogBaselineId: body.callLogBaselineId,
            callLogBaselineAt: baselineAt,
            initiatedAt: now,
            dialedAt: now,
            collectingDeadlineAt: new Date(now.getTime() + COLLECTION_WINDOW_MS),
          },
          include: { customer: true },
        });
        if (created.recordingRequested) {
          await this.recordings.createPending(created.id, principal.sub, device.id, tx);
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.audit.record({
      actorId: principal.sub,
      action: 'MOBILE_CALL_ATTEMPT_CREATED',
      entityType: 'call_attempt',
      entityId: attempt.id,
      metadata: { deviceId: device.id, assignmentId: attempt.assignmentId, phone: attempt.customer.phoneMasked, attemptNumber: attempt.attemptNumber },
    });
    return this.attemptResponse(attempt, attempt.customer);
  }

  async cancelCallAttempt(attemptId: string, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    await this.prisma.$transaction(
      async (tx) => {
        const attempt = await tx.callAttempt.findFirst({
          where: {
            id: attemptId,
            agentId: principal.sub,
            deviceId: device.id,
          },
          include: { result: true },
        });
        if (!attempt) {
          return;
        }
        if (attempt.status !== AttemptStatus.COLLECTING || attempt.result) {
          throw new ConflictException({
            code: 'CALL_ATTEMPT_NOT_CANCELLABLE',
            detail: '该外呼尝试已经产生结果，不能撤销',
          });
        }
        await tx.callAttempt.delete({ where: { id: attempt.id } });
        await this.audit.record({
          actorId: principal.sub,
          action: 'MOBILE_CALL_ATTEMPT_CANCELLED',
          entityType: 'call_attempt',
          entityId: attempt.id,
          metadata: {
            deviceId: device.id,
            assignmentId: attempt.assignmentId,
            reason: 'DIAL_LAUNCH_FAILED',
          },
        }, tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { cancelled: true };
  }

  async uploadRecording(attemptId: string, file: Express.Multer.File | undefined, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    if (!file) throw new BadRequestException({ code: 'RECORDING_FILE_REQUIRED' });
    const attempt = await this.prisma.callAttempt.findFirst({ where: { id: attemptId, agentId: principal.sub, deviceId: device.id, recordingRequested: true } });
    if (!attempt) throw new ConflictException({ code: 'CALL_RECORDING_NOT_REQUESTED' });
    return this.recordings.upload(attemptId, principal.sub, device.id, {
      buffer: file.buffer,
      mimetype: file.mimetype,
    });
  }

  async markRecordingUnsupported(attemptId: string, reason: string, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    const attempt = await this.prisma.callAttempt.findFirst({ where: { id: attemptId, agentId: principal.sub, deviceId: device.id, recordingRequested: true } });
    if (!attempt) throw new ConflictException({ code: 'CALL_RECORDING_NOT_REQUESTED' });
    return this.recordings.markUnsupported(attemptId, principal.sub, device.id, reason.slice(0, 120));
  }

  async observeCalls(body: CallObservationBatchDto, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    let accepted = 0;
    let duplicates = 0;
    for (const observation of body.results) {
      if (observation.durationSeconds === undefined) continue;
      let outcome: 'ACCEPTED' | 'DUPLICATE';
      try {
        outcome = await this.recordObservation(observation, principal.sub, device.id);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const raced = await this.prisma.callResult.findUnique({
            where: { eventId: observation.eventId },
          });
          if (raced) outcome = 'DUPLICATE';
          else throw new ConflictException({ code: 'CALL_LOG_ALREADY_MATCHED' });
        } else {
          throw error;
        }
      }
      if (outcome === 'DUPLICATE') duplicates += 1;
      else accepted += 1;
    }
    if (accepted) {
      await this.audit.record({
        actorId: principal.sub,
        action: 'MOBILE_CALL_RESULTS_UPLOADED',
        entityType: 'call_result',
        metadata: { deviceId: device.id, accepted, duplicates },
      });
    }
    return { accepted, duplicates };
  }

  async heartbeat(body: HeartbeatDto, principal: AuthPrincipal): Promise<void> {
    const device = await this.requireDevice(principal, false, false);
    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        appVersion: body.appVersion,
        appVersionCode: body.appVersionCode,
        callPhonePermission: body.callPhonePermission,
        callLogPermission: body.callLogPermission,
        recordAudioPermission: body.recordAudioPermission ?? PermissionState.UNKNOWN,
        lastHealthAt: new Date(),
      },
    });
  }

  async history(principal: AuthPrincipal, page = 1, pageSize = 50) {
    await this.requireDevice(principal, false, false);
    const where = { agentId: principal.sub };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.callAttempt.findMany({
        where,
        orderBy: { initiatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: true, result: true },
      }),
      this.prisma.callAttempt.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        attemptId: item.id,
        assignmentId: item.assignmentId,
        customerName: item.customer.name,
        phoneMasked: item.customer.phoneMasked,
        status: item.status,
        startedAt: item.result?.systemCallStartedAt ?? item.initiatedAt,
        durationSeconds: item.result?.durationSeconds ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  async revealHistoryPhone(attemptId: string, principal: AuthPrincipal) {
    const device = await this.requireDevice(principal, false, false);
    const attempt = await this.prisma.callAttempt.findFirst({
      where: { id: attemptId, agentId: principal.sub },
      include: { customer: true },
    });
    if (!attempt) throw new NotFoundException({ code: 'CALL_ATTEMPT_NOT_FOUND' });
    if (attempt.customer.erasedAt) {
      throw new ConflictException({ code: 'CUSTOMER_PERSONAL_DATA_ERASED' });
    }
    await this.audit.record({
      actorId: principal.sub,
      action: 'MOBILE_CALL_HISTORY_PHONE_REVEALED',
      entityType: 'call_attempt',
      entityId: attempt.id,
      metadata: { deviceId: device.id, phone: attempt.customer.phoneMasked },
    });
    return {
      phone: this.crypto.decryptPhone(attempt.customer),
      expiresAt: new Date(Date.now() + DIAL_NUMBER_TTL_MS).toISOString(),
    };
  }

  private async recordObservation(
    observation: CallObservationDto,
    agentId: string,
    deviceId: string,
  ): Promise<'ACCEPTED' | 'DUPLICATE'> {
    const duplicate = await this.prisma.callResult.findUnique({ where: { eventId: observation.eventId } });
    if (duplicate) return 'DUPLICATE';
    const startedAt = new Date(observation.systemCallStartedAt);
    const endedAt = new Date(observation.systemCallEndedAt);
    if (endedAt < startedAt || startedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException({ code: 'INVALID_CALL_TIMESTAMPS' });
    }

    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await tx.callAttempt.findFirst({
          where: { id: observation.attemptId, agentId, deviceId },
          include: { result: true },
        });
        if (!attempt) throw new NotFoundException({ code: 'CALL_ATTEMPT_NOT_FOUND' });
        if (attempt.result?.eventId === observation.eventId) return 'DUPLICATE';
        if (attempt.result?.source === CallResultSource.CALL_LOG) {
          throw new ConflictException({ code: 'CALL_RESULT_ALREADY_FINAL' });
        }
        if (attempt.callLogBaselineAt && startedAt.getTime() < attempt.callLogBaselineAt.getTime() - 2 * 60 * 1000) {
          throw new ConflictException({ code: 'CALL_LOG_BEFORE_BASELINE' });
        }
        const usedLog = await tx.callResult.findFirst({
          where: {
            deviceId,
            systemCallLogId: observation.systemCallLogId,
            systemCallStartedAt: startedAt,
            attemptId: { not: attempt.id },
          },
        });
        if (usedLog) throw new ConflictException({ code: 'CALL_LOG_ALREADY_MATCHED' });
        const status = classifyDuration(observation.durationSeconds!);
        if (attempt.result) {
          await tx.callResult.update({
            where: { attemptId: attempt.id },
            data: {
              deviceId,
              eventId: observation.eventId,
              source: CallResultSource.CALL_LOG,
              durationSeconds: observation.durationSeconds,
              systemCallLogId: observation.systemCallLogId,
              systemCallStartedAt: startedAt,
              systemCallEndedAt: endedAt,
              matchedAt: new Date(),
              clientObservedAt: new Date(observation.clientObservedAt),
            },
          });
        } else {
          await tx.callResult.create({
            data: {
              attemptId: attempt.id,
              deviceId,
              eventId: observation.eventId,
              source: CallResultSource.CALL_LOG,
              durationSeconds: observation.durationSeconds,
              systemCallLogId: observation.systemCallLogId,
              systemCallStartedAt: startedAt,
              systemCallEndedAt: endedAt,
              matchedAt: new Date(),
              clientObservedAt: new Date(observation.clientObservedAt),
            },
          });
        }
        await tx.callAttempt.update({
          where: { id: attempt.id },
          data: { status, completedAt: new Date() },
        });
        await tx.customer.update({
          where: { id: attempt.customerId },
          data: { lastContactAt: startedAt },
        });
        const policy = await tx.mobileAppPolicy.upsert({
          where: { id: 'android' },
          create: { id: 'android' },
          update: {},
        });
        if (status === AttemptStatus.CONNECTED) {
          await this.completeCustomer(tx, attempt.customerId, agentId, 'CONNECTED');
        } else if (attempt.attemptNumber >= policy.maxCallAttempts) {
          const originalStillActive = await tx.assignment.count({
            where: { id: attempt.assignmentId, status: AssignmentStatus.ACTIVE },
          });
          if (originalStillActive) {
            await this.completeCustomer(tx, attempt.customerId, agentId, 'ATTEMPT_LIMIT');
          }
        } else {
          const active = await tx.assignment.findFirst({
            where: { id: attempt.assignmentId, status: AssignmentStatus.ACTIVE },
          });
          if (active) await this.enqueueAssignmentUpsert(tx, active.id, active.agentId, active.customerId);
        }
        return 'ACCEPTED';
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private async completeCustomer(
    tx: Prisma.TransactionClient,
    customerId: string,
    actorId: string,
    reason: string,
  ): Promise<void> {
    const activeAssignments = await tx.assignment.findMany({
      where: { customerId, status: AssignmentStatus.ACTIVE },
    });
    const now = new Date();
    for (const assignment of activeAssignments) {
      await tx.assignment.update({
        where: { id: assignment.id },
        data: {
          status: AssignmentStatus.COMPLETED,
          endedAt: now,
          endedById: actorId,
          endReason: reason,
        },
      });
      await tx.syncChange.create({
        data: {
          targetUserId: assignment.agentId,
          entityType: 'ASSIGNMENT',
          entityId: assignment.id,
          operation: 'REMOVE',
          payload: { assignmentId: assignment.id, reason },
        },
      });
    }
    await tx.customer.update({
      where: { id: customerId },
      data: { status: CustomerStatus.COMPLETED },
    });
  }

  private async enqueueAssignmentUpsert(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    agentId: string,
    customerId: string,
  ): Promise<void> {
    await tx.syncChange.create({
      data: {
        targetUserId: agentId,
        entityType: 'ASSIGNMENT',
        entityId: assignmentId,
        operation: 'UPSERT',
        payload: { assignmentId, customerId },
      },
    });
  }

  private async assignmentPayload(
    assignmentId: string,
    agentId: string,
    maxCallAttempts: number,
  ) {
    const assignment = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, agentId, status: AssignmentStatus.ACTIVE },
      include: {
        customer: { include: { batch: true } },
        callAttempts: { orderBy: { initiatedAt: 'desc' } },
      },
    });
    if (!assignment) return null;
    const latest = assignment.callAttempts[0];
    const nextAllowed = latest
      ? new Date(latest.initiatedAt.getTime() + RETRY_INTERVAL_MS)
      : null;
    return {
      assignmentId: assignment.id,
      customerId: assignment.customerId,
      name: assignment.customer.name,
      phoneMasked: assignment.customer.phoneMasked,
      batchName: assignment.customer.batch?.name ?? null,
      province: assignment.customer.province,
      city: assignment.customer.city,
      carrier: assignment.customer.carrier,
      notes: assignment.customer.notes,
      tags: assignment.customer.tags,
      attemptCount: assignment.callAttempts.length,
      nextCallAllowedAt: nextAllowed?.toISOString() ?? null,
      lastCalledAt: latest?.initiatedAt.toISOString() ?? null,
      state: assignment.callAttempts.length >= maxCallAttempts
        ? 'COMPLETED'
        : nextAllowed && nextAllowed > new Date()
          ? 'WAITING'
          : 'READY',
      updatedAt: assignment.updatedAt.toISOString(),
    };
  }

  private async requireActiveAssignment(assignmentId: string, agentId: string) {
    const assignment = await this.prisma.assignment.findFirst({
      where: { id: assignmentId, agentId, status: AssignmentStatus.ACTIVE },
      include: { customer: true },
    });
    if (!assignment) throw new NotFoundException({ code: 'ASSIGNMENT_NOT_ACTIVE' });
    return assignment;
  }

  private async ensureNotSuppressed(phoneHash: string): Promise<void> {
    const suppressed = await this.prisma.suppressionEntry.count({
      where: { phoneHash, revokedAt: null },
    });
    if (suppressed) throw new ConflictException({ code: 'PHONE_SUPPRESSED' });
  }

  private async requireDevice(
    principal: AuthPrincipal,
    requireOnline: boolean,
    requirePermissions: boolean,
  ) {
    if (principal.role !== Role.AGENT || !principal.deviceId) {
      throw new UnauthorizedException({ code: 'DEVICE_TOKEN_REQUIRED' });
    }
    const device = await this.prisma.device.findFirst({
      where: {
        id: principal.deviceId,
        userId: principal.sub,
        status: DeviceStatus.ACTIVE,
      },
      include: { allowedDeviceModel: true },
    });
    if (!device) throw new UnauthorizedException({ code: 'DEVICE_NOT_ACTIVE' });
    const policy = await this.getPolicy();
    if (policy.deviceCompatibilityRequired && !device.allowedDeviceModel?.enabled) {
      throw new ForbiddenException({ code: 'DEVICE_NOT_ALLOWLISTED' });
    }
    if (
      device.appVersionCode < policy.minimumVersionCode ||
      (policy.forceUpgrade && device.appVersionCode < policy.latestVersionCode)
    ) {
      throw new ForbiddenException({ code: 'APP_UPDATE_REQUIRED' });
    }
    if (requireOnline && (!device.lastHealthAt || device.lastHealthAt.getTime() < Date.now() - ONLINE_WINDOW_MS)) {
      throw new ConflictException({ code: 'DEVICE_OFFLINE', detail: '设备必须在线才能发起外呼' });
    }
    if (
      requirePermissions &&
      (device.callPhonePermission !== PermissionState.GRANTED ||
        device.callLogPermission !== PermissionState.GRANTED)
    ) {
      throw new ForbiddenException({ code: 'PHONE_PERMISSIONS_REQUIRED' });
    }
    return device;
  }

  private getPolicy() {
    return this.prisma.mobileAppPolicy.upsert({
      where: { id: 'android' },
      create: { id: 'android' },
      update: {},
    });
  }

  private attemptResponse(
    attempt: {
      id: string;
      attemptNumber: number;
      dialTokenExpiresAt: Date | null;
      collectingDeadlineAt: Date | null;
      recordingRequested: boolean;
    },
    customer: { phoneCiphertext: Uint8Array; phoneIv: Uint8Array; phoneTag: Uint8Array },
  ) {
    return {
      attemptId: attempt.id,
      phone: this.crypto.decryptPhone(customer),
      expiresAt: attempt.dialTokenExpiresAt!.toISOString(),
      collectionDeadlineAt: attempt.collectingDeadlineAt!.toISOString(),
      attemptNumber: attempt.attemptNumber,
      recordingRequested: attempt.recordingRequested,
    };
  }

  private parseCursor(value?: string): bigint {
    if (!value) return 0n;
    try {
      const cursor = BigInt(value);
      if (cursor < 0n) throw new Error('negative');
      return cursor;
    } catch {
      throw new BadRequestException({ code: 'INVALID_SYNC_CURSOR' });
    }
  }

}
