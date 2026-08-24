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
import * as XLSX from '@e965/xlsx';
import * as ExcelJS from 'exceljs';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { readSheet } from 'read-excel-file/node';
import { SaxesParser, SaxesTagPlain } from 'saxes';
import { File as ZipEntry, Open as ZipArchive } from 'unzipper-esm';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { PhoneAttributionService } from '../common/phone-attribution.service';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerQueryDto } from '../customers/customers.dto';
import { DuplicateModeDto } from './imports.dto';

type Cell = string | number | boolean | Date | null | undefined;

const MEBIBYTE = 1024 * 1024;
const MAX_XLSX_ARCHIVE_ENTRIES = 512;

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

  async preview(
    file: Express.Multer.File | undefined,
    batchId: string,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 'IMPORT_FILE_REQUIRED', detail: '请上传 CSV 或 Excel 文件' });
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new BadRequestException({ code: 'IMPORT_FILE_TOO_LARGE', detail: '导入文件不能超过 20MB' });
    }
    const batch = await this.requireActiveBatch(batchId, client);
    const parsed = await this.parseFile(file);
    if (!parsed.length) throw new BadRequestException({ code: 'IMPORT_EMPTY' });
    const maxRows = this.importMaxRows();
    if (parsed.length > maxRows) {
      throw new BadRequestException({
        code: 'IMPORT_TOO_MANY_ROWS',
        detail: `当前服务器每次最多导入 ${maxRows.toLocaleString('zh-CN')} 行`,
      });
    }

    const prepared = parsed.map((row) => this.prepareRow(row, batch.name));
    const hashes = prepared.flatMap((row) => row.phoneHash ? [row.phoneHash] : []);
    const [existing, suppressed] = await Promise.all([
      this.findCustomersByHashes(hashes, client),
      this.findSuppressionByHashes(hashes, client),
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
    const job = await client.importJob.create({
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
      await client.importRow.createMany({
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
    }, client);
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

  async commit(
    importId: string,
    duplicateMode: DuplicateModeDto,
    actorId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const claimed = await client.importJob.updateMany({
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
      const exists = await client.importJob.findUnique({ where: { id: importId } });
      if (!exists) throw new NotFoundException({ code: 'IMPORT_NOT_FOUND' });
      throw new ConflictException({ code: 'IMPORT_ALREADY_COMMITTED', detail: '该导入任务已处理' });
    }

    try {
      const job = await client.importJob.findUnique({
        where: { id: importId },
        select: { batchId: true },
      });
      if (!job?.batchId) {
        throw new BadRequestException({
          code: 'IMPORT_BATCH_REQUIRED',
          detail: '导入任务未绑定批次，请重新预检',
        });
      }
      await this.requireActiveBatch(job.batchId, client);
      const rows = await client.importRow.findMany({
        where: { importJobId: importId },
        orderBy: { rowNumber: 'asc' },
      });
      const candidateHashes = [...new Set(rows.flatMap((row) => row.phoneHash ? [row.phoneHash] : []))];
      const suppressedHashes = new Set(
        (await this.findSuppressionByHashes(candidateHashes, client)).map((item) => item.phoneHash),
      );
      const suppressedRows = rows.filter((row) => row.phoneHash && suppressedHashes.has(row.phoneHash));
      for (let offset = 0; offset < suppressedRows.length; offset += 5000) {
        await client.importRow.updateMany({
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
        (await this.findCustomersByHashes(eligibleRows.map((row) => row.phoneHash!), client))
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
        const result = await client.customer.createMany({
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
      await this.linkImportedRows(importId, rowsToCreate.map((row) => row.id), client);

      for (let offset = 0; offset < rowsToUpdate.length; offset += 250) {
        const chunk = rowsToUpdate.slice(offset, offset + 250);
        await Promise.all(chunk.flatMap((row) => {
          const customerId = existingByHash.get(row.phoneHash!)!;
          return [
            client.customer.update({
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
            client.importRow.update({
              where: { id: row.id },
              data: { status: ImportRowStatus.IMPORTED, createdCustomerId: customerId },
            }),
          ];
        }));
        updated += chunk.length;
      }
      const skipped = rows.length - created - updated;
      await client.importJob.update({
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
      }, client);
      return { created, updated, skipped };
    } catch (error) {
      await client.importJob.update({
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

  exportCustomers(query: CustomerQueryDto, actorId: string): Readable {
    const where: Prisma.CustomerWhereInput = {
      status: query.status === 'ARCHIVED'
        ? CustomerStatus.ARCHIVED
        : { not: CustomerStatus.ARCHIVED },
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(query.agentId ? { assignments: { some: { agentId: query.agentId, status: 'ACTIVE' } } } : {}),
    };
    return Readable.from(this.streamCustomerRows(where, actorId));
  }

  private async *streamCustomerRows(where: Prisma.CustomerWhereInput, actorId: string) {
    const pageSize = 500;
    const maximumRows = 100_000;
    let exported = 0;
    let cursor: { createdAt: Date; id: string } | undefined;
    await this.audit.record({
      actorId,
      action: 'CUSTOMERS_EXPORTED',
      entityType: 'customer',
      metadata: { maximumRows, streamed: true },
    });
    const header = [
      '客户名称',
      '联系号码',
      '批次',
      '省份',
      '城市',
      '运营商',
      '标签',
      '备注',
      '分配坐席',
      '创建时间',
    ];
    yield `\uFEFF${header.map((value) => this.csvCell(value)).join(',')}\r\n`;

    while (exported < maximumRows) {
      const customers = await this.prisma.customer.findMany({
          where: cursor
            ? {
                AND: [
                  where,
                  {
                    OR: [
                      { createdAt: { lt: cursor.createdAt } },
                      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                    ],
                  },
                ],
              }
            : where,
          take: Math.min(pageSize, maximumRows - exported),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            batch: true,
            assignments: { where: { status: 'ACTIVE' }, include: { agent: true } },
          },
        });
      if (!customers.length) break;
      for (const customer of customers) {
        yield `${[
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
        ].map((value) => this.csvCell(value)).join(',')}\r\n`;
      }
      exported += customers.length;
      const last = customers.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
      if (customers.length < pageSize) break;
    }
  }

  private async parseFile(file: Express.Multer.File): Promise<ParsedImportRow[]> {
    const extension = file.originalname.toLowerCase().split('.').pop();
    const maxRows = this.importMaxRows();
    if (extension === 'csv') {
      const matrix: Cell[][] = parse(file.buffer, {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: true,
        to: maxRows + 2,
      });
      return this.parseMatrix(matrix, maxRows);
    }
    if (extension === 'xlsx') {
      try {
        await this.assertXlsxWithinLimit(file.buffer, maxRows);
        const matrix = (await readSheet(file.buffer)).map((row) => row as Cell[]);
        return this.parseMatrix(matrix, maxRows);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException({
          code: 'IMPORT_FILE_INVALID',
          detail: 'Excel 文件损坏或格式不受支持，请使用系统提供的空模板',
        });
      }
    }
    if (extension === 'xls') {
      try {
        const workbook = XLSX.read(file.buffer, {
          type: 'buffer',
          dense: true,
          cellDates: true,
          cellFormula: false,
          cellHTML: false,
          bookVBA: false,
          WTF: false,
        });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) return [];
        const worksheet = workbook.Sheets[firstSheetName];
        const matrix = XLSX.utils.sheet_to_json<Cell[]>(worksheet, {
          header: 1,
          raw: true,
          defval: null,
          blankrows: false,
        });
        return this.parseMatrix(matrix, maxRows);
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new BadRequestException({
          code: 'IMPORT_FILE_INVALID',
          detail: '旧版 Excel 文件损坏、已加密或格式不受支持',
        });
      }
    }
    throw new BadRequestException({ code: 'IMPORT_FILE_TYPE', detail: '仅支持 .csv、.xlsx 和 .xls' });
  }

  private parseMatrix(matrix: Cell[][], maxRows: number): ParsedImportRow[] {
    if (!matrix.length) return [];
    const headers = this.validateHeaders(matrix[0]);
    const rows: ParsedImportRow[] = [];
    matrix.slice(1).forEach((cells, index) => {
      const row = this.parseDataCells(cells, index + 2, headers);
      if (!row) return;
      rows.push(row);
      this.assertImportRowLimit(rows.length, maxRows);
    });
    return rows;
  }

  private async assertXlsxWithinLimit(buffer: Buffer, maxRows: number): Promise<void> {
    const archive = await ZipArchive.buffer(buffer);
    if (archive.files.length > MAX_XLSX_ARCHIVE_ENTRIES) {
      throw new BadRequestException({
        code: 'IMPORT_FILE_TOO_COMPLEX',
        detail: 'Excel 文件包含过多内部文件，请使用系统提供的空模板',
      });
    }

    const workbookEntry = this.requireXlsxEntry(archive.files, 'xl/workbook.xml', MEBIBYTE);
    const relationsEntry = this.requireXlsxEntry(
      archive.files,
      'xl/_rels/workbook.xml.rels',
      MEBIBYTE,
    );
    const relationshipId = this.firstWorksheetRelationshipId(
      await this.readXlsxEntry(workbookEntry, MEBIBYTE),
    );
    const worksheetPath = this.worksheetPathFromRelations(
      await this.readXlsxEntry(relationsEntry, MEBIBYTE),
      relationshipId,
    );
    const maximumWorksheetBytes = Math.min(
      256 * MEBIBYTE,
      Math.max(8 * MEBIBYTE, maxRows * 2048),
    );
    const worksheetEntry = this.requireXlsxEntry(
      archive.files,
      worksheetPath,
      maximumWorksheetBytes,
    );
    const sharedStrings = archive.files.find((entry) => entry.path === 'xl/sharedStrings.xml');
    if (sharedStrings) {
      const maximumSharedStringBytes = Math.min(
        128 * MEBIBYTE,
        Math.max(8 * MEBIBYTE, maxRows * 1024),
      );
      await this.consumeXlsxEntry(sharedStrings, maximumSharedStringBytes);
    }
    const styles = archive.files.find((entry) => entry.path === 'xl/styles.xml');
    if (styles) await this.consumeXlsxEntry(styles, 4 * MEBIBYTE);

    let rowCount = 0;
    let limitExceeded = false;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', (tag) => {
      if (this.xmlLocalName(tag.name) !== 'row') return;
      rowCount += 1;
      if (rowCount > maxRows + 1) limitExceeded = true;
    });
    const stream = worksheetEntry.stream();
    let bytesRead = 0;
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      bytesRead += chunk.length;
      if (bytesRead > maximumWorksheetBytes) {
        throw new BadRequestException({
          code: 'IMPORT_FILE_TOO_COMPLEX',
          detail: 'Excel 工作表解压后过大，请拆分文件后导入',
        });
      }
      parser.write(chunk.toString('utf8'));
      if (limitExceeded) break;
    }
    if (limitExceeded) this.assertImportRowLimit(maxRows + 1, maxRows);
    parser.close();
  }

  private requireXlsxEntry(entries: ZipEntry[], path: string, maximumBytes: number): ZipEntry {
    const entry = entries.find((candidate) => candidate.path === path);
    if (!entry) throw new Error(`Missing XLSX entry: ${path}`);
    this.assertXlsxEntrySize(entry, maximumBytes);
    return entry;
  }

  private assertXlsxEntrySize(entry: ZipEntry, maximumBytes: number): void {
    if (entry.uncompressedSize <= maximumBytes) return;
    throw new BadRequestException({
      code: 'IMPORT_FILE_TOO_COMPLEX',
      detail: 'Excel 内容解压后过大，请拆分文件后导入',
    });
  }

  private async readXlsxEntry(entry: ZipEntry, maximumBytes: number): Promise<Buffer> {
    this.assertXlsxEntrySize(entry, maximumBytes);
    const chunks: Buffer[] = [];
    let bytesRead = 0;
    for await (const chunk of entry.stream() as AsyncIterable<Buffer>) {
      bytesRead += chunk.length;
      if (bytesRead > maximumBytes) this.throwXlsxEntryTooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytesRead);
  }

  private async consumeXlsxEntry(entry: ZipEntry, maximumBytes: number): Promise<void> {
    this.assertXlsxEntrySize(entry, maximumBytes);
    let bytesRead = 0;
    for await (const chunk of entry.stream() as AsyncIterable<Buffer>) {
      bytesRead += chunk.length;
      if (bytesRead > maximumBytes) this.throwXlsxEntryTooLarge();
    }
  }

  private throwXlsxEntryTooLarge(): never {
    throw new BadRequestException({
      code: 'IMPORT_FILE_TOO_COMPLEX',
      detail: 'Excel 内容解压后过大，请拆分文件后导入',
    });
  }

  private firstWorksheetRelationshipId(xml: Buffer): string {
    let relationshipId: string | undefined;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', (tag) => {
      if (relationshipId || this.xmlLocalName(tag.name) !== 'sheet') return;
      relationshipId = this.xmlAttribute(tag, 'r:id');
    });
    parser.write(xml.toString('utf8')).close();
    if (!relationshipId) throw new Error('XLSX workbook has no worksheet');
    return relationshipId;
  }

  private worksheetPathFromRelations(xml: Buffer, relationshipId: string): string {
    let target: string | undefined;
    const parser = new SaxesParser({ xmlns: false });
    parser.on('opentag', (tag) => {
      if (
        target ||
        this.xmlLocalName(tag.name) !== 'Relationship' ||
        this.xmlAttribute(tag, 'Id') !== relationshipId
      ) return;
      target = this.xmlAttribute(tag, 'Target');
    });
    parser.write(xml.toString('utf8')).close();
    if (!target) throw new Error('XLSX worksheet relationship is missing');
    const normalized = target.startsWith('/')
      ? posix.normalize(target.slice(1))
      : posix.normalize(posix.join('xl', target));
    if (!normalized.startsWith('xl/worksheets/')) {
      throw new Error('XLSX worksheet relationship is invalid');
    }
    return normalized;
  }

  private xmlAttribute(tag: SaxesTagPlain, name: string): string | undefined {
    return tag.attributes[name];
  }

  private xmlLocalName(name: string): string {
    return name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  }

  private validateHeaders(cells: Cell[]): (keyof Omit<ParsedImportRow, 'rowNumber'>)[] {
    const lastPopulatedColumn = cells.reduce<number>(
      (last, cell, index) => String(cell ?? '').trim() ? index + 1 : last,
      0,
    );
    const headers = cells
      .slice(0, lastPopulatedColumn)
      .map((cell) => this.headerAliases[this.cleanHeader(cell)]);
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
    return headers;
  }

  private parseDataCells(
    cells: Cell[],
    rowNumber: number,
    headers: (keyof Omit<ParsedImportRow, 'rowNumber'>)[],
  ): ParsedImportRow | undefined {
    if (cells.every((cell) => String(cell ?? '').trim() === '')) return undefined;
    if (cells.slice(2).some((cell) => String(cell ?? '').trim() !== '')) {
      throw new BadRequestException({
        code: 'IMPORT_TEMPLATE_MISMATCH',
        detail: `第 ${rowNumber} 行包含模板之外的列，请使用系统提供的空模板`,
      });
    }
    const row: ParsedImportRow = { rowNumber };
    headers.forEach((field, column) => {
      const value = String(cells[column] ?? '').trim();
      row[field] = value || undefined;
    });
    return row;
  }

  private assertImportRowLimit(rowCount: number, maxRows: number): void {
    if (rowCount <= maxRows) return;
    throw new BadRequestException({
      code: 'IMPORT_TOO_MANY_ROWS',
      detail: `当前服务器每次最多导入 ${maxRows.toLocaleString('zh-CN')} 行`,
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

  private async findCustomersByHashes(
    hashes: string[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const items: { id: string; phoneHash: string }[] = [];
    for (let offset = 0; offset < hashes.length; offset += 5000) {
      items.push(...await client.customer.findMany({
        where: { phoneHash: { in: hashes.slice(offset, offset + 5000) } },
        select: { id: true, phoneHash: true },
      }));
    }
    return items;
  }

  private async findSuppressionByHashes(
    hashes: string[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const items: { phoneHash: string }[] = [];
    for (let offset = 0; offset < hashes.length; offset += 5000) {
      items.push(...await client.suppressionEntry.findMany({
        where: { phoneHash: { in: hashes.slice(offset, offset + 5000) }, revokedAt: null },
        select: { phoneHash: true },
      }));
    }
    return items;
  }

  private async linkImportedRows(
    importId: string,
    rowIds: string[],
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    for (let offset = 0; offset < rowIds.length; offset += 5000) {
      const ids = rowIds.slice(offset, offset + 5000);
      if (!ids.length) continue;
      await client.$executeRaw(Prisma.sql`
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

  private async requireActiveBatch(
    batchId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const batch = await client.batch.findFirst({
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

  private importMaxRows(): number {
    const parsed = Number(process.env.IMPORT_MAX_ROWS);
    return Number.isSafeInteger(parsed) && parsed > 0
      ? Math.min(parsed, 100_000)
      : 100_000;
  }
}
