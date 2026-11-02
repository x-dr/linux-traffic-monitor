import { useState } from 'react';
import { Alert, App, Button, Form, Input } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { PageTitle } from './components';
import NotificationSettings from './NotificationSettings';
import { useSession } from './session';

export default function SettingsPage() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const { message } = App.useApp(), cache = useQueryClient(), { session } = useSession();
  const change = async (values: { current_password: string; password: string }) => {
    setError(''); setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: JSON.stringify({ current_password: values.current_password, password: values.password }) });
      cache.setQueryData(['session'], null); window.dispatchEvent(new Event('session-expired')); message.success('密码已更新，请重新登录');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <><PageTitle eyebrow="WORKSPACE SETTINGS" title="系统设置" subtitle="管理后台访问与数据策略。节点采集配置在各节点详情页调整。" /><div className="settings-grid"><section className="panel"><span className="section-kicker">ACCOUNT SECURITY</span><h2>管理员密码</h2><p className="muted">当前账号：{session?.username}。修改密码后所有会话失效。</p>{error && <Alert showIcon type="error" title={error} />}<Form layout="vertical" onFinish={change}><Form.Item name="current_password" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="password" label="新密码" rules={[{ required: true, min: 12, max: 256, message: '密码须为 12～256 个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item><Form.Item name="confirm" label="确认新密码" dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator(_, value) { return value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')); } })]}><Input.Password autoComplete="new-password" /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>更新密码</Button></Form></section><section className="panel"><span className="section-kicker">DATA POLICY</span><h2>数据与采集</h2><div className="policy-row"><span>资源分钟记录</span><strong>30 天</strong></div><div className="policy-row"><span>流量分钟与累计</span><strong>长期保存</strong></div><div className="policy-row"><span>网络采样间隔</span><strong>1 秒</strong></div><div className="policy-row"><span>资源采样与上报</span><strong>5 秒</strong></div><div className="policy-row"><span>陈旧 / 离线阈值</span><strong>15 秒 / 45 秒</strong></div><Alert type="info" showIcon title="数据由你掌握" description="中心和 Agent 均使用本地 SQLite。备份与迁移请遵循部署文档中的一致性备份流程。" /></section></div><NotificationSettings /></>;
}
