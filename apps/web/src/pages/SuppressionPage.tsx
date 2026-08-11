import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tooltip } from 'antd';
import { Plus, RefreshCw, RotateCcw, Search, ShieldBan, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState } from '../components/AsyncState';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { ListOptions, SuppressionEntry } from '../types/domain';

interface SuppressionForm { phone: string; reason: string }

const sourceText: Record<SuppressionEntry['source'], string> = {
  MANUAL: '管理员手工添加',
  IMPORT: '批量导入',
  COMPLIANCE: '合规要求',
};

export function SuppressionPage() {
  const { message } = App.useApp();
  const [query, setQuery] = useState<ListOptions>({ page: 1, pageSize: 20 });
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SuppressionForm>();
  const remote = useRemote(() => api.suppression.list(query), [query.page, query.pageSize, query.search]);

  const create = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const entry = await api.suppression.create(values);
      message.success(`已加入拒呼名单，同步撤回 ${entry.withdrawnAssignments} 个未完成任务`);
      setEditorOpen(false);
      form.resetFields();
      remote.reload();
    } catch (reason) {
      if (reason instanceof Error && !('errorFields' in reason)) message.error(reason.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: SuppressionEntry) => {
    try {
      await api.suppression.remove(entry.id);
      message.success('已移出拒呼名单，原已撤回任务不会自动恢复');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '移除失败');
    }
  };

  return (
    <>
      <PageHeader title="拒呼名单" description="在导入、分配和拨号三个环节统一拦截" actions={<Button type="primary" icon={<Plus size={16} />} onClick={() => setEditorOpen(true)}>添加号码</Button>} />
      <Alert className="page-alert" type="info" showIcon message="加入名单后，该号码的未完成任务会立即撤回" description="历史客户与通话数据保留，号码在管理端仅以脱敏形式展示。" />
      <section className="surface filter-surface compact-filter"><Input.Search allowClear enterButton={<><Search size={15} /> 查询</>} placeholder="搜索手机号" style={{ maxWidth: 420 }} onSearch={(search) => setQuery((current) => ({ ...current, search, page: 1 }))} /></section>
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface table-surface">
        <div className="table-toolbar"><span><ShieldBan size={16} /> 共 <strong>{remote.data?.total ?? 0}</strong> 个拒呼号码</span><Button type="text" icon={<RefreshCw size={15} />} loading={remote.loading} onClick={remote.reload}>刷新</Button></div>
        <Table<SuppressionEntry>
          rowKey="id" loading={remote.loading} dataSource={remote.data?.items}
          columns={[
            { title: '手机号', dataIndex: 'phoneMasked', render: (value) => <span className="mono">{value}</span> },
            { title: '原因', dataIndex: 'reason' },
            { title: '来源', dataIndex: 'source', render: (source) => sourceText[source as SuppressionEntry['source']] ?? source },
            { title: '已撤回任务', dataIndex: 'withdrawnAssignments', align: 'right', render: (value) => value ?? '-' },
            { title: '操作人', dataIndex: 'createdBy' },
            { title: '加入时间', dataIndex: 'createdAt', width: 180, render: formatDateTime },
            { title: '操作', width: 70, render: (_, entry) => <Popconfirm title="确认移出拒呼名单？" description="移出后仍需手动重新分配客户。" okText="移出" cancelText="取消" onConfirm={() => remove(entry)}><Tooltip title="移出"><Button type="text" danger icon={<Trash2 size={15} />} /></Tooltip></Popconfirm> },
          ]}
          pagination={{ current: query.page, pageSize: query.pageSize, total: remote.data?.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })) }}
        />
      </section>
      <Modal title="添加拒呼号码" open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={create} confirmLoading={saving} okText="确认添加" cancelText="取消">
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}><Input maxLength={11} placeholder="号码会加密存储" /></Form.Item>
          <Form.Item name="reason" label="拒呼原因" rules={[{ required: true, message: '请输入原因' }, { max: 200 }]}><Input.TextArea rows={3} maxLength={200} showCount /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
