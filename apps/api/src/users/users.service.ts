import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  AttemptStatus,
  CustomerStatus,
  DeviceStatus,
  PermissionState,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { PageQueryDto } from '../common/contracts';
import {
  AllowedDeviceModelDto,
  CreateAgentDto,
  UpdateAgentDto,
  UpdateAllowedDeviceModelDto,
  UpdateMobileAppPolicyDto,
} from './users.dto';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAgents(query: PageQueryDto) {
    const today = this.shanghaiToday();
    const where: Prisma.UserWhereInput = {
      role: Role.AGENT,
      ...(query.search
        ? {
            OR: [
              { username: { contains: query.search, mode: 'insensitive' } },
              { displayName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total, policy] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          assignments: { where: { status: 'ACTIVE' }, select: { id: true } },
          callAttempts: {
            where: { initiatedAt: { gte: today.from, lte: today.to } },
            select: { status: true },
          },
          devices: { where: { status: DeviceStatus.ACTIVE }, include: { allowedDeviceModel: true }, take: 1 },
        },
      }),
      this.prisma.user.count({ where }),
      this.prisma.mobileAppPolicy.upsert({
        where: { id: 'android' },
        create: { id: 'android' },
        update: {},
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        enabled: row.status === UserStatus.ACTIVE,
        pendingCount: row.assignments.length,
        todayAttempts: row.callAttempts.length,
        todayConnected: row.callAttempts.filter((item) => item.status === 'CONNECTED').length,
        recordingEnabled: row.recordingEnabled,
        device: row.devices[0]
          ? this.mapDevice(row.devices[0], row, policy.deviceCompatibilityRequired)
          : null,
        createdAt: row.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createAgent(
    body: CreateAgentDto,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const agent = await client.user.create({
      data: {
        username: body.username.trim().toLowerCase(),
        displayName: body.displayName,
        passwordHash: await argon2.hash(body.password, { type: argon2.argon2id }),
        role: Role.AGENT,
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    await this.audit.record({
      actorId,
      action: 'AGENT_CREATED',
      entityType: 'user',
      entityId: agent.id,
    }, client);
    return agent;
  }

  async updateAgent(
    id: string,
    body: UpdateAgentDto,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const active = body.active ?? body.enabled;
    const status = active === undefined
      ? undefined
      : active
        ? UserStatus.ACTIVE
        : UserStatus.DISABLED;
    const agent = await client.user.update({
      where: { id, role: Role.AGENT },
      data: {
        displayName: body.displayName,
        status,
        ...(body.recordingEnabled === undefined ? {} : { recordingEnabled: body.recordingEnabled }),
        ...(!active && active !== undefined
          ? { tokenVersion: { increment: 1 } }
          : {}),
      },
      select: { id: true, username: true, displayName: true, status: true, recordingEnabled: true },
    });
    if (status === UserStatus.DISABLED) {
      await Promise.all([
        client.device.updateMany({
          where: { userId: id, status: DeviceStatus.ACTIVE },
          data: { status: DeviceStatus.REVOKED, revokedAt: new Date() },
        }),
        client.refreshToken.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
    }
    await this.audit.record({
      actorId,
      action: 'AGENT_UPDATED',
      entityType: 'user',
      entityId: id,
      metadata: {
        status,
        displayNameChanged: body.displayName !== undefined,
        recordingEnabled: body.recordingEnabled,
      },
    }, client);
    return agent;
  }

  async resetPassword(
    id: string,
    password: string,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const result = await client.user.updateMany({
      where: { id, role: Role.AGENT },
      data: {
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        tokenVersion: { increment: 1 },
      },
    });
    if (!result.count) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    await client.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorId,
      action: 'AGENT_PASSWORD_RESET',
      entityType: 'user',
      entityId: id,
    }, client);
  }

  async listDevices() {
    const policy = await this.getMobileAppPolicy();
    const rows = await this.prisma.device.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, displayName: true } },
        allowedDeviceModel: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      user: row.user,
      manufacturer: row.manufacturer,
      model: row.model,
      androidVersion: row.androidVersion,
      appVersion: row.appVersion,
      status: row.status,
      callPhonePermission: row.callPhonePermission,
      callLogPermission: row.callLogPermission,
      recordAudioPermission: row.recordAudioPermission,
      lastHealthAt: row.lastHealthAt,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
      allowedDeviceModel: row.allowedDeviceModel
        ? { enabled: row.allowedDeviceModel.enabled }
        : null,
      compatibilityRequired: policy.deviceCompatibilityRequired,
    }));
  }

  async revokeDevice(
    id: string,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const device = await client.device.update({
      where: { id },
      data: { status: DeviceStatus.REVOKED, revokedAt: new Date() },
    });
    await client.refreshToken.updateMany({
      where: { deviceId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorId,
      action: 'DEVICE_REVOKED',
      entityType: 'device',
      entityId: id,
      metadata: { agentId: device.userId },
    }, client);
  }

  async revokeAgentDevice(
    deviceOrAgentId: string,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const device = await client.device.findFirst({
      where: {
        status: DeviceStatus.ACTIVE,
        OR: [{ id: deviceOrAgentId }, { userId: deviceOrAgentId }],
      },
    });
    if (!device) throw new NotFoundException({ code: 'ACTIVE_DEVICE_NOT_FOUND' });
    await this.revokeDevice(device.id, actorId, client);
  }

  listAllowedModels() {
    return this.prisma.allowedDeviceModel.findMany({
      orderBy: [{ manufacturer: 'asc' }, { model: 'asc' }, { androidSdk: 'asc' }],
    });
  }

  async addAllowedModel(
    body: AllowedDeviceModelDto,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const item = await client.allowedDeviceModel.upsert({
      where: {
        manufacturer_model_androidSdk: {
          manufacturer: body.manufacturer,
          model: body.model,
          androidSdk: body.androidSdk,
        },
      },
      create: body,
      update: { enabled: true, notes: body.notes },
    });
    await this.audit.record({
      actorId,
      action: 'DEVICE_MODEL_ALLOWED',
      entityType: 'allowed_device_model',
      entityId: item.id,
      metadata: { manufacturer: body.manufacturer, model: body.model, androidSdk: body.androidSdk },
    }, client);
    return item;
  }

  async updateAllowedModel(
    id: string,
    body: UpdateAllowedDeviceModelDto,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const item = await client.allowedDeviceModel.update({
      where: { id },
      data: body,
    });
    await this.audit.record({
      actorId,
      action: 'DEVICE_MODEL_UPDATED',
      entityType: 'allowed_device_model',
      entityId: item.id,
      metadata: { enabled: item.enabled, notesChanged: body.notes !== undefined },
    }, client);
    return item;
  }

  getMobileAppPolicy() {
    return this.prisma.mobileAppPolicy.upsert({
      where: { id: 'android' },
      create: { id: 'android' },
      update: {},
    });
  }

  async updateMobileAppPolicy(
    body: UpdateMobileAppPolicyDto,
    actorId: string,
    client?: Prisma.TransactionClient,
  ) {
    if (body.latestVersionCode < body.minimumVersionCode) {
      throw new BadRequestException({
        code: 'INVALID_APP_VERSION_POLICY',
        detail: '最新版本号不能低于最低版本号',
      });
    }
    const operation = async (tx: Prisma.TransactionClient) => {
      const policy = await tx.mobileAppPolicy.upsert({
        where: { id: 'android' },
        create: { id: 'android', ...body, downloadUrl: body.downloadUrl || null },
        update: { ...body, downloadUrl: body.downloadUrl || null },
      });
      const exhausted = await tx.assignment.findMany({
        where: {
          status: AssignmentStatus.ACTIVE,
          callAttempts: {
            some: {
              attemptNumber: { gte: policy.maxCallAttempts },
              status: { in: [AttemptStatus.NOT_CONNECTED, AttemptStatus.UNKNOWN] },
            },
            none: { status: AttemptStatus.COLLECTING },
          },
        },
        select: { id: true, customerId: true, agentId: true },
      });
      if (exhausted.length) {
        const assignmentIds = exhausted.map((item) => item.id);
        const customerIds = [...new Set(exhausted.map((item) => item.customerId))];
        const now = new Date();
        await tx.assignment.updateMany({
          where: { id: { in: assignmentIds }, status: AssignmentStatus.ACTIVE },
          data: {
            status: AssignmentStatus.COMPLETED,
            endedAt: now,
            endedById: actorId,
            endReason: 'ATTEMPT_LIMIT_POLICY',
          },
        });
        await tx.customer.updateMany({
          where: { id: { in: customerIds } },
          data: { status: CustomerStatus.COMPLETED },
        });
        await tx.syncChange.createMany({
          data: exhausted.map((item) => ({
            targetUserId: item.agentId,
            entityType: 'ASSIGNMENT',
            entityId: item.id,
            operation: 'REMOVE',
            payload: { assignmentId: item.id, reason: 'ATTEMPT_LIMIT_POLICY' },
          })),
        });
      }
      const result = { policy, closedAssignments: exhausted.length };
      await this.audit.record({
        actorId,
        action: 'MOBILE_APP_POLICY_UPDATED',
        entityType: 'mobile_app_policy',
        entityId: policy.id,
        metadata: {
          minimumVersionCode: policy.minimumVersionCode,
          latestVersionCode: policy.latestVersionCode,
          forceUpgrade: policy.forceUpgrade,
          maxCallAttempts: policy.maxCallAttempts,
          recordingRetentionDays: policy.recordingRetentionDays,
          closedAssignments: result.closedAssignments,
        },
      }, tx);
      return result;
    };
    const { policy } = client
      ? await operation(client)
      : await this.prisma.$transaction(operation);
    return policy;
  }

  private mapDevice(
    device: {
      id: string;
      userId: string;
      manufacturer: string;
      model: string;
      androidVersion: string;
      appVersion: string;
      status: DeviceStatus;
      callPhonePermission: PermissionState;
      callLogPermission: PermissionState;
      recordAudioPermission: PermissionState;
      lastHealthAt: Date | null;
      activatedAt: Date | null;
      createdAt: Date;
      allowedDeviceModel: { enabled: boolean } | null;
    },
    user: { displayName: string },
    compatibilityRequired = true,
  ) {
    const active = device.status === DeviceStatus.ACTIVE;
    const offline = !device.lastHealthAt || device.lastHealthAt.getTime() < Date.now() - 5 * 60 * 1000;
    const blocked = !active || (compatibilityRequired && !device.allowedDeviceModel?.enabled) ||
      device.callPhonePermission === PermissionState.DENIED ||
      device.callLogPermission === PermissionState.DENIED;
    const warning = device.callPhonePermission !== PermissionState.GRANTED ||
      device.callLogPermission !== PermissionState.GRANTED ||
      (compatibilityRequired && !device.allowedDeviceModel?.enabled);
    return {
      id: device.id,
      agentId: device.userId,
      agentName: user.displayName,
      brand: device.manufacturer,
      model: device.model,
      androidVersion: device.androidVersion,
      appVersion: device.appVersion,
      health: blocked ? 'BLOCKED' : offline ? 'OFFLINE' : warning ? 'WARNING' : 'HEALTHY',
      active,
      permissionCallPhone: device.callPhonePermission === PermissionState.GRANTED,
      permissionReadCallLog: device.callLogPermission === PermissionState.GRANTED,
      permissionRecordAudio: device.recordAudioPermission === PermissionState.GRANTED,
      lastSeenAt: device.lastHealthAt,
      activatedAt: device.activatedAt ?? device.createdAt,
    };
  }

  private shanghaiToday(): { from: Date; to: Date } {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
    const from = new Date(midnight - 8 * 60 * 60 * 1000);
    return { from, to: new Date(from.getTime() + 86_400_000 - 1) };
  }
}
