import { Button, Result } from 'antd';
import { useRouter } from '../router';

export function NotFoundPage() {
  const { navigate } = useRouter();
  return <Result status="404" title="页面不存在" subTitle="当前地址可能已经变更" extra={<Button type="primary" onClick={() => navigate('/')}>返回工作台</Button>} />;
}
