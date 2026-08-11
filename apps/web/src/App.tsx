import { Spin } from 'antd';
import { useEffect, type ComponentType } from 'react';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './layout/AppShell';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { CustomersPage } from './pages/CustomersPage';
import { BatchesPage } from './pages/BatchesPage';
import { AgentsPage } from './pages/AgentsPage';
import { CallsPage } from './pages/CallsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SuppressionPage } from './pages/SuppressionPage';
import { AuditPage } from './pages/AuditPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { useRouter } from './router';

const pages: Record<string, ComponentType> = {
  '/': DashboardPage,
  '/customers': CustomersPage,
  '/batches': BatchesPage,
  '/agents': AgentsPage,
  '/calls': CallsPage,
  '/reports': ReportsPage,
  '/suppression': SuppressionPage,
  '/audit': AuditPage,
};

function Redirect({ to, state }: { to: string; state?: unknown }) {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, { replace: true, state }), [navigate, state, to]);
  return null;
}

function ProtectedLayout({ path }: { path: string }) {
  const { user, loading } = useAuth();
  const Page = pages[path] ?? NotFoundPage;
  if (!loading && !user) return <Redirect to="/login" state={{ from: { pathname: path } }} />;
  if (loading) return <div className="fullscreen-loader"><Spin size="large" /></div>;
  return <AppShell><Page /></AppShell>;
}

export default function App() {
  const { user } = useAuth();
  const { path } = useRouter();
  if (path === '/login' && user) return <Redirect to="/" />;
  if (path === '/login') return <LoginPage />;
  return <ProtectedLayout path={path} />;
}
