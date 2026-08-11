import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const response = ctx.getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = 'Internal Server Error';
    let detail = '服务器无法完成请求';
    let code = 'INTERNAL_ERROR';
    let errors: unknown;

    if (error instanceof HttpException) {
      status = error.getStatus();
      title = HttpStatus[status]?.replaceAll('_', ' ') ?? 'Request Error';
      const body = error.getResponse();
      if (typeof body === 'string') detail = body;
      else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        const candidate = record.detail ?? record.message;
        detail = typeof candidate === 'string'
          ? candidate
          : Array.isArray(candidate)
            ? candidate.map(String).join('; ')
            : detail;
        code = typeof record.code === 'string' ? record.code : `HTTP_${status}`;
        if (Array.isArray(record.message)) errors = record.message;
      }
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        title = 'Conflict';
        code = 'UNIQUE_CONSTRAINT';
        detail = '该记录已存在';
      }
    }

    if (Number(status) >= 500) {
      this.logger.error(error instanceof Error ? error.stack : String(error));
    }

    response.status(status).type('application/problem+json').json({
      type: `https://call-center.local/problems/${code.toLowerCase()}`,
      title,
      status,
      detail,
      instance: request.originalUrl,
      code,
      requestId: request.requestId,
      ...(errors ? { errors } : {}),
    });
  }
}
