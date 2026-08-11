import { Alert, Button, Empty, Skeleton } from 'antd';
import { RefreshCw } from 'lucide-react';

export function PageLoading() {
  return <div className="surface"><Skeleton active paragraph={{ rows: 8 }} /></div>;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message="数据加载失败"
      description={error.message}
      action={onRetry && <Button icon={<RefreshCw size={15} />} onClick={onRetry}>重试</Button>}
    />
  );
}

export function TableEmpty({ description = '暂无符合条件的数据' }: { description?: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description} />;
}
