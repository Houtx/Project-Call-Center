import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssignmentStatus,
  AttemptStatus,
  CustomerStatus,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { BulkAssignmentDto } from './assignments.dto';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  async assignOrReassign(
    customerIds: string[],
    agentId: string,
    actorId: string,
    recordAudit = true,
  ): Promise<number> {
    this.validateBatchSize(customerIds);
    const uniqueIds = [...new Set(customerIds)];
    const now = new Date();
    const changed = await this.assignmentTransaction(
      async (tx) => {
        const agent = await tx.user.findFirst({
          where: { id: agentId, role: Role.AGENT, status: UserStatus.ACTIVE },
        });
        if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
        const customers = await tx.customer.findMany({
          where: {
            id: { in: uniqueIds },
            status: { notIn: [CustomerStatus.ARCHIVED, CustomerStatus.SUPPRESSED, CustomerStatus.COMPLETED] },
          },
          include: { assignments: { where: { status: AssignmentStatus.ACTIVE } } },
        });
        if (customers.length !== uniqueIds.length) {
          throw new ConflictException({
            code: 'CUSTOMER_NOT_ASSIGNABLE',
            detail: '部分客户不存在或已完成、归档、拒呼',
          });
        }
        const blocked = await tx.suppressionEntry.findFirst({
          where: { phoneHash: { in: customers.map((item) => item.phoneHash) }, revokedAt: null },
        });
        if (blocked) throw new ConflictException({ code: 'PHONE_SUPPRESSED' });

        let count = 0;
        for (const customer of customers) {
          const current = customer.assignments[0];
          if (current?.agentId === agentId) continue;
          if (current) {
            await tx.assignment.update({
              where: { id: current.id },
              data: {
                status: AssignmentStatus.REASSIGNED,
                endedAt: now,
                endedById: actorId,
                endReason: '管理员改派',
              },
            });
            await tx.syncChange.create({
              data: {
                targetUserId: current.agentId,
                entityType: 'ASSIGNMENT',
                entityId: current.id,
                operation: 'REMOVE',
                payload: { assignmentId: current.id },
              },
            });
          }
          const assignment = await tx.assignment.create({
            data: { customerId: customer.id, agentId, assignedById: actorId },
          });
          await tx.customer.update({ where: { id: customer.id }, data: { status: CustomerStatus.ASSIGNED } });
          await tx.syncChange.create({
            data: {
              targetUserId: agentId,
              entityType: 'ASSIGNMENT',
              entityId: assignment.id,
              operation: 'UPSERT',
              payload: { assignmentId: assignment.id, customerId: customer.id },
            },
          });
          count += 1;
        }
        return count;
      },
    );
    if (recordAudit) {
      await this.audit.record({
        actorId,
        action: 'CUSTOMERS_ASSIGNED',
        entityType: 'assignment',
        metadata: { customerIds: uniqueIds, agentId, count: changed },
      });
    }
    return changed;
  }

  async previewBulk(body: BulkAssignmentDto) {
    const targets = await this.requireBulkTargets(body.agentIds, body.quantity);
    const result = await this.resolveBulkCustomerIds(body);
    const requestedCount = body.quantity;
    return {
      scope: body.scope,
      matchedCount: result.matchedCount,
      assignableCount: result.customerIds.length,
      skippedCount: result.skippedCount,
      requestedCount,
      remainingCount: Math.max(result.customerIds.length - requestedCount, 0),
      exceedsAssignable: requestedCount > result.customerIds.length,
      allocations: targets.map(({ agent, quantity }) => ({ agent, quantity })),
    };
  }

  async bulkAssign(body: BulkAssignmentDto, actorId: string) {
    const targets = await this.requireBulkTargets(body.agentIds, body.quantity);
    const preview = await this.resolveBulkCustomerIds(body);
    const requestedCount = body.quantity;
    if (requestedCount > preview.customerIds.length) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_QUANTITY_EXCEEDS_AVAILABLE',
        detail: `计划分配 ${requestedCount} 位客户，但当前仅有 ${preview.customerIds.length} 位可分配客户`,
        requestedCount,
        assignableCount: preview.customerIds.length,
      });
    }

    let assigned = 0;
    let cursor = 0;
    const allocations = [];
    for (const target of targets) {
      const customerIds = preview.customerIds.slice(cursor, cursor + target.quantity);
      let changed = 0;
      for (let offset = 0; offset < customerIds.length; offset += 1000) {
        const chunk = customerIds.slice(offset, offset + 1000);
        changed += body.assignmentStatus === 'NOT_CONNECTED'
          ? await this.retryAssign(chunk, target.agent.id, actorId, false)
          : await this.assignOrReassign(chunk, target.agent.id, actorId, false);
      }
      assigned += changed;
      cursor += target.quantity;
      allocations.push({
        agent: target.agent,
        quantity: target.quantity,
        assigned: changed,
      });
    }
    await this.audit.record({
      actorId,
      action: body.assignmentStatus === 'NOT_CONNECTED'
        ? 'CUSTOMERS_BULK_RETRY_ASSIGNED'
        : 'CUSTOMERS_BULK_ASSIGNED',
      entityType: 'assignment',
      metadata: {
        scope: body.scope,
        assignmentStatus: body.assignmentStatus,
        allocations: allocations.map((allocation) => ({
          agentId: allocation.agent.id,
          quantity: allocation.quantity,
          assigned: allocation.assigned,
        })),
        matchedCount: preview.matchedCount,
        assignableCount: preview.customerIds.length,
        skippedCount: preview.skippedCount,
        requestedCount,
        assigned,
      },
    });
    return {
      scope: body.scope,
      matchedCount: preview.matchedCount,
      assignableCount: preview.customerIds.length,
      skippedCount: preview.skippedCount,
      requestedCount,
      remainingCount: preview.customerIds.length - requestedCount,
      exceedsAssignable: false,
      assigned,
      allocations,
    };
  }

  async reclaimCustomers(customerIds: string[], actorId: string): Promise<number> {
    this.validateBatchSize(customerIds);
    const assignments = await this.prisma.assignment.findMany({
      where: { customerId: { in: [...new Set(customerIds)] }, status: AssignmentStatus.ACTIVE },
      select: { id: true },
    });
    if (!assignments.length) return 0;
    const result = await this.reclaim(assignments.map((item) => item.id), actorId, '管理员回收');
    return result.count;
  }

  async retryAssign(
    customerIds: string[],
    agentId: string,
    actorId: string,
    recordAudit = true,
  ): Promise<number> {
    this.validateBatchSize(customerIds);
    const uniqueIds = [...new Set(customerIds)];
    const now = new Date();
    const changed = await this.assignmentTransaction(async (tx) => {
      const agent = await tx.user.findFirst({
        where: { id: agentId, role: Role.AGENT, status: UserStatus.ACTIVE },
      });
      if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });

      const customers = await tx.customer.findMany({
        where: {
          id: { in: uniqueIds },
          status: { notIn: [CustomerStatus.ARCHIVED, CustomerStatus.SUPPRESSED] },
        },
        include: {
          assignments: {
            take: 1,
            orderBy: [
              { assignedAt: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
            include: {
              callAttempts: {
                take: 1,
                orderBy: [
                  { initiatedAt: 'desc' },
                  { createdAt: 'desc' },
                  { id: 'desc' },
                ],
                select: { status: true },
              },
            },
          },
        },
      });
      if (customers.length !== uniqueIds.length) {
        throw new ConflictException({
          code: 'CUSTOMER_NOT_RETRY_ASSIGNABLE',
          detail: '部分客户不存在，或已归档、进入拒呼名单',
        });
      }
      const invalid = customers.find(
        (customer) => customer.assignments[0]?.callAttempts[0]?.status !== AttemptStatus.NOT_CONNECTED,
      );
      if (invalid) {
        throw new ConflictException({
          code: 'LATEST_CALL_NOT_UNCONNECTED',
          detail: '部分客户的最新外呼并非未接通，请刷新筛选结果后重试',
        });
      }
      const suppressed = await tx.suppressionEntry.findFirst({
        where: {
          phoneHash: { in: customers.map((customer) => customer.phoneHash) },
          revokedAt: null,
        },
      });
      if (suppressed) throw new ConflictException({ code: 'PHONE_SUPPRESSED' });

      for (const customer of customers) {
        const previous = customer.assignments[0];
        if (previous.status === AssignmentStatus.ACTIVE) {
          await tx.assignment.update({
            where: { id: previous.id },
            data: {
              status: AssignmentStatus.REASSIGNED,
              endedAt: now,
              endedById: actorId,
              endReason: '未接通客户重新派发',
            },
          });
          await tx.syncChange.create({
            data: {
              targetUserId: previous.agentId,
              entityType: 'ASSIGNMENT',
              entityId: previous.id,
              operation: 'REMOVE',
              payload: { assignmentId: previous.id, reason: 'RETRY_REASSIGNED' },
            },
          });
        }

        const assignment = await tx.assignment.create({
          data: { customerId: customer.id, agentId, assignedById: actorId },
        });
        await tx.customer.update({
          where: { id: customer.id },
          data: { status: CustomerStatus.ASSIGNED },
        });
        await tx.syncChange.create({
          data: {
            targetUserId: agentId,
            entityType: 'ASSIGNMENT',
            entityId: assignment.id,
            operation: 'UPSERT',
            payload: { assignmentId: assignment.id, customerId: customer.id },
          },
        });
      }
      return customers.length;
    });

    if (recordAudit) {
      await this.audit.record({
        actorId,
        action: 'CUSTOMERS_RETRY_ASSIGNED',
        entityType: 'assignment',
        metadata: { customerIds: uniqueIds, agentId, count: changed },
      });
    }
    return changed;
  }

  async assign(customerIds: string[], agentId: string, actorId: string) {
    this.validateBatchSize(customerIds);
    const result = await this.assignmentTransaction(
      async (tx) => {
        const agent = await tx.user.findFirst({
          where: { id: agentId, role: Role.AGENT, status: UserStatus.ACTIVE },
        });
        if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });

        const customers = await tx.customer.findMany({
          where: {
            id: { in: customerIds },
            status: { in: [CustomerStatus.AVAILABLE, CustomerStatus.ASSIGNED] },
          },
          select: { id: true, phoneHash: true },
        });
        if (customers.length !== new Set(customerIds).size) {
          throw new ConflictException({
            code: 'CUSTOMER_NOT_ASSIGNABLE',
            detail: '部分客户不存在或已完成、归档、拒呼',
          });
        }
        const active = await tx.assignment.findFirst({
          where: { customerId: { in: customerIds }, status: AssignmentStatus.ACTIVE },
        });
        if (active) {
          throw new ConflictException({
            code: 'CUSTOMER_ALREADY_ASSIGNED',
            detail: '客户已分配，请使用改派',
          });
        }
        const suppressed = await tx.suppressionEntry.findFirst({
          where: {
            phoneHash: { in: customers.map((item) => item.phoneHash) },
            revokedAt: null,
          },
        });
        if (suppressed) {
          throw new ConflictException({ code: 'PHONE_SUPPRESSED' });
        }

        const assignments = [];
        for (const customer of customers) {
          const assignment = await tx.assignment.create({
            data: { customerId: customer.id, agentId, assignedById: actorId },
          });
          assignments.push(assignment);
          await tx.customer.update({
            where: { id: customer.id },
            data: { status: CustomerStatus.ASSIGNED },
          });
          await tx.syncChange.create({
            data: {
              targetUserId: agentId,
              entityType: 'ASSIGNMENT',
              entityId: assignment.id,
              operation: 'UPSERT',
              payload: { assignmentId: assignment.id, customerId: customer.id },
            },
          });
        }
        return assignments;
      },
    );
    await this.audit.record({
      actorId,
      action: 'CUSTOMERS_ASSIGNED',
      entityType: 'assignment',
      metadata: { customerIds, agentId, count: result.length },
    });
    return { items: result, count: result.length };
  }

  async reclaim(assignmentIds: string[], actorId: string, reason?: string) {
    this.validateBatchSize(assignmentIds);
    const now = new Date();
    const result = await this.assignmentTransaction(async (tx) => {
      const assignments = await tx.assignment.findMany({
        where: { id: { in: assignmentIds }, status: AssignmentStatus.ACTIVE },
      });
      if (assignments.length !== new Set(assignmentIds).size) {
        throw new ConflictException({ code: 'ASSIGNMENT_NOT_ACTIVE' });
      }
      for (const item of assignments) {
        await tx.assignment.update({
          where: { id: item.id },
          data: {
            status: AssignmentStatus.RECLAIMED,
            endedAt: now,
            endedById: actorId,
            endReason: reason,
          },
        });
        await tx.customer.update({
          where: { id: item.customerId },
          data: { status: CustomerStatus.AVAILABLE },
        });
        await tx.syncChange.create({
          data: {
            targetUserId: item.agentId,
            entityType: 'ASSIGNMENT',
            entityId: item.id,
            operation: 'REMOVE',
            payload: { assignmentId: item.id },
          },
        });
      }
      return assignments.length;
    });
    await this.audit.record({
      actorId,
      action: 'ASSIGNMENTS_RECLAIMED',
      entityType: 'assignment',
      metadata: { assignmentIds, reason, count: result },
    });
    return { count: result };
  }

  async reassign(
    assignmentIds: string[],
    targetAgentId: string,
    actorId: string,
    reason?: string,
  ) {
    this.validateBatchSize(assignmentIds);
    const now = new Date();
    const items = await this.assignmentTransaction(
      async (tx) => {
        const agent = await tx.user.findFirst({
          where: {
            id: targetAgentId,
            role: Role.AGENT,
            status: UserStatus.ACTIVE,
          },
        });
        if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
        const previous = await tx.assignment.findMany({
          where: { id: { in: assignmentIds }, status: AssignmentStatus.ACTIVE },
        });
        if (previous.length !== new Set(assignmentIds).size) {
          throw new ConflictException({ code: 'ASSIGNMENT_NOT_ACTIVE' });
        }
        const created = [];
        for (const old of previous) {
          await tx.assignment.update({
            where: { id: old.id },
            data: {
              status: AssignmentStatus.REASSIGNED,
              endedAt: now,
              endedById: actorId,
              endReason: reason,
            },
          });
          await tx.syncChange.create({
            data: {
              targetUserId: old.agentId,
              entityType: 'ASSIGNMENT',
              entityId: old.id,
              operation: 'REMOVE',
              payload: { assignmentId: old.id },
            },
          });
          const next = await tx.assignment.create({
            data: {
              customerId: old.customerId,
              agentId: targetAgentId,
              assignedById: actorId,
            },
          });
          await tx.syncChange.create({
            data: {
              targetUserId: targetAgentId,
              entityType: 'ASSIGNMENT',
              entityId: next.id,
              operation: 'UPSERT',
              payload: { assignmentId: next.id, customerId: old.customerId },
            },
          });
          created.push(next);
        }
        return created;
      },
    );
    await this.audit.record({
      actorId,
      action: 'ASSIGNMENTS_REASSIGNED',
      entityType: 'assignment',
      metadata: { assignmentIds, targetAgentId, count: items.length },
    });
    return { items, count: items.length };
  }

  private validateBatchSize(ids: string[]): void {
    if (!ids.length || ids.length > 1000) {
      throw new BadRequestException({
        code: 'INVALID_BATCH_SIZE',
        detail: '每次需选择 1 至 1000 条记录',
      });
    }
  }

  private async requireAgent(agentId: string) {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, role: Role.AGENT, status: UserStatus.ACTIVE },
      select: { id: true, username: true, displayName: true },
    });
    if (!agent) throw new NotFoundException({ code: 'AGENT_NOT_FOUND' });
    return agent;
  }

  private async requireBulkTargets(agentIds: string[], quantity: number) {
    if (!agentIds.length) {
      throw new BadRequestException({
        code: 'TARGET_AGENT_REQUIRED',
        detail: '至少选择一名坐席',
      });
    }
    const uniqueAgentIds = new Set(agentIds);
    if (uniqueAgentIds.size !== agentIds.length) {
      throw new BadRequestException({
        code: 'DUPLICATE_TARGET_AGENT',
        detail: '同一坐席只能出现在分配计划中一次',
      });
    }
    if (quantity < agentIds.length) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_QUANTITY_LESS_THAN_AGENT_COUNT',
        detail: `总分配数量不能少于所选坐席数（${agentIds.length} 名）`,
      });
    }
    const agents = await Promise.all(agentIds.map((agentId) => this.requireAgent(agentId)));
    const average = Math.floor(quantity / agents.length);
    const remainder = quantity % agents.length;
    return agents.map((agent, index) => ({
      agent,
      quantity: average + (index < remainder ? 1 : 0),
    }));
  }

  private async resolveBulkCustomerIds(body: BulkAssignmentDto) {
    const candidates = body.scope === 'FILTER' && body.assignmentStatus === 'NOT_CONNECTED'
      ? await this.findLatestNotConnectedCustomers(body)
      : await this.prisma.customer.findMany({
          where: this.buildBulkWhere(body),
          select: { id: true, phoneHash: true, status: true },
          orderBy: { createdAt: 'asc' },
        });
    const suppressedHashes = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += 1000) {
      const hashes = candidates.slice(offset, offset + 1000).map((item) => item.phoneHash);
      if (!hashes.length) continue;
      const entries = await this.prisma.suppressionEntry.findMany({
        where: { phoneHash: { in: hashes }, revokedAt: null },
        select: { phoneHash: true },
      });
      entries.forEach((entry) => suppressedHashes.add(entry.phoneHash));
    }
    const customerIds = candidates
      .filter((item) =>
        (item.status === CustomerStatus.AVAILABLE
          || item.status === CustomerStatus.ASSIGNED
          || (body.assignmentStatus === 'NOT_CONNECTED' && item.status === CustomerStatus.COMPLETED)) &&
        !suppressedHashes.has(item.phoneHash),
      )
      .map((item) => item.id);
    return {
      matchedCount: candidates.length,
      customerIds,
      skippedCount: candidates.length - customerIds.length,
    };
  }

  private buildBulkWhere(body: BulkAssignmentDto): Prisma.CustomerWhereInput {
    if (body.scope === 'ALL') return {};

    const assignmentFilter: Prisma.CustomerWhereInput =
      body.assignmentStatus === 'ASSIGNED'
        ? { assignments: { some: { status: AssignmentStatus.ACTIVE } } }
        : body.assignmentStatus === 'UNASSIGNED'
          ? { status: CustomerStatus.AVAILABLE, assignments: { none: { status: AssignmentStatus.ACTIVE } } }
          : body.assignmentStatus === 'COMPLETED'
            ? { status: CustomerStatus.COMPLETED }
            : body.assignmentStatus === 'WITHDRAWN'
              ? {
                  status: CustomerStatus.AVAILABLE,
                  assignments: { some: { status: { in: [AssignmentStatus.RECLAIMED, AssignmentStatus.REASSIGNED] } } },
                }
              : {};
    const statusFilter: Prisma.CustomerWhereInput = body.status === 'ARCHIVED'
      ? { status: CustomerStatus.ARCHIVED }
      : body.status === 'ACTIVE'
        ? { status: { notIn: [CustomerStatus.ARCHIVED, CustomerStatus.SUPPRESSED] } }
        : { status: { not: CustomerStatus.ARCHIVED } };
    let phoneHash: string | undefined;
    if (body.search && /^\+?[\d\s()-]{7,}$/.test(body.search)) {
      try {
        phoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(body.search));
      } catch {
        phoneHash = undefined;
      }
    }
    let exactPhoneHash: string | undefined;
    if (body.phone) {
      exactPhoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(body.phone));
    }
    return {
      AND: [assignmentFilter, statusFilter],
      ...(body.batchId ? { batchId: body.batchId } : {}),
      ...(body.agentId
        ? { assignments: { some: { agentId: body.agentId, status: AssignmentStatus.ACTIVE } } }
        : {}),
      ...(body.search
        ? {
            OR: [
              { name: { contains: body.search, mode: 'insensitive' } },
              { notes: { contains: body.search, mode: 'insensitive' } },
              ...(phoneHash ? [{ phoneHash }] : []),
            ],
          }
        : {}),
      ...(exactPhoneHash ? { phoneHash: exactPhoneHash } : {}),
    };
  }

  private async findLatestNotConnectedCustomers(body: BulkAssignmentDto) {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`latest_attempts."status" = 'NOT_CONNECTED'::"AttemptStatus"`,
    ];
    if (body.status === 'ARCHIVED') {
      conditions.push(Prisma.sql`customer."status" = 'ARCHIVED'::"CustomerStatus"`);
    } else if (body.status === 'ACTIVE') {
      conditions.push(Prisma.sql`customer."status" NOT IN ('ARCHIVED'::"CustomerStatus", 'SUPPRESSED'::"CustomerStatus")`);
    } else {
      conditions.push(Prisma.sql`customer."status" <> 'ARCHIVED'::"CustomerStatus"`);
    }
    if (body.batchId) {
      conditions.push(Prisma.sql`customer."batchId" = CAST(${body.batchId} AS UUID)`);
    }
    if (body.agentId) {
      conditions.push(Prisma.sql`latest_assignments."agentId" = CAST(${body.agentId} AS UUID)`);
    }
    if (body.search) {
      const searchConditions = [
        Prisma.sql`customer."name" ILIKE ${`%${body.search}%`}`,
        Prisma.sql`customer."notes" ILIKE ${`%${body.search}%`}`,
      ];
      if (/^\+?[\d\s()-]{7,}$/.test(body.search)) {
        try {
          const phoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(body.search));
          searchConditions.push(Prisma.sql`customer."phoneHash" = ${phoneHash}`);
        } catch {
          // Name and notes remain valid search inputs.
        }
      }
      conditions.push(Prisma.sql`(${Prisma.join(searchConditions, ' OR ')})`);
    }
    if (body.phone) {
      const phoneHash = this.crypto.hashPhone(this.crypto.normalizePhone(body.phone));
      conditions.push(Prisma.sql`customer."phoneHash" = ${phoneHash}`);
    }

    return this.prisma.$queryRaw<Array<{
      id: string;
      phoneHash: string;
      status: CustomerStatus;
    }>>(Prisma.sql`
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
      )
      SELECT
        customer."id",
        customer."phoneHash",
        customer."status"
      FROM "customers" AS customer
      INNER JOIN latest_assignments
        ON latest_assignments."customerId" = customer."id"
      INNER JOIN latest_attempts
        ON latest_attempts."assignmentId" = latest_assignments."id"
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY customer."createdAt" ASC, customer."id" ASC
    `);
  }

  private async assignmentTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      ) {
        throw new ConflictException({
          code: 'ASSIGNMENT_CONFLICT',
          detail: '客户分配状态已被其他操作修改，请刷新后重试',
        });
      }
      throw error;
    }
  }
}
