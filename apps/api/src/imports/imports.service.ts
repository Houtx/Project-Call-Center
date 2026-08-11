import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BatchStatus,
  CustomerStatus,
  ImportJobStatus,
  ImportMode,
  ImportRowStatus,
  Prisma,
} from '@prisma/client';
import { parse } from 'csv-parse/sync';
import * as ExcelJS from 'exceljs';
import { readSheet } from 'read-excel-file/node';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PhoneAttributionService } from '../common/phone-attribution.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerQueryDto } from '../customers/customers.dto';
import { DuplicateModeDto } from './imports.dto';

type Cell = string | number | boolean | Date | null | undefined;

interface ParsedImportRow {
  rowNumber: number;
  name?: string;
  phone?: string;
}

@Injectable()
export class ImportsService {
  private readonly headerAliases: Record<string, keyof Omit<ParsedImportRow, 'rowNumber'>> = {
    '姓名': 'name',
    '客户名称': 'name',
    name: 'name',
    '手机号': 'phone',
    '手机号码': 'phone',
    '联系号码': 'phone',
    '电话': 'phone',
    phone: 'phone',
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly phoneAttribution: PhoneAttributionService,
    private readonly audit: AuditService,
  ) {}

  async preview(file: Express.Multer.File | undefined, batchId: string, actorId: string) {
    if (!file) {
      throw new BadRequestException({ code: 'IMPORT_FILE_REQUIRED', detail: '请上传 CSV 或 Excel 文件' });
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new BadRequestException({ code: 'IMPORT_FILE_TOO_LARGE', detail: '导入文件不能超过 20MB' });
    }
    const batch = await this.requireActiveBatch(batchId);
    const parsed = await this.parseFile(file);
    if (!parsed.length) throw new BadRequestException({ code: 'IMPORT_EMPTY' });
    if (parsed.length > 100_000) {
      throw new BadRequestException({ code: 'IMPORT_TOO_MANY_ROWS', detail: '每次最多导入 100,000 行' });
    }

    const prepared = parsed.map((row) => this.prepareRow(row, batch.name));
    const hashes = prepared.flatMap((row) => row.phoneHash ? [row.phoneHash] : []);
    const [existing, suppressed] = await Promise.all([
      this.findCustomersByHashes(hashes),
      this.findSuppressionByHashes(hashes),
    ]);
    const existingByHash = new Map(existing.map((item) => [item.phoneHash, item.id]));
    const suppressedHashes = new Set(suppressed.map((item) => item.phoneHash));
    const seen = new Set<string>();

    const rows = prepared.map((row) => {
      let status: ImportRowStatus = row.status;
      let issues = row.issues;
      let customerId: string | undefined;
      if (row.phoneHash && status !== ImportRowStatus.INVALID) {
        customerId = existingByHash.get(row.phoneHash);
        if (suppressedHashes.has(row.phoneHash)) {
          status = ImportRowStatus.SUPPRESSED;
          issues = ['号码在拒呼名单中'];
        } else if (customerId || seen.has(row.phoneHash)) {
          status = ImportRowStatus.DUPLICATE;
          issues = [customerId ? '号码已存在' : '文件内号码重复'];
        } else {
          seen.add(row.phoneHash);
        }
      }
      return { ...row, status, issues, customerId };
    });

    const counts = this.countRows(rows);
    const job = await this.prisma.importJob.create({
      data: {
        batchId: batch.id,
        createdById: actorId,
        fileName: file.originalname.slice(0, 255),
        status: ImportJobStatus.PREVIEWED,
        totalRows: rows.length,
        newRows: counts.newCount,
        duplicateRows: counts.duplicateCount,
        invalidRows: counts.invalidCount,
        suppressedRows: counts.suppressedCount,
      },
    });
    for (let offset = 0; offset < rows.length; offset += 1000) {
      await this.prisma.importRow.createMany({
        data: rows.slice(offset, offset + 1000).map((row) => ({
          importJobId: job.id,
          rowNumber: row.rowNumber,
          status: row.status,
          phoneCiphertext: row.phoneCiphertext,
          phoneIv: row.phoneIv,
          phoneTag: row.phoneTag,
          phoneHash: row.phoneHash,
          phoneMasked: row.phoneMasked,
          name: row.name,
          batchName: row.batchName,
          province: row.province,
          city: row.city,
          carrier: row.carrier,
          notes: row.notes,
          tags: row.tags,
          issues: row.issues,
          createdCustomerId: row.customerId,
        })),
      });
    }
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_IMPORT_PREVIEWED',
      entityType: 'import_job',
      entityId: job.id,
      metadata: { batchId: batch.id, fileName: job.fileName, ...counts, total: rows.length },
    });
    return {
      importId: job.id,
      fileName: job.fileName,
      batchId: batch.id,
      batchName: batch.name,
      total: rows.length,
      ...counts,
      rows: rows.slice(0, 100).map((row) => ({
        rowNumber: row.rowNumber,
        name: row.name,
        phoneMasked: row.phoneMasked ?? '-',
        province: row.province,
        city: row.city,
        carrier: row.carrier,
        result: row.status,
        message: row.issues.join('；') || undefined,
      })),
    };
  }

  async commit(importId: string, duplicateMode: DuplicateModeDto, actorId: string) {
    const claimed = await this.prisma.importJob.updateMany({
      where: { id: importId, status: ImportJobStatus.PREVIEWED },
      data: {
        status: ImportJobStatus.PROCESSING,
        mode: duplicateMode === DuplicateModeDto.UPDATE
          ? ImportMode.UPDATE_EXISTING
          : ImportMode.SKIP_DUPLICATES,
        startedAt: new Date(),
      },
    });
    if (!claimed.count) {
      const exists = await this.prisma.importJob.findUnique({ where: { id: importId } });
      if (!exists) throw new NotFoundException({ code: 'IMPORT_NOT_FOUND' });
      throw new ConflictException({ code: 'IMPORT_ALREADY_COMMITTED', detail: '该导入任务已处理' });
    }

    try {
      const job = await this.prisma.importJob.findUnique({
        where: { id: importId },
        select: { batchId: true },
      });
      if (!job?.batchId) {
        throw new BadRequestException({
          code: 'IMPORT_BATCH_REQUIRED',
          detail: '导入任务未绑定批次，请重新预检',
        });
      }
      await this.requireActiveBatch(job.batchId);
      const rows = await this.prisma.importRow.findMany({
        where: { importJobId: importId },
        orderBy: { rowNumber: 'asc' },
      });
      const candidateHashes = [...new Set(rows.flatMap((row) => row.phoneHash ? [row.phoneHash] : []))];
      const suppressedHashes = new Set(
        (await this.findSuppressionByHashes(candidateHashes)).map((item) => item.phoneHash),
      );
      const suppressedRows = rows.filter((row) => row.phoneHash && suppressedHashes.has(row.phoneHash));
      for (let offset = 0; offset < suppressedRows.length; offset += 5000) {
        await this.prisma.importRow.updateMany({
          where: { id: { in: suppressedRows.slice(offset, offset + 5000).map((row) => row.id) } },
          data: { status: ImportRowStatus.SUPPRESSED, issues: ['提交时号码已进入拒呼名单'] },
        });
      }

      const seen = new Set<string>();
      const eligibleRows = rows.filter((row) => {
        if (!row.phoneHash || !row.phoneCiphertext || !row.phoneIv || !row.phoneTag || !row.phoneMasked) return false;
        if (suppressedHashes.has(row.phoneHash) || seen.has(row.phoneHash)) return false;
        seen.add(row.phoneHash);
        return row.status !== ImportRowStatus.INVALID && row.status !== ImportRowStatus.SUPPRESSED;
      });
      const existingByHash = new Map(
        (await this.findCustomersByHashes(eligibleRows.map((row) => row.phoneHash!)))
          .map((item) => [item.phoneHash, item.id]),
      );
      const rowsToCreate = eligibleRows.filter((row) => !existingByHash.has(row.phoneHash!));
      const rowsToUpdate = duplicateMode === DuplicateModeDto.UPDATE
        ? eligibleRows.filter((row) => existingByHash.has(row.phoneHash!))
        : [];

      let created = 0;
      let updated = 0;
      for (let offset = 0; offset < rowsToCreate.length; offset += 1000) {
        const chunk = rowsToCreate.slice(offset, offset + 1000);
        const result = await this.prisma.customer.createMany({
          data: chunk.map((row) => ({
            createdById: actorId,
            batchId: job.batchId!,
            name: row.name,
            phoneCiphertext: row.phoneCiphertext!,
            phoneIv: row.phoneIv!,
            phoneTag: row.phoneTag!,
            phoneHash: row.phoneHash!,
            phoneMasked: row.phoneMasked!,
            province: row.province,
            city: row.city,
            carrier: row.carrier,
            notes: row.notes,
            tags: row.tags,
            status: CustomerStatus.AVAILABLE,
          } satisfies Prisma.CustomerUncheckedCreateInput)),
          skipDuplicates: true,
        });
        created += result.count;
      }
      await this.linkImportedRows(importId, rowsToCreate.map((row) => row.id));

      for (let offset = 0; offset < rowsToUpdate.length; offset += 250) {
        const chunk = rowsToUpdate.slice(offset, offset + 250);
        await this.prisma.$transaction(chunk.flatMap((row) => {
          const customerId = existingByHash.get(row.phoneHash!)!;
          return [
            this.prisma.customer.update({
              where: { id: customerId },
              data: {
                name: row.name ?? undefined,
                batchId: job.batchId!,
                province: row.province ?? undefined,
                city: row.city ?? undefined,
                carrier: row.carrier ?? undefined,
                notes: row.notes ?? undefined,
                tags: row.tags.length ? row.tags : undefined,
                version: { increment: 1 },
              },
            }),
            this.prisma.importRow.update({
              where: { id: row.id },
              data: { status: ImportRowStatus.IMPORTED, createdCustomerId: customerId },
            }),
          ];
        }));
        updated += chunk.length;
      }
      const skipped = rows.length - created - updated;
      await this.prisma.importJob.update({
        where: { id: importId },
        data: {
          status: ImportJobStatus.COMPLETED,
          importedRows: created + updated,
          updateRows: updated,
          completedAt: new Date(),
        },
      });
      await this.audit.record({
        actorId,
        action: 'CUSTOMER_IMPORT_COMMITTED',
        entityType: 'import_job',
        entityId: importId,
        metadata: { batchId: job.batchId, created, updated, skipped, duplicateMode },
      });
      return { created, updated, skipped };
    } catch (error) {
      await this.prisma.importJob.update({
        where: { id: importId },
        data: {
          status: ImportJobStatus.FAILED,
          failureMessage: error instanceof Error ? error.message.slice(0, 2000) : '未知错误',
          completedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async createImportTemplate(actorId: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'SIM Call CRM';
    workbook.created = new Date();
    const worksheet = workbook.addWorksheet('客户导入');
    worksheet.columns = [
      { header: '姓名', key: 'name', width: 24 },
      { header: '手机号', key: 'phone', width: 22 },
    ];
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.autoFilter = 'A1:B1';
    const header = worksheet.getRow(1);
    header.height = 24;
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176B66' } };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getColumn('phone').numFmt = '@';

    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    await this.audit.record({
      actorId,
      action: 'CUSTOMER_IMPORT_TEMPLATE_DOWNLOADED',
      entityType: 'import_template',
      metadata: { format: 'xlsx', columns: ['姓名', '手机号'] },
    });
    return content;
  }

  async exportCustomers(query: CustomerQueryDto, actorId: string): Promise<Buffer> {
    const where: Prisma.CustomerWhereInput = {
      status: query.status === 'ARCHIVED'
        ? CustomerStatus.ARCHIVED
        : { not: CustomerStatus.ARCHIVED },
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.agentId ? { assignments: { some: { agentId: query.agentId, status: 'ACTIVE' } } } : {}),
    };
    const customers = await this.prisma.customer.findMany({
      where,
      take: 100_000,
      orderBy: { createdAt: 'desc' },
      include: { batch: true, assignments: { where: { status: 'ACTIVE' }, include: { agent: true } } },
    });
    const header = ['客户名称', '联系号码', '批次', '省份', '城市', '运营商', '标签', '备注', '分配坐席', '创建时间'];
    const lines = [header, ...customers.map((customer) => [
      customer.name ?? '',
      this.crypto.decryptPhone(customer),
      customer.batch?.name ?? '',
      customer.province ?? '',
      customer.city ?? '',
      customer.carrier ?? '',
      customer.tags.join('|'),
      customer.notes ?? '',
      customer.assignments[0]?.agent.displayName ?? '',
      customer.createdAt.toISOString(),
    ])].map((cells) => cells.map((value) => this.csvCell(value)).join(','));
    await this.audit.record({
      actorId,
      action: 'CUSTOMERS_EXPORTED',
      entityType: 'customer',
      metadata: { count: customers.length },
    });
    return Buffer.from(`\uFEFF${lines.join('\r\n')}`, 'utf8');
  }

  private async parseFile(file: Express.Multer.File): Promise<ParsedImportRow[]> {
    const extension = file.originalname.toLowerCase().split('.').pop();
    let matrix: Cell[][];
    if (extension === 'csv') {
      matrix = parse(file.buffer, { bom: true, skip_empty_lines: true, relax_column_count: true });
    } else if (extension === 'xlsx') {
      matrix = (await readSheet(file.buffer)).map((row) => row as Cell[]);
    } else {
      throw new BadRequestException({ code: 'IMPORT_FILE_TYPE', detail: '仅支持 .csv 和 .xlsx' });
    }
    if (matrix.length < 2) return [];
    const headers = matrix[0].map((cell) => this.headerAliases[this.cleanHeader(cell)]);
    if (
      headers.length !== 2 ||
      headers.some((header) => !header) ||
      new Set(headers).size !== 2 ||
      !headers.includes('name') ||
      !headers.includes('phone')
    ) {
      throw new BadRequestException({
        code: 'IMPORT_TEMPLATE_MISMATCH',
        detail: '导入文件必须且只能包含“姓名”和“手机号”两列，请使用系统提供的空模板',
      });
    }
    return matrix.slice(1).flatMap((cells, index) => {
      if (cells.every((cell) => String(cell ?? '').trim() === '')) return [];
      if (cells.slice(2).some((cell) => String(cell ?? '').trim() !== '')) {
        throw new BadRequestException({
          code: 'IMPORT_TEMPLATE_MISMATCH',
          detail: `第 ${index + 2} 行包含模板之外的列，请使用系统提供的空模板`,
        });
      }
      const row: ParsedImportRow = { rowNumber: index + 2 };
      headers.forEach((field, column) => {
        if (!field) return;
        const value = String(cells[column] ?? '').trim();
        row[field] = value || undefined;
      });
      return [row];
    });
  }

  private prepareRow(row: ParsedImportRow, batchName: string) {
    try {
      if (!row.name) throw new Error('姓名为空');
      if (row.name.length > 160) throw new Error('姓名不能超过 160 个字符');
      if (!row.phone) throw new Error('联系号码为空');
      const normalized = this.crypto.normalizePhone(row.phone);
      const attribution = this.phoneAttribution.lookup(normalized);
      return {
        ...row,
        batchName,
        province: attribution?.province,
        city: attribution?.city,
        carrier: attribution?.carrier,
        notes: undefined,
        tags: [] as string[],
        ...this.crypto.encryptPhone(normalized),
        phoneHash: this.crypto.hashPhone(normalized),
        phoneMasked: this.crypto.maskPhone(normalized),
        status: ImportRowStatus.NEW,
        issues: [] as string[],
      };
    } catch (error) {
      return {
        ...row,
        batchName,
        province: undefined,
        city: undefined,
        carrier: undefined,
        notes: undefined,
        tags: [] as string[],
        phoneCiphertext: undefined,
        phoneIv: undefined,
        phoneTag: undefined,
        phoneHash: undefined,
        phoneMasked: row.phone ? this.maskUnsafe(row.phone) : undefined,
        status: ImportRowStatus.INVALID,
        issues: [error instanceof Error ? error.message : '联系号码无效'],
      };
    }
  }

  private async findCustomersByHashes(hashes: string[]) {
    const items: { id: string; phoneHash: string }[] = [];
    for (let offset = 0; offset < hashes.length; offset += 5000) {
      items.push(...await this.prisma.customer.findMany({
        where: { phoneHash: { in: hashes.slice(offset, offset + 5000) } },
        select: { id: true, phoneHash: true },
      }));
    }
    return items;
  }

  private async findSuppressionByHashes(hashes: string[]) {
    const items: { phoneHash: string }[] = [];
    for (let offset = 0; offset < hashes.length; offset += 5000) {
      items.push(...await this.prisma.suppressionEntry.findMany({
        where: { phoneHash: { in: hashes.slice(offset, offset + 5000) }, revokedAt: null },
        select: { phoneHash: true },
      }));
    }
    return items;
  }

  private async linkImportedRows(importId: string, rowIds: string[]): Promise<void> {
    for (let offset = 0; offset < rowIds.length; offset += 5000) {
      const ids = rowIds.slice(offset, offset + 5000);
      if (!ids.length) continue;
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "import_rows" AS r
        SET
          "status" = ${ImportRowStatus.IMPORTED}::"ImportRowStatus",
          "createdCustomerId" = c."id"
        FROM "customers" AS c
        WHERE r."importJobId" = ${importId}::uuid
          AND r."phoneHash" = c."phoneHash"
          AND r."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      `);
    }
  }

  private countRows(rows: { status: ImportRowStatus }[]) {
    const count = (status: ImportRowStatus) => rows.filter((row) => row.status === status).length;
    return {
      newCount: count(ImportRowStatus.NEW),
      duplicateCount: count(ImportRowStatus.DUPLICATE),
      invalidCount: count(ImportRowStatus.INVALID),
      suppressedCount: count(ImportRowStatus.SUPPRESSED),
    };
  }

  private async requireActiveBatch(batchId: string) {
    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, status: BatchStatus.ACTIVE },
      select: { id: true, name: true, code: true },
    });
    if (!batch) {
      throw new BadRequestException({
        code: 'IMPORT_BATCH_NOT_FOUND',
        detail: '所选批次不存在或已停用，请重新选择',
      });
    }
    return batch;
  }

  private cleanHeader(value: Cell): string {
    return this.scalarText(value).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s_-]/g, '');
  }

  private maskUnsafe(value: string): string {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : '****';
  }

  private csvCell(value: unknown): string {
    let text = this.scalarText(value);
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }

  private scalarText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return JSON.stringify(value);
  }
}
