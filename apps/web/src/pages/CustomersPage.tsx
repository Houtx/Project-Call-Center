import { useMemo, useRef, useState } from 'react';
import {
  App,
  Button,
  Descriptions,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import {
  Archive,
  ChevronDown,
  Download,
  Eye,
  FileSpreadsheet,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  RotateCcw,
  Search,
  SendToBack,
  UploadCloud,
  UserX,
  UserRoundCheck,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState } from '../components/AsyncState';
import { StatusTag } from '../components/StatusTag';
import { ApiError, api, downloadAuthenticated } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type {
  BulkAssignmentInput,
  BulkAssignmentPreview,
  BulkAssignmentScope,
  Customer,
  CustomerDetail,
  CustomerInput,
  ImportPreview,
  ListOptions,
} from '../types/domain';

type CustomerFormValues = CustomerInput & { tagsText?: string };
type BulkAssignmentFormValues = {
  targetAgentIds: string[];
  quantity?: number;
};

const defaultQuery: ListOptions = { page: 1, pageSize: 15, status: 'ACTIVE' };

export function CustomersPage() {
  const { message, modal } = App.useApp();
  const [query, setQuery] = useState<ListOptions>(defaultQuery);
  const [selectedIds, setSelectedIds] = useState<React.Key[]>([]);
  const [editor, setEditor] = useState<{ open: boolean; customer?: Customer }>({ open: false });
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignMode, setAssignMode] = useState<'ASSIGN' | 'RETRY'>('ASSIGN');
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkScope, setBulkScope] = useState<BulkAssignmentScope>('FILTER');
  const [bulkPreview, setBulkPreview] = useState<BulkAssignmentPreview>();
  const [bulkPreviewLoading, setBulkPreviewLoading] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importBatchId, setImportBatchId] = useState<string>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [importing, setImporting] = useState(false);
  const [detail, setDetail] = useState<{ customer?: CustomerDetail; loading: boolean }>({ loading: false });
  const [eraseTarget, setEraseTarget] = useState<Customer>();
  const [eraseReason, setEraseReason] = useState('');
  const [duplicateMode, setDuplicateMode] = useState<'SKIP' | 'UPDATE'>('SKIP');
  const [saving, setSaving] = useState(false);
  const [attributing, setAttributing] = useState(false);
  const attributionRequest = useRef(0);
  const bulkPreviewRequest = useRef(0);
  const [editorForm] = Form.useForm<CustomerFormValues>();
  const [assignForm] = Form.useForm<{ agentId: string }>();
  const [bulkAssignForm] = Form.useForm<BulkAssignmentFormValues>();
  const [filterForm] = Form.useForm();
  const bulkTargetIds: string[] = Form.useWatch('targetAgentIds', bulkAssignForm) ?? [];
  const requestedBulkCount = Math.max(0, Number(Form.useWatch('quantity', bulkAssignForm)) || 0);

  const remote = useRemote(
    () => Promise.all([
      api.customers.list(query),
      api.batches.list({ page: 1, pageSize: 200 }),
      api.agents.list({ page: 1, pageSize: 100 }),
    ]),
    [query.page, query.pageSize, query.search, query.status, query.batchId, query.agentId, query.assignmentStatus],
  );

  const [customers, batches, agents] = remote.data ?? [];
  const rows = customers?.items ?? [];
  const agentsById = useMemo(
    () => new Map(agents?.items.map((agent) => [agent.id, agent]) ?? []),
    [agents],
  );
  const bulkAllocationPlan = useMemo(() => {
    if (!bulkTargetIds.length || requestedBulkCount < 1) return new Map<string, number>();
    const average = Math.floor(requestedBulkCount / bulkTargetIds.length);
    const remainder = requestedBulkCount % bulkTargetIds.length;
    return new Map(bulkTargetIds.map((agentId, index) => [
      agentId,
      average + (index < remainder ? 1 : 0),
    ]));
  }, [bulkTargetIds, requestedBulkCount]);

  const openEditor = (customer?: Customer) => {
    attributionRequest.current += 1;
    setAttributing(false);
    setEditor({ open: true, customer });
    editorForm.resetFields();
    editorForm.setFieldsValue(customer ? {
      name: customer.name,
      phone: '',
      batchId: customer.batch?.id,
      province: customer.province,
      city: customer.city,
      carrier: customer.carrier,
      notes: customer.notes,
      tagsText: customer.tags.join(', '),
    } : { name: '', phone: '', tagsText: '' });
  };

  const fillPhoneAttribution = async () => {
    if (editor.customer) return;
    const phone = editorForm.getFieldValue('phone')?.trim();
    if (!/^1\d{10}$/.test(phone)) return;
    const current = editorForm.getFieldsValue(['province', 'city', 'carrier']);
    if (current.province && current.city && current.carrier) return;

    const requestId = ++attributionRequest.current;
    setAttributing(true);
    try {
      const attribution = await api.customers.phoneAttribution(phone);
      if (requestId !== attributionRequest.current || editorForm.getFieldValue('phone')?.trim() !== phone) return;
      const latest = editorForm.getFieldsValue(['province', 'city', 'carrier']);
      editorForm.setFieldsValue({
        province: latest.province || attribution.province,
        city: latest.city || attribution.city,
        carrier: latest.carrier || attribution.carrier,
      });
    } catch {
      // Saving still performs the same lookup on the server.
    } finally {
      if (requestId === attributionRequest.current) setAttributing(false);
    }
  };

  const saveCustomer = async () => {
    const values = await editorForm.validateFields();
    setSaving(true);
    try {
      const input: CustomerInput = {
        ...values,
        phone: values.phone,
        tags: values.tagsText?.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      };
      delete (input as CustomerFormValues).tagsText;
      if (editor.customer) {
        const { phone: _phone, ...updates } = input;
        await api.customers.update(editor.customer.id, { ...updates, version: editor.customer.version });
        message.success('客户资料已更新');
      } else {
        await api.customers.create(input);
        message.success('客户已新增');
      }
      setEditor({ open: false });
      remote.reload();
    } catch (reason) {
      const code = reason instanceof ApiError && reason.details && typeof reason.details === 'object'
        ? (reason.details as { code?: string }).code
        : undefined;
      if (editor.customer && code === 'VERSION_CONFLICT') {
        message.warning('该客户已被其他管理员修改，列表已刷新，请重新编辑');
        setEditor({ open: false });
        remote.reload();
      } else if (reason instanceof Error && !('errorFields' in reason)) {
        message.error(reason.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const archiveCustomer = async (customer: Customer) => {
    try {
      await api.customers.archive(customer.id);
      message.success('客户已归档');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '归档失败');
    }
  };

  const revealPhone = async (customer: Customer) => {
    try {
      const result = await api.customers.revealPhone(customer.id);
      modal.info({
        title: '查看完整号码',
        content: (
          <Descriptions column={1} bordered size="small">
            <Descriptions.Item label="客户">{customer.name}</Descriptions.Item>
            <Descriptions.Item label="完整号码"><strong className="revealed-phone">{result.phone}</strong></Descriptions.Item>
            <Descriptions.Item label="有效期">{formatDateTime(result.expiresAt)}</Descriptions.Item>
          </Descriptions>
        ),
        okText: '我知道了',
      });
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '号码获取失败');
    }
  };

  const openHistory = async (customer: Customer) => {
    setDetail({ loading: true });
    try {
      setDetail({ customer: await api.customers.get(customer.id), loading: false });
    } catch (reason) {
      setDetail({ loading: false });
      message.error(reason instanceof Error ? reason.message : '分配历史加载失败');
    }
  };

  const eraseCustomer = async () => {
    if (!eraseTarget || eraseReason.trim().length < 2) return;
    setSaving(true);
    try {
      await api.customers.erase(eraseTarget.id, eraseReason.trim());
      message.success('客户个人数据已依法删除，匿名统计与审计记录已保留');
      setEraseTarget(undefined);
      setEraseReason('');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '依法删除失败');
    } finally {
      setSaving(false);
    }
  };

  const assign = async () => {
    const { agentId } = await assignForm.validateFields();
    setSaving(true);
    try {
      const result = assignMode === 'RETRY'
        ? await api.customers.retryAssign(selectedIds.map(String), agentId)
        : await api.customers.assign(selectedIds.map(String), agentId);
      message.success(assignMode === 'RETRY'
        ? `已重新派发 ${result.assigned} 位未接通客户`
        : `已分配 ${result.assigned} 位客户`);
      setSelectedIds([]);
      setAssignOpen(false);
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '分配失败');
    } finally {
      setSaving(false);
    }
  };

  const makeBulkInput = (agentIds: string[], quantity: number): BulkAssignmentInput => ({
    scope: bulkScope,
    agentIds,
    quantity,
    ...(bulkScope === 'FILTER'
      ? {
          search: query.search,
          status: query.status,
          batchId: query.batchId,
          agentId: query.agentId,
          assignmentStatus: query.assignmentStatus,
          phone: query.phone,
        }
      : {}),
  });

  const previewBulkAssignment = async (targetAgentIds?: string[], totalQuantity?: number | null) => {
    const selected: string[] = targetAgentIds ?? bulkAssignForm.getFieldValue('targetAgentIds') ?? [];
    const quantity = totalQuantity === undefined
      ? Number(bulkAssignForm.getFieldValue('quantity'))
      : Number(totalQuantity);
    if (!selected.length || !Number.isInteger(quantity) || quantity < selected.length) {
      bulkPreviewRequest.current += 1;
      setBulkPreview(undefined);
      setBulkPreviewLoading(false);
      return;
    }
    const requestId = ++bulkPreviewRequest.current;
    setBulkPreviewLoading(true);
    try {
      const nextPreview = await api.customers.bulkPreview(makeBulkInput(selected, quantity));
      if (requestId === bulkPreviewRequest.current) setBulkPreview(nextPreview);
    } catch (reason) {
      if (requestId === bulkPreviewRequest.current) {
        setBulkPreview(undefined);
        message.error(reason instanceof Error ? reason.message : '预览分配范围失败');
      }
    } finally {
      if (requestId === bulkPreviewRequest.current) setBulkPreviewLoading(false);
    }
  };

  const changeBulkTargets = (targetAgentIds: string[]) => {
    const currentQuantity = Number(bulkAssignForm.getFieldValue('quantity')) || 0;
    const quantity = targetAgentIds.length ? Math.max(currentQuantity, targetAgentIds.length) : undefined;
    bulkAssignForm.setFieldsValue({ targetAgentIds, quantity });
    void previewBulkAssignment(targetAgentIds, quantity);
  };

  const changeBulkQuantity = (quantity: number | null) => {
    void previewBulkAssignment(bulkTargetIds, quantity);
  };

  const openBulkAssignment = (scope: BulkAssignmentScope) => {
    setBulkScope(scope);
    bulkPreviewRequest.current += 1;
    setBulkPreview(undefined);
    bulkAssignForm.resetFields();
    setBulkAssignOpen(true);
  };

  const bulkAssign = async () => {
    const { targetAgentIds, quantity } = await bulkAssignForm.validateFields();
    const requestedCount = Number(quantity);
    if (!bulkPreview) {
      await previewBulkAssignment(targetAgentIds, requestedCount);
      return;
    }
    if (requestedCount > bulkPreview.assignableCount) {
      message.error(`计划分配 ${requestedCount.toLocaleString()} 位，超过当前可分配的 ${bulkPreview.assignableCount.toLocaleString()} 位`);
      return;
    }
    setSaving(true);
    try {
      const result = await api.customers.bulkAssign(makeBulkInput(targetAgentIds, requestedCount));
      message.success(query.assignmentStatus === 'NOT_CONNECTED' && bulkScope === 'FILTER'
        ? `已按计划向 ${result.allocations.length} 名坐席重新派发 ${result.requestedCount} 位未接通客户`
        : `已按计划向 ${result.allocations.length} 名坐席分配 ${result.requestedCount} 位客户`);
      setBulkAssignOpen(false);
      setBulkPreview(undefined);
      setSelectedIds([]);
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '批量分配失败');
    } finally {
      setSaving(false);
    }
  };

  const withdraw = () => modal.confirm({
    title: `确认回收 ${selectedIds.length} 位客户？`,
    content: '未完成的坐席任务将立即撤回，已有外呼历史不受影响。',
    okText: '确认回收',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      const result = await api.customers.withdraw(selectedIds.map(String));
      message.success(`已回收 ${result.withdrawn} 位客户`);
      setSelectedIds([]);
      remote.reload();
    },
  });

  const previewUpload: UploadProps['beforeUpload'] = async (file) => {
    if (!importBatchId) {
      message.warning('请先选择本次导入的批次');
      return false;
    }
    setImporting(true);
    setPreview(undefined);
    try {
      setPreview(await api.customers.importPreview(file, importBatchId));
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '文件解析失败');
    } finally {
      setImporting(false);
    }
    return false;
  };

  const downloadImportTemplate = () => {
    void downloadAuthenticated(api.customers.importTemplateUrl(), '客户导入空模板.xlsx')
      .catch((error: Error) => message.error(error.message));
  };

  const commitImport = async () => {
    if (!preview) return;
    setImporting(true);
    try {
      const result = await api.customers.importCommit(preview.importId, duplicateMode);
      message.success(`导入完成：新增 ${result.created}，更新 ${result.updated}，跳过 ${result.skipped}`);
      setImportOpen(false);
      setPreview(undefined);
      setImportBatchId(undefined);
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const columns: TableColumnsType<Customer> = useMemo(() => [
    { title: '编号', dataIndex: 'sequence', width: 86, fixed: 'left', render: (value: number | undefined) => value ?? '-' },
    { title: '客户名称', dataIndex: 'name', width: 150, fixed: 'left', ellipsis: true },
    { title: '联系号码', dataIndex: 'phoneMasked', width: 150, render: (phone: string, customer) => <Space size={4}><span className="mono">{phone}</span>{!customer.erasedAt && <Tooltip title="查看将记录审计"><Button aria-label="查看完整号码" type="text" size="small" icon={<Eye size={14} />} onClick={() => revealPhone(customer)} /></Tooltip>}</Space> },
    { title: '地区', width: 130, render: (_, row) => [row.province, row.city].filter(Boolean).join(' / ') || '-' },
    { title: '运营商', dataIndex: 'carrier', width: 110, render: (value) => value || '-' },
    { title: '标签', dataIndex: 'tags', width: 180, render: (tags: string[]) => tags.length ? tags.slice(0, 2).map((tag) => <Tag key={tag}>{tag}</Tag>) : '-' },
    { title: '批次', dataIndex: 'batch', width: 130, render: (batch) => batch?.name ?? '-' },
    { title: '分配状态', dataIndex: 'assignmentStatus', width: 110, render: (status) => <StatusTag status={status} /> },
    { title: '分配坐席', dataIndex: 'assignedAgent', width: 130, render: (agent) => agent?.displayName ?? '-' },
    { title: '外呼次数', dataIndex: 'attemptCount', width: 100, align: 'right' },
    { title: '最近外呼', dataIndex: 'lastCalledAt', width: 180, render: formatDateTime },
    { title: '创建时间', dataIndex: 'createdAt', width: 180, render: formatDateTime },
    {
      title: '操作', key: 'actions', fixed: 'right', width: 152,
      render: (_, customer) => <Space size={2}>
        <Tooltip title="分配历史"><Button type="text" icon={<History size={15} />} aria-label="查看分配历史" onClick={() => openHistory(customer)} /></Tooltip>
        {!customer.erasedAt && <Tooltip title="编辑"><Button type="text" icon={<Pencil size={15} />} aria-label="编辑客户" onClick={() => openEditor(customer)} /></Tooltip>}
        {customer.status === 'ACTIVE' && <Popconfirm title="归档后将不再参与分配" okText="归档" cancelText="取消" onConfirm={() => archiveCustomer(customer)}><Tooltip title="归档"><Button type="text" danger icon={<Archive size={15} />} aria-label="归档客户" /></Tooltip></Popconfirm>}
        {customer.status === 'ARCHIVED' && !customer.erasedAt && <Tooltip title="依法删除个人数据"><Button type="text" danger icon={<UserX size={15} />} aria-label="依法删除个人数据" onClick={() => { setEraseTarget(customer); setEraseReason(''); }} /></Tooltip>}
      </Space>,
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  return (
    <>
      <PageHeader
        title="客户资料"
        description="维护客户、批次与坐席分配关系"
        actions={<Space wrap>
          <Button icon={<UploadCloud size={16} />} onClick={() => { setImportOpen(true); setPreview(undefined); setImportBatchId(undefined); setDuplicateMode('SKIP'); }}>导入</Button>
          <Button icon={<Download size={16} />} onClick={() => downloadAuthenticated(api.customers.exportUrl(query), `客户资料-${Date.now()}.csv`).catch((error: Error) => message.error(error.message))}>导出</Button>
          <Dropdown
            menu={{
              items: [
                { key: 'FILTER', label: '根据当前搜索结果分配' },
                { key: 'ALL', label: '全部可分配数据' },
              ],
              onClick: ({ key }) => openBulkAssignment(key as BulkAssignmentScope),
            }}
            trigger={['click']}
          >
            <Button type="primary" icon={<UserRoundCheck size={16} />}>分配 <ChevronDown size={14} /></Button>
          </Dropdown>
          <Button type="primary" icon={<Plus size={16} />} onClick={() => openEditor()}>新增客户</Button>
        </Space>}
      />
      <section className="surface filter-surface">
        <Form form={filterForm} layout="inline" initialValues={{ status: 'ACTIVE' }} onFinish={(values) => { setSelectedIds([]); setQuery({ ...defaultQuery, ...values, page: 1 }); }}>
          <Form.Item name="search"><Input allowClear prefix={<Search size={15} />} placeholder="客户名称 / 手机号" /></Form.Item>
          <Form.Item name="batchId"><Select allowClear showSearch optionFilterProp="label" placeholder="全部批次" style={{ width: 160 }} options={batches?.items.map((batch) => ({ value: batch.id, label: batch.name }))} /></Form.Item>
          <Form.Item name="agentId"><Select allowClear showSearch optionFilterProp="label" placeholder="全部坐席" style={{ width: 150 }} options={agents?.items.map((agent) => ({ value: agent.id, label: agent.displayName }))} /></Form.Item>
          <Form.Item name="assignmentStatus"><Select allowClear placeholder="分配状态" style={{ width: 160 }} options={[{ value: 'UNASSIGNED', label: '未分配' }, { value: 'ASSIGNED', label: '待外呼' }, { value: 'NOT_CONNECTED', label: '已呼未接通' }, { value: 'COMPLETED', label: '已完成' }, { value: 'WITHDRAWN', label: '已撤回' }]} /></Form.Item>
          <Form.Item name="status"><Select style={{ width: 120 }} options={[{ value: 'ACTIVE', label: '正常' }, { value: 'ARCHIVED', label: '已归档' }]} /></Form.Item>
          <Form.Item><Space><Button type="primary" htmlType="submit" icon={<Search size={15} />}>查询</Button><Button icon={<RotateCcw size={15} />} onClick={() => { filterForm.resetFields(); setSelectedIds([]); setQuery(defaultQuery); }}>重置</Button></Space></Form.Item>
        </Form>
      </section>
      {selectedIds.length > 0 && <div className="selection-bar"><span>已选 <strong>{selectedIds.length}</strong> 项</span><Space>{query.assignmentStatus === 'NOT_CONNECTED'
        ? <Button type="primary" icon={<Repeat2 size={16} />} onClick={() => { setAssignMode('RETRY'); assignForm.resetFields(); setAssignOpen(true); }}>重新派发</Button>
        : <><Button type="primary" icon={<UserRoundCheck size={16} />} onClick={() => { setAssignMode('ASSIGN'); assignForm.resetFields(); setAssignOpen(true); }}>分配坐席</Button><Button danger icon={<SendToBack size={16} />} onClick={withdraw}>回收任务</Button></>}
        <Button type="text" onClick={() => setSelectedIds([])}>取消选择</Button></Space></div>}
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface table-surface">
        <div className="table-toolbar"><span>共 <strong>{customers?.total ?? 0}</strong> 位客户</span><Button type="text" icon={<RefreshCw size={15} />} loading={remote.loading} onClick={remote.reload}>刷新</Button></div>
        <Table<Customer>
          rowKey="id"
          loading={remote.loading}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 1700 }}
          rowSelection={{ selectedRowKeys: selectedIds, onChange: setSelectedIds, preserveSelectedRowKeys: true }}
          pagination={{ current: query.page, pageSize: query.pageSize, total: customers?.total, showSizeChanger: true, showTotal: (total) => `共 ${total} 条`, onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })) }}
        />
      </section>

      <Modal title={editor.customer ? '编辑客户' : '新增客户'} open={editor.open} onCancel={() => setEditor({ open: false })} onOk={saveCustomer} confirmLoading={saving} okText="保存" cancelText="取消" width={640} destroyOnHidden>
        <Form form={editorForm} layout="vertical" requiredMark="optional" className="two-column-form">
          <Form.Item name="name" label="客户名称" rules={[{ required: true, message: '请输入客户名称' }, { max: 80 }]}><Input /></Form.Item>
          <Form.Item name="phone" label={editor.customer ? '手机号（不可修改）' : '手机号'} extra={editor.customer ? '为保持号码去重与历史连续性，需更换号码时请新增客户。' : undefined} rules={editor.customer ? [] : [{ required: true, message: '请输入手机号' }, { pattern: /^1\d{10}$/, message: '请输入 11 位手机号' }]}><Input disabled={Boolean(editor.customer)} placeholder={editor.customer?.phoneMasked} maxLength={11} onBlur={fillPhoneAttribution} suffix={attributing ? <Spin size="small" /> : undefined} /></Form.Item>
          <Form.Item name="batchId" label="批次"><Select allowClear showSearch optionFilterProp="label" options={batches?.items.map((batch) => ({ value: batch.id, label: batch.name }))} /></Form.Item>
          <Form.Item name="carrier" label="运营商"><Select allowClear options={['中国移动', '中国联通', '中国电信', '中国广电'].map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="province" label="省份"><Input /></Form.Item>
          <Form.Item name="city" label="城市"><Input /></Form.Item>
          <Form.Item name="tagsText" label="标签" className="form-span-2"><Input placeholder="多个标签用逗号分隔" /></Form.Item>
          <Form.Item name="notes" label="备注" className="form-span-2"><Input.TextArea rows={3} maxLength={500} showCount /></Form.Item>
        </Form>
      </Modal>

      <Modal title={assignMode === 'RETRY' ? '重新派发未接通客户' : '分配给坐席'} open={assignOpen} onCancel={() => setAssignOpen(false)} onOk={assign} confirmLoading={saving} okText={assignMode === 'RETRY' ? '确认重新派发' : '确认分配'} cancelText="取消">
        <p className="modal-note">{assignMode === 'RETRY'
          ? <>将 <strong>{selectedIds.length}</strong> 位最新外呼未接通的客户重新派发。原外呼与分配历史保留，新坐席获得新的重试次数。</>
          : <>将 <strong>{selectedIds.length}</strong> 位客户分配给指定坐席。已分配客户将改派，历史分配记录保留。</>}</p>
        <Form form={assignForm} layout="vertical"><Form.Item name="agentId" label="目标坐席" rules={[{ required: true, message: '请选择坐席' }]}><Select showSearch optionFilterProp="label" placeholder="选择坐席" options={agents?.items.filter((agent) => agent.enabled).map((agent) => ({ value: agent.id, label: `${agent.displayName} · 待呼 ${agent.pendingCount}` }))} /></Form.Item></Form>
      </Modal>

      <Modal
        title={bulkScope === 'FILTER' && query.assignmentStatus === 'NOT_CONNECTED' ? '批量重新派发未接通客户' : bulkScope === 'FILTER' ? '根据当前搜索结果分配' : '全部可分配数据'}
        width={640}
        open={bulkAssignOpen}
        onCancel={() => { bulkPreviewRequest.current += 1; setBulkAssignOpen(false); setBulkPreview(undefined); }}
        onOk={bulkAssign}
        confirmLoading={saving}
        okText={bulkScope === 'FILTER' && query.assignmentStatus === 'NOT_CONNECTED' ? '确认重新派发' : '确认分配'}
        cancelText="取消"
        okButtonProps={{
          disabled: bulkPreviewLoading || !bulkPreview || bulkPreview.assignableCount === 0
            || requestedBulkCount < bulkTargetIds.length || requestedBulkCount > bulkPreview.assignableCount,
        }}
      >
        <p className="modal-note">
          {bulkScope === 'FILTER'
            ? '范围使用当前客户列表的搜索和筛选条件，提交时服务端会重新计算。'
            : '范围忽略当前搜索和筛选条件，仅包含可分配客户；提交时服务端会重新计算。'}
        </p>
        <Form form={bulkAssignForm} layout="vertical">
          <Form.Item name="targetAgentIds" label="目标坐席" rules={[{ required: true, message: '请至少选择一名坐席' }]}>
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              maxTagCount="responsive"
              placeholder="选择一名或多名坐席"
              onChange={changeBulkTargets}
              options={agents?.items.filter((agent) => agent.enabled).map((agent) => ({ value: agent.id, label: `${agent.displayName} · 待呼 ${agent.pendingCount}` }))}
            />
          </Form.Item>
          <Form.Item
            name="quantity"
            label="总分配数量"
            rules={[
              { required: true, message: '请输入总分配数量' },
              { type: 'number', min: Math.max(bulkTargetIds.length, 1), message: `至少分配 ${Math.max(bulkTargetIds.length, 1)} 位` },
            ]}
          >
            <InputNumber
              min={Math.max(bulkTargetIds.length, 1)}
              max={bulkPreview?.assignableCount}
              precision={0}
              controls
              suffix="位"
              disabled={!bulkTargetIds.length}
              onChange={changeBulkQuantity}
              style={{ width: '100%' }}
            />
          </Form.Item>
          {bulkTargetIds.length > 0 && <div className="allocation-list">
            {bulkTargetIds.map((agentId) => {
              const agent = agentsById.get(agentId);
              return <div className="allocation-row" key={agentId}>
                <div className="allocation-agent">
                  <strong>{agent?.displayName ?? '未知坐席'}</strong>
                  <span>@{agent?.username ?? '-'} · 当前待呼 {agent?.pendingCount ?? 0}</span>
                </div>
                <div className="allocation-quantity"><strong>{(bulkAllocationPlan.get(agentId) ?? 0).toLocaleString()}</strong> 位</div>
              </div>;
            })}
          </div>}
        </Form>
        {bulkPreviewLoading ? <div className="modal-note"><Spin size="small" /> 正在计算可分配数据…</div> : bulkPreview && <Descriptions size="small" bordered column={1}>
          <Descriptions.Item label="匹配数据">{bulkPreview.matchedCount.toLocaleString()} 位</Descriptions.Item>
          <Descriptions.Item label="可分配数据"><strong>{bulkPreview.assignableCount.toLocaleString()} 位</strong></Descriptions.Item>
          <Descriptions.Item label="本次计划">
            <strong className={requestedBulkCount > bulkPreview.assignableCount ? 'allocation-over-limit' : undefined}>
              {requestedBulkCount.toLocaleString()} 位 / {bulkTargetIds.length} 名坐席
            </strong>
          </Descriptions.Item>
          <Descriptions.Item label="本次不处理">{Math.max(bulkPreview.assignableCount - requestedBulkCount, 0).toLocaleString()} 位</Descriptions.Item>
          <Descriptions.Item label="将跳过">{bulkPreview.skippedCount.toLocaleString()} 位（归档、拒呼或其他不可分配状态）</Descriptions.Item>
        </Descriptions>}
      </Modal>

      <Modal title="客户分配历史" width={760} open={detail.loading || Boolean(detail.customer)} onCancel={() => setDetail({ loading: false })} footer={<Button onClick={() => setDetail({ loading: false })}>关闭</Button>}>
        {detail.loading ? <div className="modal-note">正在加载...</div> : detail.customer && <>
          <Descriptions size="small" bordered column={2}>
            <Descriptions.Item label="客户">{detail.customer.name}</Descriptions.Item>
            <Descriptions.Item label="号码">{detail.customer.phoneMasked}</Descriptions.Item>
          </Descriptions>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={detail.customer.assignmentHistory}
            locale={{ emptyText: '暂无分配记录' }}
            columns={[
              { title: '状态', dataIndex: 'status', width: 100, render: (status: string) => <StatusTag status={status} /> },
              { title: '坐席', dataIndex: ['agent', 'displayName'], width: 130 },
              { title: '分配人', dataIndex: ['assignedBy', 'displayName'], width: 120, render: (value?: string) => value ?? '-' },
              { title: '分配时间', dataIndex: 'assignedAt', width: 170, render: formatDateTime },
              { title: '结束时间', dataIndex: 'endedAt', width: 170, render: formatDateTime },
            ]}
          />
        </>}
      </Modal>

      <Modal
        title="依法删除客户个人数据"
        open={Boolean(eraseTarget)}
        onCancel={() => { setEraseTarget(undefined); setEraseReason(''); }}
        onOk={eraseCustomer}
        confirmLoading={saving}
        okText="确认永久删除"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: eraseReason.trim().length < 2 }}
      >
        <p className="modal-note">此操作会永久擦除姓名、完整号码、地区、运营商、备注和标签，无法恢复；匿名通话统计、分配记录和删除审计将保留。</p>
        <Input.TextArea value={eraseReason} onChange={(event) => setEraseReason(event.target.value)} rows={3} maxLength={500} showCount placeholder="填写依法删除原因（必填）" />
      </Modal>

      <Modal
        title="导入客户"
        width={980}
        open={importOpen}
        onCancel={() => { setImportOpen(false); setPreview(undefined); setImportBatchId(undefined); }}
        footer={preview ? [
          <Button key="cancel" onClick={() => { setImportOpen(false); setPreview(undefined); setImportBatchId(undefined); }}>取消</Button>,
          <Button key="back" onClick={() => setPreview(undefined)}>重新选择</Button>,
          <Button key="commit" type="primary" loading={importing} disabled={!preview.newCount && duplicateMode === 'SKIP'} onClick={commitImport}>确认导入</Button>,
        ] : null}
      >
        {!preview ? <div className="import-entry">
          <div className="import-setup">
            <Form.Item label="本次导入批次" required>
              <Select
                value={importBatchId}
                onChange={setImportBatchId}
                showSearch
                optionFilterProp="label"
                placeholder="选择批次"
                options={batches?.items.map((batch) => ({
                  value: batch.id,
                  label: batch.code ? `${batch.name} · ${batch.code}` : batch.name,
                }))}
              />
            </Form.Item>
            <div className="import-template-action">
              <span>空白模板</span>
              <Button icon={<Download size={16} />} onClick={downloadImportTemplate}>下载 Excel 模板</Button>
            </div>
          </div>
          <Upload.Dragger accept=".xlsx,.csv" maxCount={1} showUploadList={false} beforeUpload={previewUpload} disabled={importing || !importBatchId}>
            <p className="ant-upload-drag-icon"><FileSpreadsheet size={42} /></p>
            <p className="ant-upload-text">{importing ? '正在分析文件…' : '点击或将 Excel / CSV 拖到此处'}</p>
            <p className="ant-upload-hint">文件必须且只能包含“姓名”和“手机号”两列；单次行数上限由服务器配置。</p>
          </Upload.Dragger>
        </div> : <div className="import-preview">
          <div className="import-summary"><div><span>文件</span><strong>{preview.fileName}</strong></div><div><span>导入批次</span><strong>{preview.batchName}</strong></div><div><span>总行数</span><strong>{preview.total}</strong></div><div className="good"><span>可新增</span><strong>{preview.newCount}</strong></div><div><span>重复</span><strong>{preview.duplicateCount}</strong></div><div className="bad"><span>无效 / 拒呼</span><strong>{preview.invalidCount + preview.suppressedCount}</strong></div></div>
          <div className="duplicate-choice"><span>重复号码处理</span><Radio.Group value={duplicateMode} onChange={(event) => setDuplicateMode(event.target.value)}><Radio value="SKIP">跳过（推荐）</Radio><Radio value="UPDATE">更新姓名、批次及自动识别资料</Radio></Radio.Group></div>
          <Table size="small" rowKey="rowNumber" scroll={{ x: 860 }} pagination={{ pageSize: 6, hideOnSinglePage: true }} dataSource={preview.rows} columns={[{ title: '行', dataIndex: 'rowNumber', width: 60 }, { title: '姓名', dataIndex: 'name', width: 120, render: (value) => value || '-' }, { title: '号码', dataIndex: 'phoneMasked', width: 130 }, { title: '地区', width: 150, render: (_, row) => [row.province, row.city].filter(Boolean).join(' / ') || '-' }, { title: '运营商', dataIndex: 'carrier', width: 120, render: (value) => value || '-' }, { title: '预检结果', dataIndex: 'result', width: 100, render: (result) => <Tag color={result === 'NEW' ? 'green' : result === 'DUPLICATE' ? 'blue' : 'red'}>{{ NEW: '可新增', DUPLICATE: '重复', INVALID: '无效', SUPPRESSED: '拒呼' }[result as string]}</Tag> }, { title: '说明', dataIndex: 'message', width: 140, render: (value) => value || '-' }]} />
        </div>}
      </Modal>
    </>
  );
}
