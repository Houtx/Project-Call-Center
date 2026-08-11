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
    operation: () => Promise<T>,
  ): Promise<T> {
    const resolvedKey = this.requireKey(key);
    const requestHash = createHash('sha256')
      .update(this.stableJson(payload))
      .digest('hex');
    const where = { actorId: subjectId, scope, key: resolvedKey };
    const existing = await this.prisma.idempotencyRecord.findFirst({ where });
    if (existing) return this.replay<T>(existing, requestHash);

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          ...where,
          requestHash,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const concurrent = await this.prisma.idempotencyRecord.findFirstOrThrow({ where });
        return this.replay<T>(concurrent, requestHash);
      }
      throw error;
    }

    try {
      const result = await operation();
      await this.prisma.idempotencyRecord.updateMany({
        where,
        data: {
          responseBody: JSON.parse(JSON.stringify(result ?? { ok: true })),
          responseCode: 200,
          status: 'COMPLETED',
        },
      });
      return result;
    } catch (error) {
      await this.prisma.idempotencyRecord.deleteMany({
        where: { ...where, responseBody: { equals: Prisma.DbNull } },
      });
      throw error;
    }
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
