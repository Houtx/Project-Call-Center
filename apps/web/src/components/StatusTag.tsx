import { Tag } from 'antd';
import { statusText } from '../lib/format';

const colors: Record<string, string> = {
  ACTIVE: 'green',
  HEALTHY: 'green',
  CONNECTED: 'green',
  ASSIGNED: 'blue',
  COMPLETED: 'cyan',
  COLLECTING: 'processing',
  WARNING: 'orange',
  NOT_CONNECTED: 'default',
  UNKNOWN: 'gold',
  ARCHIVED: 'default',
  RECLAIMED: 'default',
  REASSIGNED: 'blue',
  SUPPRESSED: 'red',
  WITHDRAWN: 'default',
  BLOCKED: 'red',
  OFFLINE: 'default',
  UNASSIGNED: 'default',
};

export function StatusTag({ status }: { status: string }) {
  return <Tag color={colors[status]}>{statusText[status as keyof typeof statusText] ?? status}</Tag>;
}
