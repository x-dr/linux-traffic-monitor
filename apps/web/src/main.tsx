import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import Application from './App';
import { SessionProvider } from './session';
import 'antd/dist/reset.css';
import './styles.css';

const cache = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15000 } } });
function Root() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light');
  useLayoutEffect(() => {
    const mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0c1220' : '#f3f6fa');
    try { localStorage.setItem('observatory-theme', mode); }
    catch { /* Theme switching still works when browser storage is unavailable. */ }
  }, [dark]);
  const toggleTheme = () => setDark(old => !old);
  return <ConfigProvider locale={zhCN} theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { colorPrimary: '#53d6b5', borderRadius: 9, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', ...(dark ? { colorBgBase: '#0c1220', colorBgContainer: '#121b2b', colorBgElevated: '#182236', colorBorder: '#29364a', colorText: '#e8edf5', colorTextSecondary: '#93a0b8' } : {}) }, components: { Layout: { bodyBg: dark ? '#0c1220' : '#f3f6fa', siderBg: dark ? '#0d1524' : '#ffffff' }, Menu: { darkItemBg: '#0d1524', darkItemSelectedBg: '#173c37', darkItemSelectedColor: '#70e7ca', itemHeight: 44 }, Table: { headerBg: dark ? '#152031' : '#f6f8fb' } } }}><AntApp><QueryClientProvider client={cache}><BrowserRouter><SessionProvider><Application dark={dark} toggleTheme={toggleTheme} /></SessionProvider></BrowserRouter></QueryClientProvider></AntApp></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
