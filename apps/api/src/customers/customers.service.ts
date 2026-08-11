import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CustomerStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PhoneAttributionService } from '../common/phone-attribution.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateBatchDto,
  CreateCustomerDto,
  CustomerQueryDto,
  UpdateBatchDto,
  UpdateCustomerDto,
} from './customers.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly phoneAttribution: PhoneAttributionService,
    private readonly audit: AuditService,
  ) {}

  async list(query: CustomerQueryDto) {
    let phoneHash: string | undefined;
    if (query.search && /^\+?[\d\s()-]{7,}$/.test(query.search)) {
      try {
        phoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(query.search));
      } catch {
        phoneHash = undefined;
      }
    }
    if (query.assignmentStatus === 'NOT_CONNECTED') {
      return this.listLatestNotConnected(query, phoneHash);
    }
    const assignmentFilter: Prisma.CustomerWhereInput =
      query.assignmentStatus === 'ASSIGNED'
        ? { assignments: { some: { status: 'ACTIVE' } } }
        : query.assignmentStatus === 'UNASSIGNED'
          ? { status: CustomerStatus.AVAILABLE, assignments: { none: { status: 'ACTIVE' } } }
          : query.assignmentStatus === 'COMPLETED'
            ? { status: CustomerStatus.COMPLETED }
            : query.assignmentStatus === 'WITHDRAWN'
              ? {
                  status: CustomerStatus.AVAILABLE,
                  assignments: { some: { status: { in: ['RECLAIMED', 'REASSIGNED'] } } },
                }
              : {};
    const where: Prisma.CustomerWhereInput = {
      AND: [
        assignmentFilter,
        query.status === 'ARCHIVED'
          ? { status: CustomerStatus.ARCHIVED }
          : query.status === 'ACTIVE'
            ? { status: { notIn: [CustomerStatus.ARCHIVED, CustomerStatus.SUPPRESSED] } }
            : { status: { not: CustomerStatus.ARCHIVED } },
      ],
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.agentId
        ? { assignments: { some: { agentId: query.agentId, status: 'ACTIVE' } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { notes: { contains: query.search, mode: 'insensitive' } },
              ...(phoneHash ? [{ phoneHash }] : []),
            ],
          }
        : {}),
      ...(query.phone
        ? {
            phoneHash: this.crypto.hashPhone(
              this.crypto.normalizePhone(query.phone),
            ),
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: this.publicSelect(),
      }),
      this.prisma.customer.count({ where }),
    ]);
    return { items: items.map((item) => this.toPublic(item)), page: query.page, pageSize: query.pageSize, total };
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        ...this.publicSelect(),
        assignments: {
          orderBy: { assignedAt: 'desc' },
          select: {
            id: true,
            status: true,
            assignedAt: true,
            endedAt: true,
            agent: {
              select: { id: true, displayName: true, username: true },
            },
            assignedBy: { select: { id: true, displayName: true } },
          },
        },
      },
    });
    if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
    return { ...this.toPublic(customer), assignmentHistory: customer.assignments };
  }

  async create(body: CreateCustomerDto, actorId: string) {
    const normalized = this.crypto.normalizePhone(body.phone);
    const phoneHash = this.crypto.hashPhone(normalized);
    const province = body.province?.trim();
    const city = body.city?.trim();
    const carrier = body.carrier?.trim();
    const attribution = province && city && carrier
      ? null
      : this.phoneAttribution.lookup(normalized);
    const suppressed = await this.prisma.suppressionEntry.findFirst({
      where: { phoneHash, revokedAt: null },
    });
    if (suppressed) {
      throw new ConflictException({
        code: 'PHONE_SUPPRESSED',
        detail: '该号码已进入拒呼名单',
      });
    }
    const customer = await this.prisma.customer.create({
      data: {
        name: body.name,
        ...this.crypto.encryptPhone(normalized),
        phoneHash,
        phoneMasked: this.crypto.maskPhone(normalized),
        batchId: body.batchId,
        province: province || attribution?.province,
        city: city || attribution?.city,
        carrier: carrier || attribution?.carrier,
        notes: body.notes,
        tags: body.tags ?? [],
        createdById: actorId,
      } satisfies Prisma.CustomerUncheckedCreateInput,
      select: this.publicSelect(),
    });
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_CREATED',
      entityType: 'customer',
      entityId: customer.id,
      metadata: { phone: customer.phoneMasked },
    });
    return this.toPublic(customer);
  }

  lookupPhoneAttribution(phone: string) {
    const normalized = this.crypto.normalizePhone(phone);
    return this.phoneAttribution.lookup(normalized) ?? {};
  }

  async update(id: string, body: UpdateCustomerDto, actorId: string) {
    const { version, ...updates } = body;
    const result = await this.prisma.customer.updateMany({
      where: { id, version, erasedAt: null },
      data: {
        ...updates,
        tags: updates.tags ?? undefined,
        version: { increment: 1 },
      },
    });
    if (result.count === 0) {
      const current = await this.prisma.customer.findUnique({
        where: { id },
        select: { erasedAt: true },
      });
      if (!current) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
      if (current.erasedAt) {
        throw new ConflictException({ code: 'CUSTOMER_PERSONAL_DATA_ERASED' });
      }
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        detail: '客户资料已被其他人修改，请刷新后重试',
      });
    }
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_UPDATED',
      entityType: 'customer',
      entityId: id,
      metadata: { fields: Object.keys(updates) },
    });
    return this.get(id);
  }

  async archive(id: string, actorId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const assignments = await tx.assignment.findMany({
        where: { customerId: id, status: 'ACTIVE' },
      });
      await tx.customer.update({
        where: { id },
        data: { status: CustomerStatus.ARCHIVED, archivedAt: now },
      });
      await tx.assignment.updateMany({
        where: { customerId: id, status: 'ACTIVE' },
        data: { status: 'RECLAIMED', endedAt: now, endedById: actorId },
      });
      for (const assignment of assignments) {
        await tx.syncChange.create({
          data: {
            targetUserId: assignment.agentId,
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            operation: 'REMOVE',
            payload: { assignmentId: assignment.id, reason: 'CUSTOMER_ARCHIVED' },
          },
        });
      }
    });
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_ARCHIVED',
      entityType: 'customer',
      entityId: id,
    });
  }

  async erasePersonalData(id: string, reason: string, actorId: string): Promise<void> {
    const erasedIdentity = `erased:${id}:${randomUUID()}`;
    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({
        where: { id },
        select: { status: true, erasedAt: true },
      });
      if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
      if (customer.status !== CustomerStatus.ARCHIVED) {
        throw new ConflictException({
          code: 'CUSTOMER_MUST_BE_ARCHIVED',
          detail: '依法删除前必须先归档客户并撤回待呼任务',
        });
      }
      if (customer.erasedAt) {
        throw new ConflictException({ code: 'CUSTOMER_ALREADY_ERASED' });
      }

      const erased = await tx.customer.updateMany({
        where: { id, status: CustomerStatus.ARCHIVED, erasedAt: null },
        data: {
          name: '已删除客户',
          ...this.crypto.encryptPhone(erasedIdentity),
          phoneHash: this.crypto.hashPhone(erasedIdentity),
          phoneMasked: '***',
          province: null,
          city: null,
          carrier: null,
          notes: null,
          tags: [],
          erasedAt: new Date(),
          version: { increment: 1 },
        },
      });
      if (!erased.count) {
        throw new ConflictException({ code: 'CUSTOMER_ALREADY_ERASED' });
      }
      await this.audit.record({
        actorId,
        action: 'CUSTOMER_PERSONAL_DATA_ERASED',
        entityType: 'customer',
        entityId: id,
        metadata: { reason },
      }, tx);
    });
  }

  async revealPhone(id: string, actorId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException({ code: 'CUSTOMER_NOT_FOUND' });
    if (customer.erasedAt) {
      throw new ConflictException({ code: 'CUSTOMER_PERSONAL_DATA_ERASED' });
    }
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_PHONE_REVEALED',
      entityType: 'customer',
      entityId: id,
      metadata: { phone: customer.phoneMasked },
    });
    return {
      phone: this.crypto.decryptPhone(customer),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async listBatches(query: Pick<CustomerQueryDto, 'page' | 'pageSize' | 'search'>) {
    const where: Prisma.BatchWhereInput = query.search
      ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { code: { contains: query.search, mode: 'insensitive' } }] }
      : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.batch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.batch.count({ where }),
    ]);
    const batchIds = rows.map((batch) => batch.id);
    const emptyCounts: Array<{ batchId: string | null; _count: { _all: number } }> = [];
    const [customerCounts, assignedCounts, completedCounts] = batchIds.length
      ? await Promise.all([
          this.prisma.customer.groupBy({
            by: ['batchId'],
            where: { batchId: { in: batchIds } },
            _count: { _all: true },
          }),
          this.prisma.customer.groupBy({
            by: ['batchId'],
            where: {
              batchId: { in: batchIds },
              assignments: { some: { status: 'ACTIVE' } },
            },
            _count: { _all: true },
          }),
          this.prisma.customer.groupBy({
            by: ['batchId'],
            where: { batchId: { in: batchIds }, status: CustomerStatus.COMPLETED },
            _count: { _all: true },
          }),
        ])
      : [emptyCounts, emptyCounts, emptyCounts];
    const asCountMap = (counts: typeof emptyCounts) =>
      new Map(counts.map((item) => [item.batchId, item._count._all]));
    const customersByBatch = asCountMap(customerCounts);
    const assignedByBatch = asCountMap(assignedCounts);
    const completedByBatch = asCountMap(completedCounts);
    return {
      items: rows.map((batch) => ({
        id: batch.id,
        name: batch.name,
        code: batch.code,
        notes: batch.description,
        customerCount: customersByBatch.get(batch.id) ?? 0,
        assignedCount: assignedByBatch.get(batch.id) ?? 0,
        completedCount: completedByBatch.get(batch.id) ?? 0,
        createdAt: batch.createdAt,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createBatch(body: CreateBatchDto, actorId: string) {
    const batch = await this.prisma.batch.create({
      data: {
        name: body.name,
        description: body.description ?? body.notes,
        code: body.code || `B${Date.now().toString(36).toUpperCase()}`,
        createdById: actorId,
      },
    });
    await this.audit.record({
      actorId,
      action: 'BATCH_CREATED',
      entityType: 'batch',
      entityId: batch.id,
    });
    return batch;
  }

  updateBatch(id: string, body: UpdateBatchDto) {
    return this.prisma.batch.update({
      where: { id },
      data: {
        name: body.name,
        code: body.code,
        description: body.description ?? body.notes,
      },
    });
  }

  private publicSelect() {
    return {
      id: true,
      name: true,
      phoneMasked: true,
      province: true,
      city: true,
      carrier: true,
      notes: true,
      tags: true,
      status: true,
      version: true,
      lastContactAt: true,
      erasedAt: true,
      createdAt: true,
      updatedAt: true,
      batch: { select: { id: true, name: true } },
      assignments: {
        take: 1,
        orderBy: [
          { assignedAt: 'desc' as const },
          { createdAt: 'desc' as const },
          { id: 'desc' as const },
        ],
        select: {
          id: true,
          status: true,
          agent: {
            select: { id: true, displayName: true, username: true },
          },
          assignedAt: true,
          callAttempts: {
            take: 1,
            orderBy: [
              { initiatedAt: 'desc' as const },
              { createdAt: 'desc' as const },
              { id: 'desc' as const },
            ],
            select: { status: true },
          },
        },
      },
      _count: { select: { callAttempts: true } },
    };
  }

  private toPublic(item: any) {
    const activeAssignment = item.assignments?.find((assignment: any) => !assignment.status || assignment.status === 'ACTIVE');
    const lastCallStatus = item.assignments?.[0]?.callAttempts?.[0]?.status;
    const assignmentStatus = lastCallStatus === 'NOT_CONNECTED'
      ? 'NOT_CONNECTED'
      : activeAssignment
      ? 'ASSIGNED'
      : item.status === CustomerStatus.COMPLETED
        ? 'COMPLETED'
        : item.status === CustomerStatus.AVAILABLE
          ? 'UNASSIGNED'
          : 'WITHDRAWN';
    return {
      ...item,
      status: item.status === CustomerStatus.ARCHIVED ? 'ARCHIVED' : 'ACTIVE',
      assignmentStatus,
      assignedAgent: activeAssignment?.agent ?? null,
      lastCallStatus: lastCallStatus ?? null,
      attemptCount: item._count?.callAttempts ?? 0,
      lastCalledAt: item.lastContactAt ?? null,
      assignments: undefined,
      _count: undefined,
    };
  }

  private async listLatestNotConnected(query: CustomerQueryDto, searchedPhoneHash?: string) {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`latest_attempts."status" = 'NOT_CONNECTED'::"AttemptStatus"`,
    ];
    if (query.status === 'ARCHIVED') {
      conditions.push(Prisma.sql`customer."status" = 'ARCHIVED'::"CustomerStatus"`);
    } else if (query.status === 'ACTIVE') {
      conditions.push(Prisma.sql`customer."status" NOT IN ('ARCHIVED'::"CustomerStatus", 'SUPPRESSED'::"CustomerStatus")`);
    } else {
      conditions.push(Prisma.sql`customer."status" <> 'ARCHIVED'::"CustomerStatus"`);
    }
    if (query.batchId) {
      conditions.push(Prisma.sql`customer."batchId" = CAST(${query.batchId} AS UUID)`);
    }
    if (query.agentId) {
      conditions.push(Prisma.sql`latest_assignments."agentId" = CAST(${query.agentId} AS UUID)`);
    }
    if (query.search) {
      const searchConditions = [
        Prisma.sql`customer."name" ILIKE ${`%${query.search}%`}`,
        Prisma.sql`customer."notes" ILIKE ${`%${query.search}%`}`,
      ];
      if (searchedPhoneHash) {
        searchConditions.push(Prisma.sql`customer."phoneHash" = ${searchedPhoneHash}`);
      }
      conditions.push(Prisma.sql`(${Prisma.join(searchConditions, ' OR ')})`);
    }
    if (query.phone) {
      const exactPhoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(query.phone));
      conditions.push(Prisma.sql`customer."phoneHash" = ${exactPhoneHash}`);
    }

    const [match] = await this.prisma.$queryRaw<Array<{ total: number; ids: string[] }>>(Prisma.sql`
      WITH latest_assignments AS (
        SELECT DISTINCT ON (assignment."customerId")
          assignment."id",
          assignment."customerId",
          assignment."agentId"
        FROM "assignments" AS assignment
        ORDER BY
          assignment."customerId",
          assignment."assignedAt" DESC,
          assignment."createdAt" DESC,
          assignment."id" DESC
      ), latest_attempts AS (
        SELECT DISTINCT ON (attempt."assignmentId")
          attempt."assignmentId",
          attempt."status"
        FROM "call_attempts" AS attempt
        ORDER BY
          attempt."assignmentId",
          attempt."initiatedAt" DESC,
          attempt."createdAt" DESC,
          attempt."id" DESC
      ), matched AS (
        SELECT customer."id", customer."createdAt"
        FROM "customers" AS customer
        INNER JOIN latest_assignments
          ON latest_assignments."customerId" = customer."id"
        INNER JOIN latest_attempts
          ON latest_attempts."assignmentId" = latest_assignments."id"
        WHERE ${Prisma.join(conditions, ' AND ')}
      ), paged AS (
        SELECT matched."id", matched."createdAt"
        FROM matched
        ORDER BY matched."createdAt" DESC, matched."id" DESC
        LIMIT ${query.pageSize}
        OFFSET ${(query.page - 1) * query.pageSize}
      )
      SELECT
        (SELECT COUNT(*)::INTEGER FROM matched) AS "total",
        COALESCE(
          ARRAY_AGG(paged."id" ORDER BY paged."createdAt" DESC, paged."id" DESC)
            FILTER (WHERE paged."id" IS NOT NULL),
          ARRAY[]::UUID[]
        ) AS "ids"
      FROM paged
    `);
    const ids = match?.ids ?? [];
    const items = ids.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: ids } },
          select: this.publicSelect(),
        })
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      items: ids.flatMap((id) => {
        const item = byId.get(id);
        return item ? [this.toPublic(item)] : [];
      }),
      page: query.page,
      pageSize: query.pageSize,
      total: match?.total ?? 0,
    };
  }
}
