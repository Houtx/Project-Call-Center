import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, tokenStore } from './api';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
});

describe('typed API boundary', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  it('normalizes the backend agent page into the web page contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      items: [{
        id: 'agent-1',
        username: 'agent01',
        displayName: '张座席',
        enabled: true,
        pendingCount: 7,
        createdAt: '2026-08-05T00:00:00.000Z',
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.agents.list({ page: 1, pageSize: 20, status: 'ACTIVE' });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ enabled: true, pendingCount: 7 });
    expect(result.items[0].todayAttempts).toBeUndefined();
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('status=');
  });

  it('sends the required optimistic version when updating a customer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'customer-1', name: '李客户', phoneMasked: '138****8000', tags: [], version: 4,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.customers.update('customer-1', { name: '李客户', version: 3 });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: '李客户', version: 3 });
  });

  it('requests phone attribution for the manual customer form', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.customers.phoneAttribution('13800000003')).resolves.toEqual({
      province: '江苏',
      city: '徐州',
      carrier: '中国移动',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/customers/phone-attribution');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)))
      .toEqual({ phone: '13800000003' });
  });

  it('binds the selected batch to an import preview upload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      importId: 'import-1',
      fileName: 'customers.xlsx',
      batchId: 'batch-1',
      batchName: '八月批次',
      total: 0,
      newCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      suppressedCount: 0,
      rows: [],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['姓名,手机号\n'], 'customers.csv', { type: 'text/csv' });

    await api.customers.importPreview(file, 'batch-1');

    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData;
    expect(body.get('batchId')).toBe('batch-1');
    expect(body.get('file')).toBe(file);
  });

  it('matches the suppression command and unwraps its result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      id: 'suppression-1',
      phoneMasked: '138****0006',
      source: 'MANUAL',
      createdAt: '2026-08-05T00:00:00.000Z',
      withdrawnAssignments: 3,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.suppression.create({ phone: '13800000006', reason: '客户要求' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ phone: '13800000006', reason: '客户要求' });
    expect(result.withdrawnAssignments).toBe(3);
  });

  it('surfaces RFC problem detail from version conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      status: 409,
      code: 'VERSION_CONFLICT',
      detail: '客户资料已被其他人修改，请刷新后重试',
    }, 409)));

    await expect(api.customers.update('customer-1', { version: 2 })).rejects.toMatchObject({
      status: 409,
      message: '客户资料已被其他人修改，请刷新后重试',
    });
  });

  it('rotates an expired access token and retries the original request once', async () => {
    tokenStore.set('expired-access', 'refresh-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ detail: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: 'new-access', refreshToken: 'new-refresh' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', database: 'up', timestamp: 'now', version: '0.1.0' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.health()).resolves.toMatchObject({ status: 'ok', database: 'up' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((fetchMock.mock.calls[2][1] as RequestInit).headers as Headers).get('Authorization'))
      .toBe('Bearer new-access');
    expect(tokenStore.getRefresh()).toBe('new-refresh');
  });

  it('revokes the refresh token when logging out', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await api.auth.logout('refresh-token');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/auth/logout');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)))
      .toEqual({ refreshToken: 'refresh-token' });
  });
});
