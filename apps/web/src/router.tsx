import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

interface RouterValue {
  path: string;
  state: unknown;
  navigate: (to: string, options?: NavigateOptions) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

const currentLocation = () => ({ path: window.location.pathname, state: window.history.state as unknown });

export function RouterProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState(currentLocation);

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, options?: NavigateOptions) => {
    const method = options?.replace ? 'replaceState' : 'pushState';
    window.history[method](options?.state ?? null, '', to);
    setLocation(currentLocation());
  }, []);

  const value = useMemo(() => ({ ...location, navigate }), [location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const router = useContext(RouterContext);
  if (!router) throw new Error('useRouter must be used within RouterProvider');
  return router;
}
