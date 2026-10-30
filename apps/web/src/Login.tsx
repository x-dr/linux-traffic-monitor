import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { LockOutlined, UserOutlined, RadarChartOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setCsrf } from './api';
import type { Session } from './session';

export default function Login() {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const cache = useQueryClient();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ initialized: boolean }>('/auth/setup-status'), retry: false });
  const login = async (values: { username: string; password: string }) => {
    setError(''); setBusy(true);
    try {
      const session = await api<Session>('/auth/login', { method: 'POST', body: JSON.stringify(values) });
      setCsrf(session.csrf); cache.setQueryData(['session'], session);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <main className="login-page"><div className="login-story"><div className="brand"><div className="brand-mark"><RadarChartOutlined /></div><div>Observatory<span>VPS MONITOR</span></div></div><div className="login-message"><div className="eyebrow">A CLEAR VIEW OF YOUR INFRASTRUCTURE</div><h1>每一台服务器，<br />尽在视野之中<span>。</span></h1><p>从实时资源到每一个流量周期，<br />让分散在各地的 VPS，汇聚于一处。</p><div className="orbit"><i /><i /><i /><RadarChartOutlined /></div></div><div className="login-foot">轻量采集 · 实时推送 · 数据自主掌握</div></div><div className="login-form-wrap"><div className="login-form"><span className="section-kicker">WELCOME BACK</span><h2>登录监控后台</h2><p className="muted">连接你的服务器，掌握运行全貌。</p>{setup.data?.initialized === false && <Alert type="info" showIcon title="需要初始化管理员" description="请在中心服务终端运行 npm run admin 设置账号密码。" />}{error && <Alert type="error" showIcon title={error} />}<Form layout="vertical" onFinish={login} autoComplete="on"><Form.Item name="username" label="管理员账号" rules={[{ required: true, message: '请输入账号' }]}><Input prefix={<UserOutlined />} size="large" autoComplete="username" placeholder="输入管理员账号" /></Form.Item><Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input.Password prefix={<LockOutlined />} size="large" autoComplete="current-password" placeholder="输入密码" /></Form.Item><Button block type="primary" size="large" htmlType="submit" loading={busy}>登录后台</Button></Form><div className="login-security"><SafetyCertificateOutlined /> 独立会话保护 · 安全访问</div></div></div></main>;
}
