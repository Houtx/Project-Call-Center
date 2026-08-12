import { useEffect, useState } from 'react';
import { App, Badge, Button, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag, Tooltip } from 'antd';
import { KeyRound, Plus, RefreshCw, Settings2, ShieldCheck, Smartphone, Unlink, UserRound } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { ErrorState } from '../components/AsyncState';
import { StatusTag } from '../components/StatusTag';
import { api } from '../lib/api';
import { formatDateTime, formatPercent } from '../lib/format';
import { useRemote } from '../hooks/useRemote';
import type { Agent, AllowedDeviceModel, Device, MobileAppPolicy } from '../types/domain';

interface AgentForm { username: string; displayName: string; password: string }
interface DeviceModelForm { manufacturer: string; model: string; androidSdk: number; notes?: string }
type PolicyForm = Pick<MobileAppPolicy, 'minimumVersionCode' | 'latestVersionCode' | 'forceUpgrade' | 'deviceCompatibilityRequired' | 'maxCallAttempts' | 'recordingRetentionDays'> & { downloadUrl?: string };

export function AgentsPage() {
  const { message } = App.useApp();
  const [query, setQuery] = useState({ page: 1, pageSize: 20 });
  const [editorOpen, setEditorOpen] = useState(false);
  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<AgentForm>();
  const [modelForm] = Form.useForm<DeviceModelForm>();
  const [policyForm] = Form.useForm<PolicyForm>();
  const remote = useRemote(() => Promise.all([
    api.agents.list(query),
    api.agents.devices(),
    api.agents.deviceModels(),
    api.agents.mobilePolicy(),
  ]), [query.page, query.pageSize]);
  const [agents, devices, deviceModels, mobilePolicy] = remote.data ?? [];
  useEffect(() => {
    if (!mobilePolicy) return;
    policyForm.setFieldsValue({
      minimumVersionCode: mobilePolicy.minimumVersionCode,
      latestVersionCode: mobilePolicy.latestVersionCode,
      forceUpgrade: mobilePolicy.forceUpgrade,
      deviceCompatibilityRequired: mobilePolicy.deviceCompatibilityRequired ?? true,
      maxCallAttempts: mobilePolicy.maxCallAttempts ?? 2,
      recordingRetentionDays: mobilePolicy.recordingRetentionDays ?? 30,
      downloadUrl: mobilePolicy.downloadUrl ?? undefined,
    });
  }, [mobilePolicy, policyForm]);
  const agentRows = agents?.items.map((agent) => ({
    ...agent,
    device: devices?.find((device) => device.agentId === agent.id && device.active) ?? null,
  })) ?? [];

  const create = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await api.agents.create(values);
      message.success('坐席账号已创建');
      setEditorOpen(false);
      form.resetFields();
      remote.reload();
    } catch (reason) {
      if (reason instanceof Error && !('errorFields' in reason)) message.error(reason.message);
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (agent: Agent, enabled: boolean) => {
    try {
      await api.agents.setEnabled(agent.id, enabled);
      message.success(enabled ? '坐席已启用' : '坐席已停用');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '操作失败');
    }
  };

  const revoke = async (device: Device) => {
    try {
      await api.agents.revokeDevice(device.id);
      message.success('设备已撤销，坐席可直接在其他手机登录');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '撤销失败');
    }
  };

  const createDeviceModel = async () => {
    const values = await modelForm.validateFields();
    setSaving(true);
    try {
      await api.agents.addDeviceModel(values);
      message.success('白名单机型已启用');
      setModelEditorOpen(false);
      modelForm.resetFields();
      remote.reload();
    } catch (reason) {
      if (reason instanceof Error && !('errorFields' in reason)) message.error(reason.message);
    } finally {
      setSaving(false);
    }
  };

  const setModelEnabled = async (model: AllowedDeviceModel, enabled: boolean) => {
    try {
      await api.agents.updateDeviceModel(model.id, { enabled });
      message.success(enabled ? '机型已启用' : '机型已停用，相关设备将不能继续外呼');
      remote.reload();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : '操作失败');
    }
  };

  const saveMobilePolicy = async () => {
    const values = await policyForm.validateFields();
    setSaving(true);
    try {
      await api.agents.updateMobilePolicy({ ...values, downloadUrl: values.downloadUrl || undefined });
      message.success('APP 与外呼策略已保存');
      remote.reload();
    } catch (reason) {
      if (reason instanceof Error && !('errorFields' in reason)) message.error(reason.message);
    } finally {
      setSaving(false);
    }
  };

  const deviceColumns = [
    { title: '设备', render: (_: unknown, device: Device) => <div className="device-name"><span className="device-avatar"><Smartphone size={18} /></span><div><strong>{device.brand} {device.model}</strong><small>Android {device.androidVersion}</small></div></div> },
    { title: '坐席', dataIndex: 'agentName' },
    { title: 'APP 版本', dataIndex: 'appVersion' },
    { title: '设备状态', dataIndex: 'health', render: (status: string) => <StatusTag status={status} /> },
    { title: '拨号权限', dataIndex: 'permissionCallPhone', render: (value: boolean) => <Badge status={value ? 'success' : 'error'} text={value ? '已授权' : '未授权'} /> },
    { title: '通话记录权限', dataIndex: 'permissionReadCallLog', render: (value: boolean) => <Badge status={value ? 'success' : 'error'} text={value ? '已授权' : '未授权'} /> },
    { title: '录音权限', dataIndex: 'permissionRecordAudio', render: (value: boolean) => <Badge status={value ? 'success' : 'warning'} text={value ? '已授权' : '未授权'} /> },
    { title: '最近在线', dataIndex: 'lastSeenAt', render: formatDateTime },
    { title: '操作', width: 80, render: (_: unknown, device: Device) => device.active ? <Popconfirm title="确认撤销设备？" description="撤销后该设备将立即失去访问权限。" onConfirm={() => revoke(device)} okText="撤销" cancelText="取消"><Button type="text" danger icon={<Unlink size={15} />}>撤销</Button></Popconfirm> : '-' },
  ];

  return (
    <>
      <PageHeader title="坐席与设备" description="管理坐席账号、单设备绑定和 APP 权限健康" actions={<Space><Button icon={<RefreshCw size={16} />} loading={remote.loading} onClick={remote.reload}>刷新</Button><Button type="primary" icon={<Plus size={16} />} onClick={() => setEditorOpen(true)}>新增坐席</Button></Space>} />
      {remote.error && <ErrorState error={remote.error} onRetry={remote.reload} />}
      <section className="surface tabs-surface">
        <Tabs items={[
          {
            key: 'agents', label: `坐席账号 ${agents?.total ?? 0}`, children: <Table<Agent>
              rowKey="id" loading={remote.loading} dataSource={agentRows}
              columns={[
                { title: '坐席', render: (_, row) => <div className="primary-cell"><strong>{row.displayName}</strong><small>@{row.username}</small></div> },
                { title: '状态', dataIndex: 'enabled', render: (enabled, row) => <Popconfirm title={enabled ? '停用后坐席将无法登录' : '确认启用该坐席'} onConfirm={() => setEnabled(row, !enabled)} okText="确认" cancelText="取消"><Switch size="small" checked={enabled} checkedChildren="启用" unCheckedChildren="停用" /></Popconfirm> },
                { title: '待外呼', dataIndex: 'pendingCount', align: 'right' },
                { title: '今日外呼', dataIndex: 'todayAttempts', align: 'right', render: (value) => value ?? '-' },
                { title: '今日接通率', render: (_, row) => row.todayAttempts === undefined || row.todayConnected === undefined ? '-' : formatPercent(row.todayAttempts ? row.todayConnected / row.todayAttempts : 0) },
                { title: '录音', dataIndex: 'recordingEnabled', render: (enabled: boolean, row: Agent) => <Switch size="small" checked={enabled} checkedChildren="开启" unCheckedChildren="关闭" onChange={async (checked) => { try { await api.agents.update(row.id, { recordingEnabled: checked }); message.success(checked ? '已开启该坐席录音' : '已关闭该坐席录音'); remote.reload(); } catch (error) { message.error(error instanceof Error ? error.message : '录音设置失败'); } }} /> },
                { title: '绑定设备', dataIndex: 'device', render: (device) => device ? <Space><Smartphone size={15} />{device.brand} {device.model}<StatusTag status={device.health} /></Space> : <Tag>未绑定</Tag> },
                { title: '创建时间', dataIndex: 'createdAt', render: formatDateTime },
                { title: '操作', width: 150, render: (_, row) => row.device ? <Popconfirm title="确认撤销当前设备？" description="撤销后该手机将立即下线，坐席可直接重新登录。" onConfirm={() => revoke(row.device!)} okText="撤销" cancelText="取消"><Tooltip title="撤销设备"><Button type="text" danger icon={<Unlink size={15} />} /></Tooltip></Popconfirm> : <Tag>登录后自动绑定</Tag> },
              ]}
              pagination={{ current: query.page, pageSize: query.pageSize, total: agents?.total, showSizeChanger: true, onChange: (page, pageSize) => setQuery({ page, pageSize }) }}
            />,
          },
          { key: 'devices', label: `设备记录 ${devices?.length ?? 0}`, children: <Table<Device> rowKey="id" loading={remote.loading} dataSource={devices} columns={deviceColumns} pagination={false} scroll={{ x: 1050 }} /> },
          {
            key: 'compatibility',
            label: `兼容策略 ${deviceModels?.filter((item) => item.enabled).length ?? 0}`,
            children: <div className="compatibility-settings">
              <section className="policy-pane">
                <div className="section-heading"><div><h2>APP 与外呼策略</h2><p>统一控制版本、设备兼容和单个客户的外呼次数</p></div><Settings2 size={18} /></div>
                <Form form={policyForm} layout="vertical" requiredMark={false} onFinish={saveMobilePolicy}>
                  <div className="two-column-form">
                    <Form.Item name="minimumVersionCode" label="最低版本号" rules={[{ required: true }]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
                    <Form.Item name="latestVersionCode" label="最新版本号" dependencies={['minimumVersionCode']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value >= getFieldValue('minimumVersionCode') ? Promise.resolve() : Promise.reject(new Error('不能低于最低版本号')) })]}><InputNumber min={1} precision={0} style={{ width: '100%' }} /></Form.Item>
                    <Form.Item className="form-span-2" name="maxCallAttempts" label="单个客户最大外呼次数" rules={[{ required: true, message: '请设置最大外呼次数' }]} extra="未接通或结果未知达到上限后，该客户将自动完成；默认 2 次。"><InputNumber min={1} max={10} precision={0} addonAfter="次" style={{ width: '100%' }} /></Form.Item>
                    <Form.Item className="form-span-2" name="recordingRetentionDays" label="录音保留天数" rules={[{ required: true, message: '请设置录音保留天数' }]} extra="Worker 每分钟清理超过此期限的录音文件，只保留通话记录元数据。"><InputNumber min={1} max={365} precision={0} addonAfter="天" style={{ width: '100%' }} /></Form.Item>
                    <Form.Item className="form-span-2" name="downloadUrl" label="APK 下载地址" rules={[{ type: 'url', message: '请输入完整 HTTPS 地址' }, { pattern: /^https:\/\//, message: '正式下载地址必须使用 HTTPS' }]}><Input placeholder="https://call.example.com/download/app.apk" /></Form.Item>
                    <Form.Item className="form-span-2" name="forceUpgrade" label="强制升级" valuePropName="checked" extra="开启后，低于最新版本号的 APP 必须升级后才能登录和外呼。"><Switch checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item>
                    <Form.Item
                      className="form-span-2"
                      name="deviceCompatibilityRequired"
                      label="设备兼容校验"
                      valuePropName="checked"
                      extra="关闭后跳过品牌、型号和 Android API 白名单；Android 12+、版本和通话权限仍需满足。"
                    >
                      <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                    </Form.Item>
                  </div>
                  <Button type="primary" htmlType="submit" loading={saving}>保存版本策略</Button>
                </Form>
              </section>
              <section className="models-pane">
                <div className="section-heading"><div><h2>机型白名单</h2><p>仅精确匹配品牌、型号和 Android API 的设备可登录和外呼</p></div><Button icon={<Plus size={15} />} onClick={() => setModelEditorOpen(true)}>新增机型</Button></div>
                <Table<AllowedDeviceModel>
                  rowKey="id"
                  size="small"
                  loading={remote.loading}
                  dataSource={deviceModels}
                  pagination={false}
                  scroll={{ x: 680 }}
                  columns={[
                    { title: '品牌', dataIndex: 'manufacturer' },
                    { title: '型号', dataIndex: 'model' },
                    { title: 'Android API', dataIndex: 'androidSdk', align: 'right' },
                    { title: '说明', dataIndex: 'notes', render: (value) => value || '-' },
                    { title: '状态', dataIndex: 'enabled', render: (enabled) => <Tag color={enabled ? 'green' : 'default'}>{enabled ? '已启用' : '已停用'}</Tag> },
                    { title: '操作', width: 90, render: (_, row) => <Popconfirm title={row.enabled ? '停用后相关设备将立即无法外呼' : '确认重新启用该机型'} onConfirm={() => setModelEnabled(row, !row.enabled)} okText="确认" cancelText="取消"><Button type="text" danger={row.enabled}>{row.enabled ? '停用' : '启用'}</Button></Popconfirm> },
                  ]}
                />
              </section>
            </div>,
          },
        ]} />
      </section>
      <Modal title="新增坐席" open={editorOpen} onCancel={() => setEditorOpen(false)} onOk={create} confirmLoading={saving} okText="创建账号" cancelText="取消">
        <Descriptions size="small" column={1} className="modal-guidance"><Descriptions.Item label="设备规则">账号在 APP 登录后自动绑定当前设备；在新手机登录会立即顶掉旧手机。</Descriptions.Item></Descriptions>
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="displayName" label="坐席姓名" rules={[{ required: true, message: '请输入坐席姓名' }, { max: 40 }]}><Input prefix={<UserRound size={16} />} /></Form.Item>
          <Form.Item name="username" label="登录账号" rules={[{ required: true, message: '请输入登录账号' }, { pattern: /^[a-zA-Z0-9_.-]{4,32}$/, message: '4-32 位字母、数字或 _ . -' }]}><Input /></Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, message: '请输入初始密码' }, { min: 10, message: '至少 10 位' }]}><Input.Password prefix={<KeyRound size={16} />} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="新增白名单机型" open={modelEditorOpen} onCancel={() => setModelEditorOpen(false)} onOk={createDeviceModel} confirmLoading={saving} okText="启用机型" cancelText="取消">
        <p className="modal-note"><ShieldCheck size={15} /> 仅添加已按真机验收清单完整验证的品牌、型号和系统版本。</p>
        <Form form={modelForm} layout="vertical" requiredMark={false}>
          <div className="two-column-form">
            <Form.Item name="manufacturer" label="系统品牌标识" rules={[{ required: true, message: '请输入 Build.MANUFACTURER' }]}><Input placeholder="例如 Xiaomi" /></Form.Item>
            <Form.Item name="model" label="系统型号标识" rules={[{ required: true, message: '请输入 Build.MODEL' }]}><Input placeholder="例如 23127PN0CC" /></Form.Item>
            <Form.Item name="androidSdk" label="Android API" rules={[{ required: true }]}><InputNumber min={31} max={99} precision={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="notes" label="验收说明"><Input placeholder="测试日期、系统版本等" /></Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}
