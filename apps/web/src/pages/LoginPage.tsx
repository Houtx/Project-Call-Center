import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { Headphones, LockKeyhole, UserRound } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useRouter } from '../router';

export function LoginPage() {
  const { login } = useAuth();
  const { navigate, state } = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    setError('');
    try {
      await login(values.username, values.password);
      const target = (state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';
      navigate(target, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-intro">
        <div className="login-brand"><Headphones size={28} /><span>座席中心</span></div>
        <div className="login-copy">
          <span className="eyebrow">SIM CALL OPERATIONS</span>
          <h1>外呼任务，<br />清楚到每一通。</h1>
          <p>集中管理客户、坐席与通话数据，让分配和追踪保持同一节奏。</p>
        </div>
        <div className="login-foot">企业内部系统 · 所有操作均记录审计</div>
      </section>
      <section className="login-panel">
        <div className="login-form-wrap">
          <Typography.Title level={2}>管理员登录</Typography.Title>
          <Typography.Paragraph type="secondary">请使用管理账号进入工作台</Typography.Paragraph>
          {error && <Alert className="login-error" type="error" showIcon message={error} />}
          <Form layout="vertical" size="large" onFinish={submit} requiredMark={false}>
            <Form.Item label="账号" name="username" rules={[{ required: true, message: '请输入管理账号' }]}>
              <Input prefix={<UserRound size={17} />} autoComplete="username" placeholder="请输入账号" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }, { min: 10, message: '密码至少 10 位' }]}>
              <Input.Password prefix={<LockKeyhole size={17} />} autoComplete="current-password" placeholder="请输入密码" />
            </Form.Item>
            <Button type="primary" htmlType="submit" loading={submitting} block>登录</Button>
          </Form>
          <div className="login-security"><LockKeyhole size={14} />请勿在公共设备上保存登录凭据</div>
        </div>
      </section>
    </main>
  );
}
