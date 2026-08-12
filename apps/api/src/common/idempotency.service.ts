import {
  ConflictException,
  Injectable,
  PreconditionFailedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  requireKey(key?: string): string {
    if (!key || key.length < 8 || key.length > 200) {
      throw new PreconditionFailedException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        detail: '写入请求必须携带有效的 Idempotency-Key',
      });
    }
    return key;
  }

  async execute<T>(
    subjectId: string,
    scope: string,
    key: string | undefined,
    payload: unknown,
    operation: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const resolvedKey = this.requireKey(key);
    const requestHash = createHash('sha256')
      .update(this.stableJson(payload))
      .digest('hex');
    const where = { actorId: subjectId, scope, key: resolvedKey };
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.idempotencyRecord.findFirst({ where });
        if (existing) return this.replay<T>(existing, requestHash);

        await tx.idempotencyRecord.create({
          data: {
            ...where,
            requestHash,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        const result = await operation(tx);
        await tx.idempotencyRecord.update({
          where: { actorId_scope_key: where },
          data: {
            responseBody: JSON.parse(JSON.stringify(result ?? { ok: true })),
            responseCode: 200,
            status: 'COMPLETED',
          },
        });
        return result;
        }, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 10 * 60 * 1000,
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          if (error.code === 'P2002') {
            const concurrent = await this.prisma.idempotencyRecord.findFirst({ where });
            if (concurrent) return this.replay<T>(concurrent, requestHash);
          }
          if (error.code === 'P2034') {
            if (attempt < MAX_TRANSACTION_ATTEMPTS) continue;
            throw new ConflictException({
              code: 'CONCURRENT_WRITE_CONFLICT',
              detail: '数据正被其他请求修改，请稍后重试',
            });
          }
        }
        throw error;
      }
    }
    throw new ConflictException({ code: 'CONCURRENT_WRITE_CONFLICT' });
  }

  private replay<T>(
    record: { requestHash: string; responseBody: unknown },
    requestHash: string,
  ): T {
    if (record.requestHash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        detail: '同一幂等键不能用于不同请求',
      });
    }
    if (record.responseBody === null) {
      throw new ConflictException({
        code: 'REQUEST_IN_PROGRESS',
        detail: '同一请求正在处理中',
      });
    }
    return record.responseBody as T;
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }
}

const MAX_TRANSACTION_ATTEMPTS = 3;
