import { Button, DatePicker, Form, Select, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { RotateCcw, Search } from 'lucide-react';
import type { Agent, Batch, ListOptions } from '../types/domain';

const { RangePicker } = DatePicker;

interface FilterValues {
  range?: [Dayjs, Dayjs];
  agentId?: string;
  batchId?: string;
  status?: string;
}

export function CallFilters({ agents, batches, onSearch, defaultToday = false }: { agents: Agent[]; batches: Batch[]; onSearch: (query: ListOptions) => void; defaultToday?: boolean }) {
  const [form] = Form.useForm<FilterValues>();
  const initialRange: [Dayjs, Dayjs] | undefined = defaultToday ? [dayjs().startOf('day'), dayjs().endOf('day')] : undefined;

  const submit = (values: FilterValues) => onSearch({
    agentId: values.agentId,
    batchId: values.batchId,
    status: values.status,
    from: values.range?.[0].startOf('day').toISOString(),
    to: values.range?.[1].endOf('day').toISOString(),
  });

  return (
    <Form form={form} layout="inline" initialValues={{ range: initialRange }} onFinish={submit}>
      <Form.Item name="range"><RangePicker allowClear placeholder={['开始日期', '结束日期']} /></Form.Item>
      <Form.Item name="agentId"><Select allowClear showSearch optionFilterProp="label" placeholder="全部坐席" style={{ width: 150 }} options={agents.map((agent) => ({ value: agent.id, label: agent.displayName }))} /></Form.Item>
      <Form.Item name="batchId"><Select allowClear showSearch optionFilterProp="label" placeholder="全部批次" style={{ width: 160 }} options={batches.map((batch) => ({ value: batch.id, label: batch.name }))} /></Form.Item>
      <Form.Item name="status"><Select allowClear placeholder="全部结果" style={{ width: 140 }} options={[{ value: 'CONNECTED', label: '已接通' }, { value: 'NOT_CONNECTED', label: '未接通' }, { value: 'COLLECTING', label: '采集中' }, { value: 'UNKNOWN', label: '未知' }]} /></Form.Item>
      <Form.Item><Space><Button type="primary" htmlType="submit" icon={<Search size={15} />}>查询</Button><Button icon={<RotateCcw size={15} />} onClick={() => { form.resetFields(); onSearch(defaultToday ? { from: dayjs().startOf('day').toISOString(), to: dayjs().endOf('day').toISOString() } : {}); }}>重置</Button></Space></Form.Item>
    </Form>
  );
}
