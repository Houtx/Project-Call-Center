import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssignmentStatus,
  CustomerStatus,
  Prisma,
  SuppressionSource,
} from '@prisma/client';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { AddSuppressionDto, SuppressionQueryDto } from './suppression.dto';

@Injectable()
export class SuppressionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async list(query: SuppressionQueryDto) {
    const where: Prisma.SuppressionEntryWhereInput = {
      revokedAt: null,
      ...(query.search
        ? {
            OR: [
              { phoneMasked: { contains: query.search } },
              { reason: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.suppressionEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          phoneMasked: true,
          reason: true,
          source: true,
          createdAt: true,
          createdBy: { select: { displayName: true } },
        },
      }),
      this.prisma.suppressionEntry.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        reason: item.reason ?? '',
        withdrawnAssignments: 0,
        createdBy: item.createdBy?.displayName ?? '系统',
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async add(
    body: AddSuppressionDto,
    actorId: string,
    client?: Prisma.TransactionClient,
  ) {
    const normalized = this.crypto.normalizePhone(body.phone);
    const phoneHash = this.crypto.hashPhone(normalized);
    const encrypted = this.crypto.encryptPhone(normalized);
    const now = new Date();

    const operation = async (tx: Prisma.TransactionClient) => {
        const current = await tx.suppressionEntry.findFirst({
          where: { phoneHash, revokedAt: null },
        });
        if (current) {
          throw new ConflictException({
            code: 'PHONE_ALREADY_SUPPRESSED',
            detail: '该号码已在拒呼名单中',
          });
        }
        const entry = await tx.suppressionEntry.create({
          data: {
            ...encrypted,
            phoneHash,
            phoneMasked: this.crypto.maskPhone(normalized),
            reason: body.reason,
            source: body.source === 'IMPORT'
              ? SuppressionSource.IMPORT
              : body.source === 'MANUAL' || !body.source
                ? SuppressionSource.MANUAL
                : SuppressionSource.COMPLIANCE,
            createdById: actorId,
          } satisfies Prisma.SuppressionEntryUncheckedCreateInput,
          select: {
            id: true,
            phoneMasked: true,
            reason: true,
            source: true,
            createdAt: true,
            createdBy: { select: { displayName: true } },
          },
        });
        const customers = await tx.customer.findMany({
          where: { phoneHash, status: { not: CustomerStatus.ARCHIVED } },
          include: {
            assignments: { where: { status: AssignmentStatus.ACTIVE } },
          },
        });
        for (const customer of customers) {
          await tx.customer.update({
            where: { id: customer.id },
            data: {
              status: CustomerStatus.SUPPRESSED,
              suppressionPreviousStatus: customer.status,
            },
          });
          for (const assignment of customer.assignments) {
            await tx.assignment.update({
              where: { id: assignment.id },
              data: {
                status: AssignmentStatus.SUPPRESSED,
                endedAt: now,
                endedById: actorId,
                endReason: body.reason ?? '加入拒呼名单',
              },
            });
            await tx.syncChange.create({
              data: {
                targetUserId: assignment.agentId,
                entityType: 'ASSIGNMENT',
                entityId: assignment.id,
                operation: 'REMOVE',
                payload: {
                  assignmentId: assignment.id,
                  reason: 'SUPPRESSED',
                },
              },
            });
          }
        }
        const result = {
          entry,
          withdrawnAssignments: customers.reduce(
            (sum, customer) => sum + customer.assignments.length,
            0,
          ),
        };
        await this.audit.record({
          actorId,
          action: 'SUPPRESSION_ADDED',
          entityType: 'suppression_entry',
          entityId: result.entry.id,
          metadata: {
            phone: result.entry.phoneMasked,
            withdrawnAssignments: result.withdrawnAssignments,
          },
        }, tx);
        return result;
      };
    const result = client
      ? await operation(client)
      : await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
    return {
      ...result.entry,
      reason: result.entry.reason ?? '',
      source: body.source ?? result.entry.source,
      withdrawnAssignments: result.withdrawnAssignments,
      createdBy: result.entry.createdBy?.displayName ?? '系统',
    };
  }

  async revoke(
    id: string,
    actorId: string,
    client?: Prisma.TransactionClient,
  ): Promise<void> {
    const now = new Date();
    const operation = async (tx: Prisma.TransactionClient) => {
      const current = await tx.suppressionEntry.findFirst({
        where: { id, revokedAt: null },
      });
      if (!current) throw new NotFoundException({ code: 'SUPPRESSION_NOT_FOUND' });
      await tx.suppressionEntry.update({
        where: { id },
        data: { revokedAt: now, revokedById: actorId },
      });
      const customers = await tx.customer.findMany({
        where: { phoneHash: current.phoneHash, status: CustomerStatus.SUPPRESSED },
        select: { id: true, suppressionPreviousStatus: true },
      });
      for (const customer of customers) {
        await tx.customer.update({
          where: { id: customer.id },
          data: {
            status: customer.suppressionPreviousStatus === CustomerStatus.COMPLETED
              ? CustomerStatus.COMPLETED
              : CustomerStatus.AVAILABLE,
            suppressionPreviousStatus: null,
          },
        });
      }
      await this.audit.record({
        actorId,
        action: 'SUPPRESSION_REVOKED',
        entityType: 'suppression_entry',
        entityId: id,
        metadata: { phone: current.phoneMasked },
      }, tx);
      return current;
    };
    if (client) await operation(client);
    else await this.prisma.$transaction(operation);
  }
}
