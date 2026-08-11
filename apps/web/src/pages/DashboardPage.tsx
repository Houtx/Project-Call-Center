import { Alert, Button, Progress, Table } from 'antd';
import { CheckCircle2, Database, Headset, PhoneCall, RefreshCw, Smartphone, Users } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { MetricCard } from '../components/MetricCard';
import { ErrorState, PageLoading } from '../components/AsyncState';
import { StatusTag } from '../components/StatusTag';
import { api } from '../lib/api';
import { formatDateTime, formatDuration, formatPercent, numberFormat } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { AgentCallStats, CallRecord } from '../types/domain';

export function DashboardPage() {
  const remote = useRemote(() => Promise.all([
    api.dashboard.stats(),
    api.calls.list({ page: 1, pageSize: 6 }),
  ]), []);

  if (remote.loading && !remote.data) return <PageLoading />;
  if (remote.error && !remote.data) return <ErrorState error={remote.error} onRetry={remote.reload} />;
  const [stats, recent] = remote.data!;
  const knownCalls = stats.connected + stats.notConnected;

  return (
    <>
      <PageHeader
        title="工作台"
        description="今日外呼进度与设备数据一览"
        actions={<Button icon={<RefreshCw size={16} />} loading={remote.loading} onClick={remote.reload}>刷新数据</Button>}
      />
      {stats.unknown > 0 && (
        <Alert className="page-alert" type="warning" showIcon message={`今日有 ${stats.unknown} 通记录超过采集时限，已标记为未知`} description="请在通话记录中按设备排查；未知数据不计入接通率分母。" />
      )}
      <div className="metrics-grid">
        <MetricCard label="今日外呼" value={numberFormat.format(stats.attempts)} hint={`${numberFormat.format(stats.uniqueCustomers)} 位客户`} icon={<PhoneCall size={21} />} />
        <MetricCard label="今日接通" value={numberFormat.format(stats.connected)} hint={`接通率 ${formatPercent(stats.connectionRate)}`} icon={<CheckCircle2 size={21} />} tone="green" />
        <MetricCard label="待外呼客户" value={numberFormat.format(stats.assignedPending)} hint={`客户库 ${numberFormat.format(stats.activeCustomers)} 条`} icon={<Database size={21} />} tone="blue" />
        <MetricCard label="在线坐席" value={numberFormat.format(stats.activeAgents)} hint="近 5 分钟在线" icon={<Headset size={21} />} tone="amber" />
      </div>
      <div className="dashboard-grid">
        <section className="surface performance-panel">
          <div className="section-heading"><div><h2>今日数据质量</h2><p>数据会随 APP 迟到回传自动更正</p></div></div>
          <div className="quality-list">
            <div className="quality-primary">
              <Progress type="dashboard" percent={Math.round(stats.dataCompletenessRate * 100)} strokeColor="#087f7a" trailColor="#e7edef" size={148} />
              <div><strong>数据完整率</strong><span>{knownCalls} 通已有明确结果</span></div>
            </div>
            <div className="quality-rows">
              <div><span><i className="legend-dot connected" />已接通</span><strong>{stats.connected}</strong></div>
              <div><span><i className="legend-dot missed" />未接通</span><strong>{stats.notConnected}</strong></div>
              <div><span><i className="legend-dot collecting" />采集中</span><strong>{stats.collecting}</strong></div>
              <div><span><i className="legend-dot unknown" />未知</span><strong>{stats.unknown}</strong></div>
            </div>
          </div>
        </section>
        <section className="surface device-panel">
          <div className="section-heading"><div><h2>设备概况</h2><p>已登录绑定的坐席手机</p></div><Smartphone size={20} /></div>
          <div className="device-health"><strong>{stats.healthyDevices}</strong><span>/ {stats.deviceCount} 台正常</span></div>
          <Progress percent={stats.deviceCount ? Math.round(stats.healthyDevices / stats.deviceCount * 100) : 0} showInfo={false} strokeColor="#2f855a" />
          <p className="muted-note">权限、版本或长时间离线的设备将在“坐席与设备”中提示。</p>
        </section>
      </div>
      <section className="surface table-surface dashboard-page-table">
        <div className="section-heading"><div><h2>最近外呼</h2><p>最新同步的 6 条通话记录</p></div></div>
        <Table<CallRecord>
          rowKey="id"
          size="middle"
          pagination={false}
          dataSource={recent.items}
          columns={[
            { title: '发起时间', dataIndex: 'startedAt', render: formatDateTime, width: 180 },
            { title: '客户', dataIndex: 'customerName' },
            { title: '号码', dataIndex: 'phoneMasked' },
            { title: '坐席', dataIndex: 'agentName' },
            { title: '结果', dataIndex: 'status', render: (status) => <StatusTag status={status} /> },
            { title: '通话时长', dataIndex: 'durationSeconds', render: formatDuration },
          ]}
        />
      </section>
      <section className="surface table-surface dashboard-page-table">
        <div className="section-heading"><div><h2>今日坐席外呼统计</h2><p>按今日外呼次数降序，仅显示有外呼记录的坐席</p></div></div>
        <Table<AgentCallStats>
          rowKey="agentId"
          size="middle"
          pagination={false}
          dataSource={stats.agentStats}
          scroll={{ x: 1160 }}
          columns={[
            {
              title: '坐席',
              dataIndex: 'agentName',
              width: 180,
              fixed: 'left',
              render: (name, row) => <span className="primary-cell"><strong>{name}</strong><small>{row.username}</small></span>,
            },
            { title: '外呼次数', dataIndex: 'attempts', width: 100, align: 'right', render: (value) => numberFormat.format(value) },
            { title: '去重客户', dataIndex: 'uniqueCustomers', width: 100, align: 'right', render: (value) => numberFormat.format(value) },
            { title: '接通', dataIndex: 'connected', width: 82, align: 'right', render: (value) => numberFormat.format(value) },
            { title: '未接通', dataIndex: 'notConnected', width: 90, align: 'right', render: (value) => numberFormat.format(value) },
            { title: '采集 / 未知', key: 'pending', width: 110, align: 'right', render: (_, row) => `${row.collecting} / ${row.unknown}` },
            { title: '接通率', dataIndex: 'connectionRate', width: 95, align: 'right', render: formatPercent },
            { title: '平均时长', dataIndex: 'averageDurationSeconds', width: 120, align: 'right', render: formatDuration },
            { title: '最长时长', dataIndex: 'maxDurationSeconds', width: 120, align: 'right', render: formatDuration },
            { title: '总通话时长', dataIndex: 'totalDurationSeconds', width: 130, align: 'right', render: formatDuration },
          ]}
        />
      </section>
    </>
  );
}
