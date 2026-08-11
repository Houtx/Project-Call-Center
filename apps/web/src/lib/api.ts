import type {
  Agent,
  AllowedDeviceModel,
  BulkAssignmentInput,
  BulkAssignmentPreview,
  BulkAssignmentResult,
  AuditEvent,
  Batch,
  CallRecord,
  Customer,
  CustomerDetail,
  CustomerInput,
  CustomerUpdate,
  DashboardStats,
  Device,
  HealthStatus,
  ImportCommitResult,
  ImportPreview,
  PhoneAttribution,
  ListOptions,
  MobileAppPolicy,
  PageResult,
  ReportSummary,
  Session,
  SuppressionEntry,
  User,
} from '../types/domain';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const TOKEN_KEY = 'call_center_admin_token';
const REFRESH_TOKEN_KEY = 'call_center_admin_refresh_token';
let refreshPromise: Promise<boolean> | null = null;

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_TOKEN_KEY),
  set: (token: string, refreshToken?: string) => {
    localStorage.setItem(TOKEN_KEY, token);
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  query?: Record<string, unknown>;
  idempotencyKey?: string;
};

const makeQuery = (query?: Record<string, unknown>) => {
  const search = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

const getMessage = (payload: unknown, fallback: string) => {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const message = record.detail ?? record.message ?? record.error;
    if (Array.isArray(message)) return message.join('；');
    if (typeof message === 'string') return message;
  }
  return fallback;
};

const unwrap = <T>(payload: unknown): T => {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
};

const refreshAccessToken = (): Promise<boolean> => {
  if (refreshPromise) return refreshPromise;
  const refreshToken = tokenStore.getRefresh();
  if (!refreshToken) return Promise.resolve(false);
  refreshPromise = fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
    .then(async (response) => {
      if (!response.ok) return false;
      const session = unwrap<{ accessToken: string; refreshToken: string }>(await response.json());
      tokenStore.set(session.accessToken, session.refreshToken);
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
};

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const token = tokenStore.get();
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}${makeQuery(options.query)}`, {
      ...options,
      headers,
      body,
    });
  } catch {
    throw new ApiError('无法连接服务器，请检查网络或稍后重试', 0);
  }

  if (response.status === 401 && path !== '/auth/login' && path !== '/auth/refresh') {
    if (await refreshAccessToken()) return request<T>(path, options);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) tokenStore.clear();
    throw new ApiError(getMessage(payload, `请求失败 (${response.status})`), response.status, payload);
  }
  if (response.status === 204) return undefined as T;
  return unwrap<T>(payload);
};

const idempotencyKey = () => crypto.randomUUID();

const normalizePage = <T>(payload: PageResult<T> | { data: T[]; meta: { total: number; page: number; pageSize: number } }): PageResult<T> => {
  if ('items' in payload) return payload;
  return { items: payload.data, ...payload.meta };
};

interface WireAgent {
  id: string;
  username: string;
  displayName: string;
  status?: 'ACTIVE' | 'DISABLED';
  enabled?: boolean;
  pendingCount?: number;
  todayAttempts?: number;
  todayConnected?: number;
  createdAt: string;
  _count?: { assignments?: number; devices?: number };
}

interface WireDevice {
  id: string;
  userId: string;
  user?: { id: string; displayName: string; username: string };
  manufacturer: string;
  model: string;
  androidVersion: string;
  appVersion: string;
  status: 'ACTIVE' | 'REVOKED' | 'PENDING';
  callPhonePermission: 'UNKNOWN' | 'GRANTED' | 'DENIED';
  callLogPermission: 'UNKNOWN' | 'GRANTED' | 'DENIED';
  lastHealthAt?: string | null;
  activatedAt?: string | null;
  createdAt: string;
  allowedDeviceModel?: { enabled: boolean } | null;
  compatibilityRequired?: boolean;
}

interface WireSuppression {
  id: string;
  phoneMasked: string;
  reason?: string;
  source: SuppressionEntry['source'];
  createdAt: string;
  createdBy?: { displayName: string } | string | null;
}

const mapAgent = (agent: WireAgent): Agent => ({
  id: agent.id,
  username: agent.username,
  displayName: agent.displayName,
  enabled: agent.enabled ?? agent.status === 'ACTIVE',
  pendingCount: agent.pendingCount ?? agent._count?.assignments ?? 0,
  todayAttempts: agent.todayAttempts,
  todayConnected: agent.todayConnected,
  createdAt: agent.createdAt,
});

const mapDevice = (device: WireDevice): Device => {
  const permissionsHealthy = device.callPhonePermission === 'GRANTED' && device.callLogPermission === 'GRANTED';
  const recentlyOnline = device.lastHealthAt ? Date.now() - new Date(device.lastHealthAt).getTime() < 5 * 60_000 : false;
  const active = device.status === 'ACTIVE';
  const compatibilityRequired = device.compatibilityRequired ?? true;
  return {
    id: device.id,
    agentId: device.userId,
    agentName: device.user?.displayName ?? '-',
    brand: device.manufacturer,
    model: device.model,
    androidVersion: device.androidVersion,
    appVersion: device.appVersion,
    active,
    health: !active ? 'BLOCKED' : !recentlyOnline ? 'OFFLINE' : !permissionsHealthy || (compatibilityRequired && device.allowedDeviceModel?.enabled !== true) ? 'WARNING' : 'HEALTHY',
    permissionCallPhone: device.callPhonePermission === 'GRANTED',
    permissionReadCallLog: device.callLogPermission === 'GRANTED',
    lastSeenAt: device.lastHealthAt,
    activatedAt: device.activatedAt ?? device.createdAt,
  };
};

const mapSuppression = (entry: WireSuppression): SuppressionEntry => ({
  ...entry,
  createdBy: typeof entry.createdBy === 'string' ? entry.createdBy : entry.createdBy?.displayName,
});

const list = async <T>(path: string, query?: Record<string, unknown>) => {
  const payload = await request<PageResult<T> | { data: T[]; meta: { total: number; page: number; pageSize: number } }>(path, { query });
  return normalizePage(payload);
};

export const api = {
  health: () => request<HealthStatus>('/health'),
  auth: {
    login: (username: string, password: string) =>
      request<Session>('/auth/login', { method: 'POST', body: { username, password }, idempotencyKey: idempotencyKey() }),
    me: () => request<User>('/auth/me'),
  },
  dashboard: {
    stats: () => request<DashboardStats>('/dashboard/stats'),
  },
  customers: {
    list: (query: ListOptions) => list<Customer>('/customers', query as Record<string, unknown>),
    get: (id: string) => request<CustomerDetail>(`/customers/${id}`),
    create: (input: CustomerInput) => request<Customer>('/customers', { method: 'POST', body: input, idempotencyKey: idempotencyKey() }),
    phoneAttribution: (phone: string) => request<PhoneAttribution>('/customers/phone-attribution', { method: 'POST', body: { phone } }),
    update: (id: string, input: CustomerUpdate) => request<Customer>(`/customers/${id}`, { method: 'PATCH', body: input, idempotencyKey: idempotencyKey() }),
    archive: (id: string) => request<void>(`/customers/${id}/archive`, { method: 'POST', idempotencyKey: idempotencyKey() }),
    erase: (id: string, reason: string) => request<void>(`/customers/${id}/erase`, { method: 'POST', body: { reason }, idempotencyKey: idempotencyKey() }),
    revealPhone: (id: string) => request<{ phone: string; expiresAt: string }>(`/customers/${id}/phone`, { method: 'POST', idempotencyKey: idempotencyKey() }),
    assign: (customerIds: string[], agentId: string) => request<{ assigned: number }>('/assignments', { method: 'POST', body: { customerIds, agentId }, idempotencyKey: idempotencyKey() }),
    retryAssign: (customerIds: string[], agentId: string) => request<{ assigned: number }>('/assignments/retry', { method: 'POST', body: { customerIds, agentId }, idempotencyKey: idempotencyKey() }),
    bulkPreview: (input: BulkAssignmentInput) => request<BulkAssignmentPreview>('/assignments/bulk/preview', { method: 'POST', body: input }),
    bulkAssign: (input: BulkAssignmentInput) => request<BulkAssignmentResult>('/assignments/bulk', { method: 'POST', body: input, idempotencyKey: idempotencyKey() }),
    withdraw: (customerIds: string[]) => request<{ withdrawn: number }>('/assignments/withdraw', { method: 'POST', body: { customerIds }, idempotencyKey: idempotencyKey() }),
    importPreview: async (file: File, batchId: string) => {
      const body = new FormData();
      body.append('file', file);
      body.append('batchId', batchId);
      return request<ImportPreview>('/customers/import/preview', { method: 'POST', body, idempotencyKey: idempotencyKey() });
    },
    importCommit: (importId: string, duplicateMode: 'SKIP' | 'UPDATE') => request<ImportCommitResult>('/customers/import/commit', { method: 'POST', body: { importId, duplicateMode }, idempotencyKey: idempotencyKey() }),
    importTemplateUrl: () => `${API_BASE_URL}/customers/import/template`,
    exportUrl: (query: ListOptions) => `${API_BASE_URL}/customers/export${makeQuery(query as Record<string, unknown>)}`,
  },
  batches: {
    list: (query: ListOptions) => list<Batch>('/batches', query as Record<string, unknown>),
    create: (input: { name: string; code?: string; notes?: string }) => request<Batch>('/batches', { method: 'POST', body: input, idempotencyKey: idempotencyKey() }),
    update: (id: string, input: { name?: string; code?: string; notes?: string }) => request<Batch>(`/batches/${id}`, { method: 'PATCH', body: input, idempotencyKey: idempotencyKey() }),
  },
  agents: {
    list: async (query: ListOptions) => {
      const { page: pageNumber, pageSize, search } = query;
      const page = await list<WireAgent>('/agents', { page: pageNumber, pageSize, search });
      return { ...page, items: page.items.map(mapAgent) };
    },
    create: async (input: { username: string; displayName: string; password: string }) => mapAgent(await request<WireAgent>('/agents', { method: 'POST', body: input, idempotencyKey: idempotencyKey() })),
    setEnabled: async (id: string, enabled: boolean) => mapAgent(await request<WireAgent>(`/agents/${id}`, { method: 'PATCH', body: { active: enabled }, idempotencyKey: idempotencyKey() })),
    resetPassword: (agentId: string, password: string) => request<void>(`/agents/${agentId}/reset-password`, { method: 'POST', body: { password }, idempotencyKey: idempotencyKey() }),
    revokeDevice: (deviceId: string) => request<void>(`/devices/${deviceId}/revoke`, { method: 'POST', idempotencyKey: idempotencyKey() }),
    devices: async () => (await request<WireDevice[]>('/devices')).map(mapDevice),
    deviceModels: () => request<AllowedDeviceModel[]>('/device-models'),
    addDeviceModel: (input: { manufacturer: string; model: string; androidSdk: number; notes?: string }) =>
      request<AllowedDeviceModel>('/device-models', { method: 'POST', body: input, idempotencyKey: idempotencyKey() }),
    updateDeviceModel: (id: string, input: { enabled?: boolean; notes?: string }) =>
      request<AllowedDeviceModel>(`/device-models/${id}`, { method: 'PATCH', body: input, idempotencyKey: idempotencyKey() }),
    mobilePolicy: () => request<MobileAppPolicy>('/mobile-app-policy'),
    updateMobilePolicy: (input: Pick<MobileAppPolicy, 'minimumVersionCode' | 'latestVersionCode' | 'forceUpgrade' | 'deviceCompatibilityRequired' | 'maxCallAttempts'> & { downloadUrl?: string }) =>
      request<MobileAppPolicy>('/mobile-app-policy', { method: 'PATCH', body: input, idempotencyKey: idempotencyKey() }),
  },
  calls: {
    list: (query: ListOptions) => list<CallRecord>('/calls', query as Record<string, unknown>),
    revealPhone: (id: string) => request<{ phone: string; expiresAt: string }>(`/calls/${id}/phone`, { method: 'POST' }),
    summary: (query: ListOptions) => request<ReportSummary>('/reports/summary', { query: query as Record<string, unknown> }),
    exportUrl: (query: ListOptions) => `${API_BASE_URL}/calls/export${makeQuery(query as Record<string, unknown>)}`,
  },
  suppression: {
    list: async (query: ListOptions) => {
      const page = await list<WireSuppression>('/suppression', query as Record<string, unknown>);
      return { ...page, items: page.items.map(mapSuppression) };
    },
    create: async (input: { phone: string; reason: string }) => {
      const result = await request<WireSuppression & { withdrawnAssignments: number }>('/suppression', { method: 'POST', body: input, idempotencyKey: idempotencyKey() });
      return { ...mapSuppression(result), withdrawnAssignments: result.withdrawnAssignments };
    },
    remove: (id: string) => request<void>(`/suppression/${id}`, { method: 'DELETE', idempotencyKey: idempotencyKey() }),
  },
  audit: {
    list: (query: ListOptions & { action?: string; resourceType?: string }) => list<AuditEvent>('/audit-events', query as Record<string, unknown>),
  },
};

export const downloadAuthenticated = async (url: string, fileName: string) => {
  const response = await fetch(url, { headers: tokenStore.get() ? { Authorization: `Bearer ${tokenStore.get()}` } : {} });
  if (!response.ok) throw new ApiError('导出失败，请稍后重试', response.status);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(href);
};
