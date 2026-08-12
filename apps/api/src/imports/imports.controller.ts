import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import type { RequestWithPrincipal } from '../common/contracts';
import { Roles } from '../common/contracts';
import { IdempotencyService } from '../common/idempotency.service';
import { CustomerQueryDto } from '../customers/customers.dto';
import { CommitImportDto, PreviewImportDto } from './imports.dto';
import { ImportsService } from './imports.service';

@ApiTags('customer import and export')
@ApiBearerAuth()
@Roles(Role.ADMIN)
@Controller('customers')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('import/preview')
  @ApiConsumes('multipart/form-data')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: PreviewImportDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.import.preview',
      key,
      {
        batchId: body.batchId,
        fileName: file?.originalname,
        size: file?.size,
        hash: file ? createFileHash(file.buffer) : null,
      },
      (tx) => this.imports.preview(file, body.batchId, request.user.sub, tx),
    );
  }

  @Post('import/commit')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  commit(
    @Body() body: CommitImportDto,
    @Headers('idempotency-key') key: string | undefined,
    @Req() request: RequestWithPrincipal,
  ) {
    return this.idempotency.execute(
      request.user.sub,
      'customers.import.commit',
      key,
      body,
      (tx) => this.imports.commit(body.importId, body.duplicateMode, request.user.sub, tx),
    );
  }

  @Get('import/template')
  async importTemplate(
    @Req() request: RequestWithPrincipal,
    @Res() response: Response,
  ): Promise<void> {
    const content = await this.imports.createImportTemplate(request.user.sub);
    response.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="customer-import-template.xlsx"; filename*=UTF-8''${encodeURIComponent('客户导入空模板.xlsx')}`,
    );
    response.send(content);
  }

  @Get('export')
  async export(
    @Query() query: CustomerQueryDto,
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) response: Response,
  ) {
    const content = await this.imports.exportCustomers(query, request.user.sub);
    response.type('text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="customers-${Date.now()}.csv"`);
    return content;
  }
}

function createFileHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
