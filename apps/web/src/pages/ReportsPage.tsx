import { useState } from 'react';
import dayjs from 'dayjs';
import { Button, Progress, Table } from 'antd';
import { CheckCircle2, Clock3, PhoneCall, RefreshCw, UserRoundCheck, UsersRound } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { CallFilters } from '../components/CallFilters';
import { MetricCard } from '../components/MetricCard';
import { ErrorState, PageLoading } from '../components/AsyncState';
import { StatusTag } from '../components/StatusTag';
import { api } from '../lib/api';
import { formatDateTime, formatDuration, formatPercent, numberFormat } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { CallRecord, ListOptions } from '../types/domain';

const todayQuery = (): ListOptions => ({ page: 1, pageSize: 10, from: dayjs().startOf('day').toISOString(), to: dayjs().endOf('day').toISOString() });

export function ReportsPage() {
  const [query, setQuery] = useState<ListOptions>(todayQuery);
  const remote = useRemote(() => Promise.all([
    api.calls.summary(query),
    api.calls.list(query),
    api.agents.list({ page: 1, pageSize: 100 }),
    api.batches.list({ page: 1, pageSize: 200 }),
  ]), [query.from, query.to, query.agentId, query.batchId, query.status]);

  if (remote.loading && !remote.data) return <PageLoading />;
  if (remote.error && !remote.data) return <ErrorState error={remote.error} onRetry={remote.reload} />;
  const [summary, calls, agents, batches] = remote.data!;
  const maxStatus = Math.max(summary.connected, summary.notConnected, summary.collecting, summary.unknown, 1);

  return (
    <>
      <PageHeader title="数据报表" description="按日期、坐席与批次检视外呼质量" actions={<Button icon={<RefreshCw size={16} />} loading={remote.loading} onClick={remote.reload}>刷新数据</Button>} />
      <section className="surface filter-surface"><CallFilters agents={agents.items} batches={batches.items} defaultToday onSearch={(filter) => setQuery({ ...filter, page: 1, pageSize: 10 })} /></section>
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <div className="metrics-grid report-metrics">
        <MetricCard label="外呼次数" value={numberFormat.format(summary.attempts)} hint={`${numberFormat.format(summary.uniqueCustomers)} 位去重客户`} icon={<PhoneCall size={21} />} />
        <MetricCard label="已接通" value={numberFormat.format(summary.connected)} hint={`接通率 ${formatPercent(summary.connectionRate)}`} icon={<CheckCircle2 size={21} />} tone="green" />
        <MetricCard label="数据完整率" value={formatPercent(summary.dataCompletenessRate)} hint={`未知 ${summary.unknown} 通`} icon={<UserRoundCheck size={21} />} tone="blue" />
        <MetricCard label="总通话时长" value={formatDuration(summary.totalDurationSeconds)} hint={`平均 ${formatDuration(summary.averageDurationSeconds)}`} icon={<Clock3 size={21} />} tone="amber" />
      </div>
      <div className="dashboard-grid report-grid">
        <section className="surface status-distribution">
          <div className="section-heading"><div><h2>结果分布</h2><p>当前筛选范围</p></div></div>
          {[
            ['已接通', summary.connected, 'connected'],
            ['未接通', summary.notConnected, 'missed'],
            ['采集中', summary.collecting, 'collecting'],
            ['未知', summary.unknown, 'unknown'],
          ].map(([label, value, tone]) => <div className="bar-row" key={String(label)}><span>{label}</span><div><i className={`bar bar--${tone}`} style={{ width: `${Number(value) / maxStatus * 100}%` }} /></div><strong>{value}</strong></div>)}
        </section>
        <section className="surface formula-panel">
          <div className="section-heading"><div><h2>统计口径</h2><p>报表用于运营管理</p></div></div>
          <div className="formula-item"><span>接通率</span><strong>已接通 ÷（已接通 + 未接通）</strong></div>
          <div className="formula-item"><span>数据完整率</span><strong>已有明确结果 ÷ 外呼次数</strong></div>
          <p className="muted-note">采集中与未知均不进入接通率分母；迟到结果会自动更正。</p>
        </section>
      </div>
      <section className="surface table-surface">
        <div className="section-heading"><div><h2>样本明细</h2><p>当前筛选的最近 10 通</p></div></div>
        <Table<CallRecord> rowKey="id" pagination={false} dataSource={calls.items} columns={[
          { title: '发起时间', dataIndex: 'startedAt', render: formatDateTime },
          { title: '坐席', dataIndex: 'agentName' },
          { title: '客户', dataIndex: 'customerName' },
          { title: '批次', dataIndex: 'batchName', render: (value) => value || '-' },
          { title: '结果', dataIndex: 'status', render: (status) => <StatusTag status={status} /> },
          { title: '时长', dataIndex: 'durationSeconds', render: formatDuration },
        ]} />
      </section>
    </>
  );
}
