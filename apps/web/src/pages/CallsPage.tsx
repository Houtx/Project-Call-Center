import { useState } from 'react';
import dayjs from 'dayjs';
import { App, Button, Descriptions, Modal, Space, Table, Tag, Tooltip } from 'antd';
import { Download, Eye, Headphones, PhoneCall, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { CallFilters } from '../components/CallFilters';
import { ErrorState } from '../components/AsyncState';
import { StatusTag } from '../components/StatusTag';
import { api, authenticatedBlobUrl, downloadAuthenticated } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { CallRecord, ListOptions } from '../types/domain';

const todayQuery = (): ListOptions => ({
  page: 1,
  pageSize: 20,
  from: dayjs().startOf('day').toISOString(),
  to: dayjs().endOf('day').toISOString(),
});

export function CallsPage() {
  const { message } = App.useApp();
  const [query, setQuery] = useState<ListOptions>(todayQuery);
  const [detail, setDetail] = useState<(CallRecord & { phone?: string; expiresAt?: string; recordingUrl?: string })>();
  const remote = useRemote(() => Promise.all([
    api.calls.list(query),
    api.agents.list({ page: 1, pageSize: 100 }),
    api.batches.list({ page: 1, pageSize: 200 }),
  ]), [query.page, query.pageSize, query.from, query.to, query.agentId, query.batchId, query.status]);
  const [calls, agents, batches] = remote.data ?? [];

  const closeDetail = () => {
    if (detail?.recordingUrl) URL.revokeObjectURL(detail.recordingUrl);
    setDetail(undefined);
  };

  const revealCallPhone = async (record: CallRecord) => {
    setDetail(record);
    try {
      const revealed = await api.calls.revealPhone(record.id);
      setDetail((current) => current?.id === record.id ? { ...current, ...revealed } : current);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '完整号码读取失败');
    }
  };

  return (
    <>
      <PageHeader title="通话记录" description="追踪每一次由 APP 发起的 SIM 外呼" actions={<Space><Button icon={<RefreshCw size={16} />} loading={remote.loading} onClick={remote.reload}>刷新</Button><Button icon={<Download size={16} />} onClick={() => downloadAuthenticated(api.calls.exportUrl(query), `通话记录-${Date.now()}.csv`).catch((error: Error) => message.error(error.message))}>导出</Button></Space>} />
      <section className="surface filter-surface"><CallFilters agents={agents?.items ?? []} batches={batches?.items ?? []} defaultToday onSearch={(filter) => setQuery((current) => ({ page: 1, pageSize: current.pageSize, ...filter }))} /></section>
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface table-surface">
        <div className="table-toolbar"><span><PhoneCall size={16} /> 共 <strong>{calls?.total ?? 0}</strong> 通外呼</span><span className="table-hint">未知状态不计入接通率分母</span></div>
        <Table<CallRecord>
          rowKey="id" loading={remote.loading} dataSource={calls?.items} scroll={{ x: 1250 }}
          columns={[
            { title: '发起时间', dataIndex: 'startedAt', width: 180, fixed: 'left', render: formatDateTime },
            { title: '客户', dataIndex: 'customerName', width: 130, fixed: 'left' },
            { title: '联系号码', dataIndex: 'phoneMasked', width: 140, render: (value) => <span className="mono">{value}</span> },
            { title: '坐席', dataIndex: 'agentName', width: 120 },
            { title: '批次', dataIndex: 'batchName', width: 140, render: (value) => value || '-' },
            { title: '外呼结果', dataIndex: 'status', width: 110, render: (status) => <StatusTag status={status} /> },
            { title: '通话时长', dataIndex: 'durationSeconds', width: 120, render: formatDuration },
            { title: '结束时间', dataIndex: 'endedAt', width: 180, render: formatDateTime },
            { title: '回传时间', dataIndex: 'collectedAt', width: 180, render: formatDateTime },
            { title: '录音', dataIndex: 'recording', width: 150, render: (recording: CallRecord['recording'], record: CallRecord) => recording?.status === 'READY' ? <Space><Tooltip title="在线播放"><Button type="text" icon={<Headphones size={15} />} onClick={async () => { try { const url = await authenticatedBlobUrl(api.calls.recordingUrl(record.id)); setDetail({ ...record, recordingUrl: url }); } catch (error) { message.error(error instanceof Error ? error.message : '录音读取失败'); } }} /></Tooltip><Tooltip title="下载录音"><Button type="text" icon={<Download size={15} />} onClick={() => downloadAuthenticated(api.calls.recordingDownloadUrl(record.id), `录音-${record.id}.m4a`).catch((error: Error) => message.error(error.message))} /></Tooltip></Space> : <Tag>{recording?.status === 'UNSUPPORTED' ? '设备不支持' : recording?.status === 'DELETED' ? '已清理' : recording?.status === 'FAILED' ? '失败' : recording ? '采集中' : '未开启'}</Tag> },
            { title: '操作', fixed: 'right', width: 70, render: (_, record) => <Tooltip title="查看完整号码（将记录审计）"><Button aria-label="查看完整号码" type="text" icon={<Eye size={15} />} onClick={() => revealCallPhone(record)} /></Tooltip> },
          ]}
          pagination={{ current: query.page, pageSize: query.pageSize, total: calls?.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })) }}
        />
      </section>
      <Modal title="通话详情" open={Boolean(detail)} onCancel={closeDetail} footer={<Button onClick={closeDetail}>关闭</Button>}>
        {detail && <Descriptions bordered column={1} size="small">
          <Descriptions.Item label="外呼尝试 ID"><span className="mono break-all">{detail.attemptId}</span></Descriptions.Item>
          <Descriptions.Item label="客户">{detail.customerName}</Descriptions.Item>
          <Descriptions.Item label="完整号码">{detail.phone ? <strong className="revealed-phone">{detail.phone}</strong> : '正在读取...'}</Descriptions.Item>
          <Descriptions.Item label="坐席">{detail.agentName}</Descriptions.Item>
          <Descriptions.Item label="结果"><StatusTag status={detail.status} /></Descriptions.Item>
          <Descriptions.Item label="发起时间">{formatDateTime(detail.startedAt)}</Descriptions.Item>
          <Descriptions.Item label="结束时间">{formatDateTime(detail.endedAt)}</Descriptions.Item>
          <Descriptions.Item label="通话时长">{formatDuration(detail.durationSeconds)}</Descriptions.Item>
          <Descriptions.Item label="数据回传">{formatDateTime(detail.collectedAt)}</Descriptions.Item>
          <Descriptions.Item label="录音">{detail.recording?.status === 'READY' ? detail.recordingUrl ? <audio controls preload="metadata" src={detail.recordingUrl} style={{ width: '100%' }} /> : '正在读取录音...' : detail.recording?.status === 'DELETED' ? '已按保留策略清理' : detail.recording?.status === 'UNSUPPORTED' ? '该设备无法采集系统通话音频' : detail.recording ? '录音尚未就绪' : '该坐席未开启录音'}</Descriptions.Item>
        </Descriptions>}
      </Modal>
    </>
  );
}
