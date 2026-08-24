import * as ExcelJS from 'exceljs';
import * as XLSX from '@e965/xlsx';
import { DuplicateModeDto } from './imports.dto';
import { ImportsService } from './imports.service';

describe('ImportsService file parsing', () => {
  const service = new ImportsService({} as any, {} as any, {} as any, {} as any);

  it('maps Chinese CSV headers', async () => {
    const rows = await (service as any).parseFile({
      originalname: 'customers.csv',
      buffer: Buffer.from('\uFEFF姓名,手机号\n张三,13800000001\n'),
    });
    expect(rows).toEqual([expect.objectContaining({
      rowNumber: 2,
      name: '张三',
      phone: '13800000001',
    })]);
  });

  it('rejects legacy files that contain columns outside the two-column template', async () => {
    await expect((service as any).parseFile({
      originalname: 'customers.csv',
      buffer: Buffer.from('\uFEFF姓名,手机号,批次\n张三,13800000001,八月批次\n'),
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'IMPORT_TEMPLATE_MISMATCH' }),
    });
  });

  it('reads the first Excel sheet', async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Customers');
    worksheet.addRows([
      ['name', 'phone'],
      ['Li', '13800000002'],
    ]);
    const buffer = await workbook.xlsx.writeBuffer();
    const rows = await (service as any).parseFile({
      originalname: 'customers.xlsx',
      buffer: Buffer.from(buffer),
    });
    expect(rows[0]).toMatchObject({ name: 'Li', phone: '13800000002' });
  });

  it('reads a legacy binary Excel sheet', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['姓名', '手机号'],
        ['张三', 13800000003],
      ]),
      '客户',
    );
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
    const rows = await (service as any).parseFile({
      originalname: 'customers.xls',
      buffer,
    });
    expect(rows).toEqual([expect.objectContaining({
      rowNumber: 2,
      name: '张三',
      phone: '13800000003',
    })]);
  });

  it.each([
    ['CSV', 'customers.csv', async () => Buffer.from('姓名,手机号\n甲,13800000001\n乙,13800000002\n丙,13800000003\n')],
    ['Excel', 'customers.xlsx', async () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet('Customers').addRows([
        ['姓名', '手机号'],
        ['甲', '13800000001'],
        ['乙', '13800000002'],
        ['丙', '13800000003'],
      ]);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    }],
    ['legacy Excel', 'customers.xls', async () => {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
        ['姓名', '手机号'],
        ['甲', 13800000001],
        ['乙', 13800000002],
        ['丙', 13800000003],
      ]), 'Customers');
      return XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
    }],
  ])('stops oversized %s imports at the configured row limit', async (_type, originalname, createBuffer) => {
    const previous = process.env.IMPORT_MAX_ROWS;
    process.env.IMPORT_MAX_ROWS = '2';
    try {
      await expect((service as any).parseFile({
        originalname,
        buffer: await createBuffer(),
      })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'IMPORT_TOO_MANY_ROWS' }),
      });
    } finally {
      if (previous === undefined) delete process.env.IMPORT_MAX_ROWS;
      else process.env.IMPORT_MAX_ROWS = previous;
    }
  });

  it('fills attribution fields from the phone number', () => {
    const crypto = {
      normalizePhone: jest.fn(() => '+8613800000003'),
      encryptPhone: jest.fn(() => ({ phoneCiphertext: [1], phoneIv: [2], phoneTag: [3] })),
      hashPhone: jest.fn(() => 'phone-hash'),
      maskPhone: jest.fn(() => '138****0003'),
    };
    const attribution = {
      lookup: jest.fn(() => ({ province: '江苏', city: '徐州', carrier: '中国移动' })),
    };
    const importService = new ImportsService({} as any, crypto as any, attribution as any, {} as any);

    const inferred = (importService as any).prepareRow({
      rowNumber: 2,
      name: '张三',
      phone: '13800000003',
    }, '八月批次');

    expect(inferred).toMatchObject({
      batchName: '八月批次',
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
      tags: [],
    });
    expect(attribution.lookup).toHaveBeenCalledTimes(1);
  });

  it('marks rows without a customer name as invalid', () => {
    const importService = new ImportsService({} as any, {} as any, {} as any, {} as any);
    expect((importService as any).prepareRow({
      rowNumber: 2,
      phone: '13800000003',
    }, '八月批次')).toMatchObject({
      status: 'INVALID',
      issues: ['姓名为空'],
    });
  });

  it('creates an empty Excel template with only name and phone columns', async () => {
    const audit = { record: jest.fn() };
    const importService = new ImportsService({} as any, {} as any, {} as any, audit as any);
    const content = await importService.createImportTemplate('admin-1');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(content as unknown as ArrayBuffer);
    const worksheet = workbook.worksheets[0];

    expect(worksheet.getRow(1).values).toEqual([undefined, '姓名', '手机号']);
    expect(worksheet.actualRowCount).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CUSTOMER_IMPORT_TEMPLATE_DOWNLOADED',
    }));
  });

  it('commits every imported customer to the batch selected during preview', async () => {
    const prisma = {
      importJob: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ batchId: 'batch-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      batch: {
        findFirst: jest.fn().mockResolvedValue({ id: 'batch-1', name: '八月批次', code: 'AUG' }),
      },
      importRow: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'row-1',
          rowNumber: 2,
          status: 'NEW',
          name: '张三',
          phoneCiphertext: Buffer.from([1]),
          phoneIv: Buffer.from([2]),
          phoneTag: Buffer.from([3]),
          phoneHash: 'hash-1',
          phoneMasked: '138****8000',
          province: '江苏',
          city: '南京',
          carrier: '中国移动',
          notes: null,
          tags: [],
        }]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      suppressionEntry: { findMany: jest.fn().mockResolvedValue([]) },
      customer: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const audit = { record: jest.fn() };
    const importService = new ImportsService(prisma as any, {} as any, {} as any, audit as any);

    await expect(importService.commit('import-1', DuplicateModeDto.SKIP, 'admin-1'))
      .resolves.toEqual({ created: 1, updated: 0, skipped: 0 });
    expect(prisma.customer.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ batchId: 'batch-1', name: '张三' })],
    }));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_IMPORT_COMMITTED',
        metadata: expect.objectContaining({ batchId: 'batch-1' }),
      }),
      prisma,
    );
  });

  it('streams customer exports in bounded pages', async () => {
    const createdAt = new Date('2026-08-15T01:00:00.000Z');
    const prisma = {
      customer: {
        findMany: jest.fn().mockResolvedValueOnce([{
          id: 'customer-1',
          name: '张三',
          phoneMasked: '138****0001',
          phoneCiphertext: Buffer.from([1]),
          phoneIv: Buffer.from([2]),
          phoneTag: Buffer.from([3]),
          province: '江苏',
          city: '徐州',
          carrier: '中国移动',
          tags: ['重点'],
          notes: '回访',
          createdAt,
          batch: { name: '八月批次' },
          assignments: [{ agent: { displayName: '坐席甲' } }],
        }]),
      },
    };
    const audit = { record: jest.fn() };
    const crypto = { decryptPhone: jest.fn().mockReturnValue('+8613800000001') };
    const importService = new ImportsService(prisma as any, crypto as any, {} as any, audit as any);

    let content = '';
    for await (const chunk of importService.exportCustomers({ page: 1, pageSize: 20 }, 'admin-1')) {
      content += chunk.toString();
    }

    expect(content).toContain('"客户名称","联系号码"');
    expect(content).toContain("\"张三\",\"'+8613800000001\",\"八月批次\"");
    expect(prisma.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 500 }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'CUSTOMERS_EXPORTED',
      metadata: { maximumRows: 100_000, streamed: true },
    }));
  });
});
