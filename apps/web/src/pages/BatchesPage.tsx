import { useState } from 'react';
import { App, Button, Form, Input, Modal, Progress, Space, Table, Tooltip } from 'antd';
import { Layers3, Pencil, Plus, RefreshCw, Search } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState } from '../components/AsyncState';
import { api } from '../lib/api';
import { formatDateTime, numberFormat } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { Batch } from '../types/domain';

interface BatchForm { name: string; code?: string; notes?: string }

export function BatchesPage() {
  const { message } = App.useApp();
  const [query, setQuery] = useState({ page: 1, pageSize: 15, search: '' });
  const [editor, setEditor] = useState<{ open: boolean; batch?: Batch }>({ open: false });
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<BatchForm>();
  const remote = useRemote(() => api.batches.list(query), [query.page, query.pageSize, query.search]);

  const openEditor = (batch?: Batch) => {
    setEditor({ open: true, batch });
    form.setFieldsValue(batch ? { name: batch.name, code: batch.code, notes: batch.notes } : { name: '', code: '', notes: '' });
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editor.batch) {
        await api.batches.update(editor.batch.id, values);
        message.success('批次已更新');
      } else {
        await api.batches.create(values);
        message.success('批次已创建');
      }
      setEditor({ open: false });
      remote.reload();
    } catch (reason) {
      if (reason instanceof Error && !('errorFields' in reason)) message.error(reason.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader title="批次管理" description="按来源组织客户数据与分配进度" actions={<Button type="primary" icon={<Plus size={16} />} onClick={() => openEditor()}>新建批次</Button>} />
      <section className="surface filter-surface compact-filter">
        <Input.Search allowClear enterButton={<><Search size={15} /> 查询</>} placeholder="批次名称或编码" style={{ maxWidth: 420 }} onSearch={(search) => setQuery((current) => ({ ...current, search, page: 1 }))} />
      </section>
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface table-surface">
        <div className="table-toolbar"><span><Layers3 size={16} /> 共 <strong>{remote.data?.total ?? 0}</strong> 个批次</span><Button type="text" icon={<RefreshCw size={15} />} loading={remote.loading} onClick={remote.reload}>刷新</Button></div>
        <Table<Batch>
          rowKey="id"
          loading={remote.loading}
          dataSource={remote.data?.items}
          columns={[
            { title: '批次名称', dataIndex: 'name', render: (name, row) => <div className="primary-cell"><strong>{name}</strong><small>{row.notes || '无备注'}</small></div> },
            { title: '编码', dataIndex: 'code', render: (value) => value ? <span className="mono">{value}</span> : '-' },
            { title: '客户数', dataIndex: 'customerCount', align: 'right', render: numberFormat.format },
            { title: '分配进度', width: 230, render: (_, row) => { const percent = row.customerCount ? Math.round(row.assignedCount / row.customerCount * 100) : 0; return <div className="progress-cell"><Progress percent={percent} size="small" /><small>{row.assignedCount} / {row.customerCount}</small></div>; } },
            { title: '已完成', dataIndex: 'completedCount', align: 'right', render: numberFormat.format },
            { title: '创建时间', dataIndex: 'createdAt', width: 180, render: formatDateTime },
            { title: '操作', width: 80, render: (_, batch) => <Tooltip title="编辑批次"><Button type="text" icon={<Pencil size={15} />} onClick={() => openEditor(batch)} /></Tooltip> },
          ]}
          pagination={{ current: query.page, pageSize: query.pageSize, total: remote.data?.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })) }}
        />
      </section>
      <Modal title={editor.batch ? '编辑批次' : '新建批次'} open={editor.open} onCancel={() => setEditor({ open: false })} onOk={save} confirmLoading={saving} okText="保存" cancelText="取消">
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="name" label="批次名称" rules={[{ required: true, message: '请输入批次名称' }, { max: 80 }]}><Input placeholder="例如：2026 年 8 月客户" /></Form.Item>
          <Form.Item name="code" label="批次编码" rules={[{ max: 32 }, { pattern: /^[A-Za-z0-9_-]*$/, message: '仅支持字母、数字、下划线和连字符' }]}><Input placeholder="选填，例如 AUG-2026" /></Form.Item>
          <Form.Item name="notes" label="备注"><Input.TextArea rows={3} maxLength={300} showCount /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
