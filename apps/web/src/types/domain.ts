export type Id = string;

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface User {
  id: Id;
  username: string;
  displayName: string;
  role: 'ADMIN' | 'AGENT';
  enabled: boolean;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  user: User;
}

export type AssignmentStatus = 'UNASSIGNED' | 'ASSIGNED' | 'COMPLETED' | 'WITHDRAWN' | 'NOT_CONNECTED';
export type CustomerStatus = 'ACTIVE' | 'ARCHIVED';

export interface Customer {
  id: Id;
  sequence?: number;
  name: string;
  phoneMasked: string;
  province?: string;
  city?: string;
  carrier?: string;
  notes?: string;
  tags: string[];
  version: number;
  status: CustomerStatus;
  batch?: Pick<Batch, 'id' | 'name'> | null;
  assignmentStatus: AssignmentStatus;
  assignedAgent?: Pick<Agent, 'id' | 'displayName' | 'username'> | null;
  attemptCount: number;
  lastCallStatus?: CallStatus | null;
  lastCalledAt?: string | null;
  createdAt: string;
  updatedAt: string;
  erasedAt?: string | null;
}

export interface AssignmentHistoryItem {
  id: Id;
  status: 'ACTIVE' | 'COMPLETED' | 'RECLAIMED' | 'REASSIGNED' | 'SUPPRESSED';
  assignedAt: string;
  endedAt?: string | null;
  agent: Pick<Agent, 'id' | 'displayName' | 'username'>;
  assignedBy?: Pick<User, 'id' | 'displayName'> | null;
}

export interface CustomerDetail extends Customer {
  assignmentHistory: AssignmentHistoryItem[];
}

export interface CustomerInput {
  name: string;
  phone: string;
  batchId?: Id;
  province?: string;
  city?: string;
  carrier?: string;
  notes?: string;
  tags?: string[];
}

export interface PhoneAttribution {
  province?: string;
  city?: string;
  carrier?: string;
}

export type CustomerUpdate = Omit<Partial<CustomerInput>, 'phone'> & { version: number };

export interface Batch {
  id: Id;
  name: string;
  code?: string;
  notes?: string;
  customerCount: number;
  assignedCount: number;
  completedCount: number;
  createdAt: string;
}

export interface Agent {
  id: Id;
  username: string;
  displayName: string;
  enabled: boolean;
  pendingCount: number;
  todayAttempts?: number;
  todayConnected?: number;
  device?: Device | null;
  createdAt: string;
}

export type DeviceHealth = 'HEALTHY' | 'WARNING' | 'BLOCKED' | 'OFFLINE';

export interface Device {
  id: Id;
  agentId: Id;
  agentName: string;
  brand: string;
  model: string;
  androidVersion: string;
  appVersion: string;
  health: DeviceHealth;
  active: boolean;
  permissionCallPhone: boolean;
  permissionReadCallLog: boolean;
  lastSeenAt?: string | null;
  activatedAt: string;
}

export interface AllowedDeviceModel {
  id: Id;
  manufacturer: string;
  model: string;
  androidSdk: number;
  enabled: boolean;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MobileAppPolicy {
  id: 'android';
  minimumVersionCode: number;
  latestVersionCode: number;
  forceUpgrade: boolean;
  deviceCompatibilityRequired: boolean;
  maxCallAttempts: number;
  downloadUrl?: string | null;
  updatedAt: string;
}

export type CallStatus = 'COLLECTING' | 'CONNECTED' | 'NOT_CONNECTED' | 'UNKNOWN';

export interface CallRecord {
  id: Id;
  attemptId: Id;
  customerId: Id;
  customerName: string;
  phoneMasked: string;
  agentId: Id;
  agentName: string;
  batchId?: Id | null;
  batchName?: string | null;
  status: CallStatus;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  collectedAt?: string | null;
}

export interface ReportSummary {
  attempts: number;
  uniqueCustomers: number;
  connected: number;
  notConnected: number;
  unknown: number;
  collecting: number;
  dataCompletenessRate: number;
  connectionRate: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
}

export interface AgentCallStats {
  agentId: Id;
  agentName: string;
  username: string;
  attempts: number;
  uniqueCustomers: number;
  connected: number;
  notConnected: number;
  collecting: number;
  unknown: number;
  connectionRate: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number;
  maxDurationSeconds: number;
}

export interface DashboardStats extends ReportSummary {
  activeCustomers: number;
  assignedPending: number;
  activeAgents: number;
  healthyDevices: number;
  deviceCount: number;
  agentStats: AgentCallStats[];
}

export interface SuppressionEntry {
  id: Id;
  phoneMasked: string;
  reason?: string;
  source: 'MANUAL' | 'IMPORT' | 'COMPLIANCE';
  withdrawnAssignments?: number;
  createdBy?: string;
  createdAt: string;
}

export interface HealthStatus {
  status: 'ok';
  database: 'up';
  timestamp: string;
  version: string;
}

export interface AuditEvent {
  id: Id;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  summary: string;
  ipAddress?: string;
  createdAt: string;
}

export interface ImportPreviewRow {
  rowNumber: number;
  name?: string;
  phoneMasked: string;
  province?: string;
  city?: string;
  carrier?: string;
  result: 'NEW' | 'DUPLICATE' | 'INVALID' | 'SUPPRESSED';
  message?: string;
}

export interface ImportPreview {
  importId: Id;
  fileName: string;
  batchId: Id;
  batchName: string;
  total: number;
  newCount: number;
  duplicateCount: number;
  invalidCount: number;
  suppressedCount: number;
  rows: ImportPreviewRow[];
}

export interface ImportCommitResult {
  created: number;
  updated: number;
  skipped: number;
}

export interface ListOptions extends PageQuery {
  search?: string;
  status?: string;
  batchId?: Id;
  agentId?: Id;
  assignmentStatus?: AssignmentStatus;
  phone?: string;
  from?: string;
  to?: string;
}

export type BulkAssignmentScope = 'FILTER' | 'ALL';

export interface BulkAssignmentInput {
  scope: BulkAssignmentScope;
  agentIds: Id[];
  quantity: number;
  search?: string;
  status?: string;
  batchId?: Id;
  agentId?: Id;
  assignmentStatus?: AssignmentStatus;
  phone?: string;
}

export interface BulkAssignmentPreview {
  scope: BulkAssignmentScope;
  matchedCount: number;
  assignableCount: number;
  skippedCount: number;
  requestedCount: number;
  remainingCount: number;
  exceedsAssignable: boolean;
  allocations: Array<{
    agent: Pick<Agent, 'id' | 'displayName' | 'username'>;
    quantity: number;
  }>;
}

export interface BulkAssignmentResult extends Omit<BulkAssignmentPreview, 'allocations'> {
  assigned: number;
  allocations: Array<BulkAssignmentPreview['allocations'][number] & { assigned: number }>;
}
