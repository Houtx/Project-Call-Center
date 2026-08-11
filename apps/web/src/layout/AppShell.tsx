import { useEffect, useState, type ReactNode } from 'react';
import { Avatar, Button, Dropdown, Layout, Menu, Space, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  BarChart3,
  BookUser,
  ChevronDown,
  ClipboardList,
  Headphones,
  LayoutDashboard,
  Layers3,
  Menu as MenuIcon,
  PhoneCall,
  ShieldBan,
  Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { HealthIndicator } from '../components/HealthIndicator';
import { useRouter } from '../router';

const { Header, Sider, Content } = Layout;

const navItems: NonNullable<MenuProps['items']> = [
  { key: '/', icon: <LayoutDashboard size={17} />, label: '工作台' },
  { key: '/customers', icon: <BookUser size={17} />, label: '客户资料' },
  { key: '/batches', icon: <Layers3 size={17} />, label: '批次管理' },
  { key: '/agents', icon: <Users size={17} />, label: '坐席与设备' },
  { key: '/calls', icon: <PhoneCall size={17} />, label: '通话记录' },
  { key: '/reports', icon: <BarChart3 size={17} />, label: '数据报表' },
  { key: '/suppression', icon: <ShieldBan size={17} />, label: '拒呼名单' },
  { key: '/audit', icon: <ClipboardList size={17} />, label: '审计日志' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { navigate, path } = useRouter();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const listener = () => setCollapsed(window.innerWidth < 980);
    listener();
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, []);

  const userMenu: MenuProps['items'] = [
    { key: 'profile', label: `${user?.displayName ?? ''} · 管理员`, disabled: true },
    { type: 'divider' },
    { key: 'logout', label: '退出登录', danger: true },
  ];

  const selectedKey = navItems
    .map((item) => String(item && 'key' in item ? item.key : ''))
    .filter((key) => key !== '/' && path.startsWith(key))
    .sort((a, b) => b.length - a.length)[0] ?? '/';

  return (
    <Layout className="app-layout">
      <Sider className="app-sider" width={232} collapsedWidth={72} collapsed={collapsed} trigger={null}>
        <div className="brand">
          <span className="brand-mark"><Headphones size={22} /></span>
          {!collapsed && <span><strong>座席中心</strong><small>SIM Call CRM</small></span>}
        </div>
        <Menu
          className="main-nav"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={navItems}
          onClick={({ key }) => navigate(key)}
        />
        {!collapsed && <HealthIndicator />}
      </Sider>
      <Layout>
        <Header className="app-header">
          <Tooltip title={collapsed ? '展开菜单' : '收起菜单'}>
            <Button type="text" className="menu-toggle" icon={<MenuIcon size={20} />} onClick={() => setCollapsed((value) => !value)} aria-label="切换菜单" />
          </Tooltip>
          <div className="header-right">
            <Typography.Text type="secondary" className="date-label">管理后台</Typography.Text>
            <Dropdown menu={{ items: userMenu, onClick: ({ key }) => key === 'logout' && logout() }} placement="bottomRight">
              <Button type="text" className="user-button">
                <Space><Avatar size={30}>{user?.displayName?.slice(0, 1)}</Avatar><span>{user?.displayName}</span><ChevronDown size={14} /></Space>
              </Button>
            </Dropdown>
          </div>
        </Header>
        <Content className="app-content">{children}</Content>
      </Layout>
    </Layout>
  );
}
