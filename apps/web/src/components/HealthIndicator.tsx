import { useEffect, useState } from 'react';
import { Tooltip } from 'antd';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';

type HealthState =
  | { status: 'checking' }
  | { status: 'online'; checkedAt: string; version: string }
  | { status: 'offline'; checkedAt: string };

export function HealthIndicator() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });

  useEffect(() => {
    let active = true;
    const check = () => api.health()
      .then((result) => {
        if (active) setHealth({ status: 'online', checkedAt: result.timestamp, version: result.version });
      })
      .catch(() => {
        if (active) setHealth({ status: 'offline', checkedAt: new Date().toISOString() });
      });
    void check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const label = health.status === 'checking' ? '正在检查服务状态' : health.status === 'online' ? '服务连接正常' : '服务暂时不可达';
  const detail = health.status === 'checking'
    ? '正在请求 /api/v1/health'
    : health.status === 'online'
      ? `版本 ${health.version} · ${formatDateTime(health.checkedAt)}`
      : `最近检查 ${formatDateTime(health.checkedAt)}`;

  return (
    <Tooltip title={detail} placement="right">
      <div className="sider-foot"><span className={`status-dot status-dot--${health.status}`} />{label}</div>
    </Tooltip>
  );
}
