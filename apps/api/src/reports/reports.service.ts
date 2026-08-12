import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AttemptStatus,
  CustomerStatus,
  DeviceStatus,
  PermissionState,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from '../common/recording.service';
import { AuditQueryDto, CallQueryDto } from './reports.dto';

interface SummaryAttempt {
  customerId: string;
  status: AttemptStatus;
  result: { durationSeconds: number | null } | null;
}

interface DashboardAttempt extends SummaryAttempt {
  agentId: string;
  agent: { id: string; displayName: string; username: string };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly recordings: RecordingService,
  ) {}

  async summary(query: CallQueryDto) {
    const attempts = await this.prisma.callAttempt.findMany({
      where: this.callWhere(query),
      select: {
        customerId: true,
        status: true,
        result: { select: { durationSeconds: true } },
      },
    });
    return this.summarizeAttempts(attempts);
  }

  async dashboard() {
    const { from, to } = this.shanghaiToday();
    const [attempts, activeCustomers, assignedPending, activeAgents, deviceCount, policy] = await Promise.all([
      this.prisma.callAttempt.findMany({
        where: { initiatedAt: { gte: from, lte: to } },
        select: {
          agentId: true,
          customerId: true,
          status: true,
          result: { select: { durationSeconds: true } },
          agent: { select: { id: true, displayName: true, username: true } },
        },
      }),
      this.prisma.customer.count({
        where: { status: { in: [CustomerStatus.AVAILABLE, CustomerStatus.ASSIGNED] } },
      }),
      this.prisma.assignment.count({ where: { status: 'ACTIVE' } }),
      this.prisma.user.count({
        where: {
          role: Role.AGENT,
          status: UserStatus.ACTIVE,
          devices: {
            some: {
              status: DeviceStatus.ACTIVE,
              lastHealthAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
            },
          },
        },
      }),
      this.prisma.device.count({ where: { status: DeviceStatus.ACTIVE } }),
      this.prisma.mobileAppPolicy.findUnique({ where: { id: 'android' } }),
    ]);
    const summary = this.summarizeAttempts(attempts);
    const agentStats = this.summarizeAgents(attempts);
    const healthyDevices = await this.prisma.device.count({
      where: {
        status: DeviceStatus.ACTIVE,
        callPhonePermission: PermissionState.GRANTED,
        callLogPermission: PermissionState.GRANTED,
        lastHealthAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
        appVersionCode: { gte: policy?.minimumVersionCode ?? 1 },
        ...(policy?.deviceCompatibilityRequired !== false
          ? { allowedDeviceModel: { enabled: true } }
          : {}),
      },
    });
    return {
      ...summary,
      activeCustomers,
      assignedPending,
      activeAgents,
      healthyDevices,
      deviceCount,
      agentStats,
    };
  }

  private summarizeAttempts(attempts: SummaryAttempt[]) {
    const connected = attempts.filter((item) => item.status === AttemptStatus.CONNECTED).length;
    const notConnected = attempts.filter((item) => item.status === AttemptStatus.NOT_CONNECTED).length;
    const unknown = attempts.filter((item) => item.status === AttemptStatus.UNKNOWN).length;
    const collecting = attempts.filter((item) =>
      item.status === AttemptStatus.COLLECTING || item.status === AttemptStatus.PENDING,
    ).length;
    const known = connected + notConnected;
    const totalDurationSeconds = attempts.reduce(
      (sum, item) => sum + (item.status === AttemptStatus.CONNECTED
        ? Math.max(item.result?.durationSeconds ?? 0, 0)
        : 0),
      0,
    );
    return {
      attempts: attempts.length,
      uniqueCustomers: new Set(attempts.map((item) => item.customerId)).size,
      connected,
      notConnected,
      unknown,
      collecting,
      dataCompletenessRate: attempts.length ? known / attempts.length : 0,
      connectionRate: known ? connected / known : 0,
      totalDurationSeconds,
      averageDurationSeconds: connected ? Math.round(totalDurationSeconds / connected) : 0,
    };
  }

  private summarizeAgents(attempts: DashboardAttempt[]) {
    const stats = new Map<string, {
      agentId: string;
      agentName: string;
      username: string;
      attempts: number;
      customerIds: Set<string>;
      connected: number;
      notConnected: number;
      collecting: number;
      unknown: number;
      totalDurationSeconds: number;
      maxDurationSeconds: number;
    }>();

    for (const attempt of attempts) {
      const current = stats.get(attempt.agentId) ?? {
        agentId: attempt.agent.id,
        agentName: attempt.agent.displayName,
        username: attempt.agent.username,
        attempts: 0,
        customerIds: new Set<string>(),
        connected: 0,
        notConnected: 0,
        collecting: 0,
        unknown: 0,
        totalDurationSeconds: 0,
        maxDurationSeconds: 0,
      };
      current.attempts += 1;
      current.customerIds.add(attempt.customerId);
      if (attempt.status === AttemptStatus.CONNECTED) {
        const duration = Math.max(attempt.result?.durationSeconds ?? 0, 0);
        current.connected += 1;
        current.totalDurationSeconds += duration;
        current.maxDurationSeconds = Math.max(current.maxDurationSeconds, duration);
      } else if (attempt.status === AttemptStatus.NOT_CONNECTED) {
        current.notConnected += 1;
      } else if (attempt.status === AttemptStatus.UNKNOWN) {
        current.unknown += 1;
      } else {
        current.collecting += 1;
      }
      stats.set(attempt.agentId, current);
    }

    return [...stats.values()]
      .map(({ customerIds, ...item }) => {
        const known = item.connected + item.notConnected;
        return {
          ...item,
          uniqueCustomers: customerIds.size,
          connectionRate: known ? item.connected / known : 0,
          averageDurationSeconds: item.connected
            ? Math.round(item.totalDurationSeconds / item.connected)
            : 0,
        };
      })
      .sort((left, right) =>
        right.attempts - left.attempts ||
        right.connected - left.connected ||
        left.agentName.localeCompare(right.agentName, 'zh-CN'),
      );
  }

  async calls(query: CallQueryDto) {
    const where = this.callWhere(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.callAttempt.findMany({
        where,
        orderBy: { initiatedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          customer: { include: { batch: true } },
          agent: true,
          result: true,
          recording: true,
        },
      }),
      this.prisma.callAttempt.count({ where }),
    ]);
    return {
      items: rows.map((row) => this.callRecord(row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async openRecording(id: string, actorId: string, download: boolean) {
    return this.recordings.open(id, actorId, download);
  }

  async revealCallPhone(id: string, actorId: string) {
    const attempt = await this.prisma.callAttempt.findUnique({
      where: { id },
      include: { customer: true },
    });
    if (!attempt) throw new NotFoundException({ code: 'CALL_ATTEMPT_NOT_FOUND' });
    if (attempt.customer.erasedAt) {
      throw new ConflictException({ code: 'CUSTOMER_PERSONAL_DATA_ERASED' });
    }
    await this.audit.record({
      actorId,
      action: 'CALL_PHONE_REVEALED',
      entityType: 'call_attempt',
      entityId: attempt.id,
      metadata: { phone: attempt.customer.phoneMasked },
    });
    return {
      phone: this.crypto.decryptPhone(attempt.customer),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async exportCalls(query: CallQueryDto, actorId: string): Promise<Buffer> {
    const rows = await this.prisma.callAttempt.findMany({
      where: this.callWhere(query),
      orderBy: { initiatedAt: 'desc' },
      take: 100_000,
      include: {
        customer: { include: { batch: true } },
        agent: true,
        result: true,
        recording: true,
      },
    });
    const data = [
      ['外呼ID', '客户', '号码', '坐席', '批次', '状态', '发起时间', '结束时间', '时长(秒)', '采集时间'],
      ...rows.map((row) => {
        const item = this.callRecord(row);
        return [item.attemptId, item.customerName, item.phoneMasked, item.agentName, item.batchName ?? '', item.status, item.startedAt, item.endedAt ?? '', item.durationSeconds ?? '', item.collectedAt ?? ''];
      }),
    ];
    await this.audit.record({
      actorId,
      action: 'CALLS_EXPORTED',
      entityType: 'call_attempt',
      metadata: { count: rows.length },
    });
    return Buffer.from(`\uFEFF${data.map((line) => line.map((cell) => this.csvCell(cell)).join(',')).join('\r\n')}`, 'utf8');
  }

  async audits(query: AuditQueryDto) {
    const where: Prisma.AuditEventWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.resourceType ? { entityType: query.resourceType } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { action: { contains: query.search, mode: 'insensitive' } },
              { entityType: { contains: query.search, mode: 'insensitive' } },
              { entityId: { contains: query.search, mode: 'insensitive' } },
              { actor: { displayName: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { actor: { select: { displayName: true } } },
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id.toString(),
        actorName: row.actor?.displayName ?? '系统',
        action: row.action,
        resourceType: row.entityType,
        resourceId: row.entityId,
        summary: this.auditSummary(row.metadata),
        createdAt: row.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private callWhere(query: CallQueryDto): Prisma.CallAttemptWhereInput {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.agentId ? { agentId: query.agentId } : {}),
      ...(query.batchId ? { customer: { batchId: query.batchId } } : {}),
      ...(query.from || query.to
        ? {
            initiatedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { agent: { displayName: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private callRecord(row: Prisma.CallAttemptGetPayload<{
    include: {
      customer: { include: { batch: true } };
      agent: true;
      result: true;
      recording: true;
    };
  }>) {
    return {
      id: row.id,
      attemptId: row.id,
      customerId: row.customerId,
      customerName: row.customer.name ?? '未命名客户',
      phoneMasked: row.customer.phoneMasked,
      agentId: row.agentId,
      agentName: row.agent.displayName,
      batchId: row.customer.batch?.id ?? null,
      batchName: row.customer.batch?.name ?? null,
      status: row.status === AttemptStatus.PENDING ? AttemptStatus.COLLECTING : row.status,
      startedAt: (row.result?.systemCallStartedAt ?? row.initiatedAt).toISOString(),
      endedAt: row.result?.systemCallEndedAt?.toISOString() ?? null,
      durationSeconds: row.result?.durationSeconds ?? null,
      collectedAt: row.result?.receivedAt?.toISOString() ?? null,
      recording: row.recording
        ? this.recordings.metadata(row.recording)
        : null,
    };
  }

  private auditSummary(metadata: Prisma.JsonValue): string {
    if (!metadata || typeof metadata !== 'object') return '';
    const safe = JSON.stringify(metadata);
    return safe.length > 300 ? `${safe.slice(0, 297)}...` : safe;
  }

  private shanghaiToday(): { from: Date; to: Date } {
    const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const localMidnightAsUtc = Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    );
    const from = new Date(localMidnightAsUtc - 8 * 60 * 60 * 1000);
    return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000 - 1) };
  }

  private csvCell(value: unknown): string {
    let text = '';
    if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object' && value !== null) text = JSON.stringify(value) ?? '';
    else if (typeof value === 'string') text = value;
    else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
      text = value.toString();
    }
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
}
