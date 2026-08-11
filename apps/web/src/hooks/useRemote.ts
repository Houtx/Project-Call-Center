import { useCallback, useEffect, useState } from 'react';

export function useRemote<T>(loader: () => Promise<T>, dependencies: unknown[]) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    loader()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason : new Error('数据加载失败'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
    // Pages pass stable primitive dependencies; loader is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, revision]);

  return { data, loading, error, reload };
}
