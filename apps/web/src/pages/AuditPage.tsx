import { useState } from 'react';
import { Button, DatePicker, Form, Input, Select, Space, Table } from 'antd';
import type { Dayjs } from 'dayjs';
import { ClipboardList, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState } from '../components/AsyncState';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { AuditEvent, ListOptions } from '../types/domain';

interface AuditFilter { search?: string; action?: string; resourceType?: string; range?: [Dayjs, Dayjs] }

const actionLabels: Record<string, string> = {
  AUTH_LOGIN: '管理员登录',
  CUSTOMER_CREATED: '新增客户',
  CUSTOMER_UPDATED: '编辑客户',
  CUSTOMER_PHONE_REVEALED: '查看完整号码',
  CALL_PHONE_REVEALED: '查看通话完整号码',
  MOBILE_CALL_HISTORY_PHONE_REVEALED: '坐席查看历史完整号码',
  CUSTOMERS_ASSIGNED: '分配客户',
  CUSTOMERS_RETRY_ASSIGNED: '重新派发未接通客户',
  CUSTOMERS_BULK_ASSIGNED: '批量分配客户',
  CUSTOMERS_BULK_RETRY_ASSIGNED: '批量重新派发未接通客户',
  ASSIGNMENTS_RECLAIMED: '回收客户',
  ASSIGNMENTS_REASSIGNED: '改派客户',
  CUSTOMER_IMPORT_COMMITTED: '导入客户',
  SUPPRESSION_ADDED: '添加拒呼号码',
  MOBILE_DEVICE_LOGIN: '坐席手机登录',
  DEVICE_REVOKED: '撤销设备',
  AGENT_CREATED: '新增坐席',
  AGENT_UPDATED: '更新坐席',
  AGENT_PASSWORD_RESET: '重置坐席密码',
  SUPPRESSION_REVOKED: '移出拒呼名单',
  CUSTOMERS_EXPORTED: '导出客户',
  CALLS_EXPORTED: '导出通话',
};

export function AuditPage() {
  const [query, setQuery] = useState<ListOptions & { action?: string; resourceType?: string }>({ page: 1, pageSize: 20 });
  const [form] = Form.useForm<AuditFilter>();
  const remote = useRemote(() => api.audit.list(query), [query.page, query.pageSize, query.search, query.action, query.resourceType, query.from, query.to]);

  const submit = (values: AuditFilter) => setQuery({
    page: 1,
    pageSize: query.pageSize,
    search: values.search,
    action: values.action,
    resourceType: values.resourceType,
    from: values.range?.[0].startOf('day').toISOString(),
    to: values.range?.[1].endOf('day').toISOString(),
  });

  return (
    <>
      <PageHeader title="审计日志" description="记录敏感数据查看与管理操作" actions={<Button icon={<RefreshCw size={16} />} loading={remote.loading} onClick={remote.reload}>刷新</Button>} />
      <section className="surface filter-surface">
        <Form form={form} layout="inline" onFinish={submit}>
          <Form.Item name="search"><Input allowClear prefix={<Search size={15} />} placeholder="操作人 / 说明" /></Form.Item>
          <Form.Item name="action"><Select allowClear placeholder="全部操作" style={{ width: 180 }} options={Object.entries(actionLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
          <Form.Item name="resourceType"><Select allowClear placeholder="资源类型" style={{ width: 140 }} options={[{ value: 'customer', label: '客户' }, { value: 'assignment', label: '分配' }, { value: 'user', label: '坐席' }, { value: 'device', label: '设备' }, { value: 'suppression_entry', label: '拒呼名单' }, { value: 'import_job', label: '导入任务' }]} /></Form.Item>
          <Form.Item name="range"><DatePicker.RangePicker placeholder={['开始日期', '结束日期']} /></Form.Item>
          <Form.Item><Space><Button type="primary" htmlType="submit" icon={<Search size={15} />}>查询</Button><Button icon={<RotateCcw size={15} />} onClick={() => { form.resetFields(); setQuery({ page: 1, pageSize: query.pageSize }); }}>重置</Button></Space></Form.Item>
        </Form>
      </section>
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface table-surface">
        <div className="table-toolbar"><span><ClipboardList size={16} /> 共 <strong>{remote.data?.total ?? 0}</strong> 条操作记录</span><span className="table-hint">日志中不记录完整手机号</span></div>
        <Table<AuditEvent>
          rowKey="id" loading={remote.loading} dataSource={remote.data?.items}
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 180, render: formatDateTime },
            { title: '操作人', dataIndex: 'actorName', width: 120 },
            { title: '操作', dataIndex: 'action', width: 180, render: (value) => actionLabels[value] ?? value },
            { title: '操作说明', dataIndex: 'summary' },
            { title: '资源类型', dataIndex: 'resourceType', width: 130 },
            { title: '资源 ID', dataIndex: 'resourceId', width: 180, ellipsis: true, render: (value) => value ? <span className="mono">{value}</span> : '-' },
            { title: 'IP 地址', dataIndex: 'ipAddress', width: 140, render: (value) => value || '-' },
          ]}
          pagination={{ current: query.page, pageSize: query.pageSize, total: remote.data?.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })) }}
        />
      </section>
    </>
  );
}
