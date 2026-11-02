import { useState } from 'react';
import { App as AntApp, Button, Drawer, Layout, Menu, Tooltip } from 'antd';
import { BellOutlined, DashboardOutlined, CloudServerOutlined, PlusCircleOutlined, SettingOutlined, RadarChartOutlined, LogoutOutlined, MenuOutlined, SunOutlined, MoonOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useSession } from './session';
import Login from './Login';
import OverviewPage from './Overview';
import NodesPage from './Nodes';
import NodeDetail from './NodeDetail';
import ConnectPage from './Connect';
import SettingsPage from './Settings';
import AlertsPage from './Alerts';
import ProbesPage from './Probes';
import { LoadingState } from './components';
import WorkspaceBreadcrumb from './WorkspaceBreadcrumb';

const items = [
  { key: '/overview', icon: <DashboardOutlined />, label: '全局概览' },
  { key: '/nodes', icon: <CloudServerOutlined />, label: 'VPS 管理' },
  { key: '/alerts', icon: <BellOutlined />, label: '告警中心' },
  { key: '/probes', icon: <RadarChartOutlined />, label: '网络探测' },
  { key: '/connect', icon: <PlusCircleOutlined />, label: '接入服务器' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];
export default function Application({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
  const { session, pending } = useSession(), cache = useQueryClient();
  const { message } = AntApp.useApp();
  const location = useLocation(), navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('observatory-sidebar-collapsed') === 'true'; }
    catch { return false; }
  });
  const connection = useQuery({ queryKey: ['connection'], queryFn: () => false, enabled: false });
  const selected = location.pathname.startsWith('/nodes/') ? '/nodes' : location.pathname;
  const nav = <><Link to="/overview" className="brand"><div className="brand-mark"><RadarChartOutlined /></div>{!collapsed && <div>Observatory<span>VPS MONITOR</span></div>}</Link><div className="nav-caption">{collapsed ? '···' : 'WORKSPACE'}</div><Menu theme={dark ? 'dark' : 'light'} mode="inline" selectedKeys={[selected]} items={items} onClick={({ key }) => { navigate(key); setDrawer(false); }} /><div className="sidebar-footer"><span className="live-dot" />{!collapsed && <span>你的基础设施，清晰可见。<small>PRIVATE MONITORING SPACE</small></span>}</div></>;
  if (!pending && !session) return <Login />;
  const toggleSidebar = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem('observatory-sidebar-collapsed', String(next)); }
    catch { /* Navigation still works when browser storage is unavailable. */ }
  };
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST' }); cache.setQueryData(['session'], null); window.dispatchEvent(new Event('session-expired')); }
    catch (error) { message.error((error as Error).message); }
  };
  return <Layout className="app-layout" hasSider>
    <Layout.Sider className="desktop-sidebar" width={238} collapsedWidth={80} collapsed={collapsed} theme={dark ? 'dark' : 'light'}>{nav}</Layout.Sider>
    <Drawer title="工作区导航" placement="left" open={drawer} onClose={() => setDrawer(false)} size={280}>{nav}</Drawer>
    <Layout>
      <header className="topbar">
        <div className="topbar-left">
          <Button className="mobile-menu" type="text" icon={<MenuOutlined />} aria-label="打开导航" onClick={() => setDrawer(true)} />
          <Button className="desktop-menu" type="text" icon={<MenuOutlined />} aria-label={collapsed ? '展开导航' : '折叠导航'} aria-expanded={!collapsed} onClick={toggleSidebar} />
          <WorkspaceBreadcrumb enabled={Boolean(session)} pageLabel={items.find(i => i.key === selected)?.label || '全局概览'} />
        </div>
        <div className="topbar-right">
          <span className={`connection-state ${connection.data ? 'connected' : ''}`}><i />{pending ? '正在加载' : connection.data ? '实时数据已连接' : '正在重连'}</span>
          <Tooltip title={dark ? '切换浅色主题' : '切换深色主题'}><Button type="text" aria-label="切换主题" icon={dark ? <SunOutlined /> : <MoonOutlined />} onClick={toggleTheme} /></Tooltip>
          <div className="user-badge">{session?.username[0]?.toUpperCase() || '…'}</div>
          <Tooltip title="退出登录"><Button type="text" aria-label="退出登录" disabled={pending} icon={<LogoutOutlined />} onClick={() => { void logout(); }} /></Tooltip>
        </div>
      </header>
      <main className="main-content">
        {pending ? <LoadingState metrics={location.pathname === '/' || location.pathname === '/overview' || location.pathname.startsWith('/nodes/')} /> : <Routes>
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/nodes/:id" element={<NodeDetail />} />
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/probes" element={<ProbesPage />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>}
        <footer className="workspace-footer"><span>OBSERVATORY <span className="footer-dot">·</span> VPS MONITOR</span><span>轻量采集，持续洞察</span></footer>
      </main>
    </Layout>
  </Layout>;
}
