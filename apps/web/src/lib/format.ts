import dayjs from 'dayjs';

export const formatDateTime = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-';

export const formatDuration = (seconds?: number | null) => {
  if (seconds == null) return '-';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours > 0
    ? `${hours}时${minutes}分${secs}秒`
    : minutes > 0
      ? `${minutes}分${secs}秒`
      : `${secs}秒`;
};

export const formatPercent = (value?: number | null) =>
  `${((value ?? 0) * 100).toFixed(1)}%`;

export const numberFormat = new Intl.NumberFormat('zh-CN');

export const statusText = {
  UNASSIGNED: '未分配',
  ASSIGNED: '待外呼',
  COMPLETED: '已完成',
  WITHDRAWN: '已撤回',
  ACTIVE: '正常',
  ARCHIVED: '已归档',
  RECLAIMED: '已回收',
  REASSIGNED: '已改派',
  SUPPRESSED: '拒呼撤回',
  COLLECTING: '采集中',
  CONNECTED: '已接通',
  NOT_CONNECTED: '未接通',
  UNKNOWN: '未知',
  HEALTHY: '正常',
  WARNING: '异常',
  BLOCKED: '已停用',
  OFFLINE: '离线',
} as const;
