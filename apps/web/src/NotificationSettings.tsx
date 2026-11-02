import { useDrawerFocus } from './useDrawerFocus';
import { useState } from 'react';
import { App, Alert, Button, Drawer, Form, Input, Switch, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ChannelView } from '@traffic/contracts';
import { monitoring } from './monitoring-api';
import { ErrorState } from './components';
import DeliveryList from './DeliveryList';
import './monitoring.css';

export default function NotificationSettings() {
  const [editing, setEditing] = useState<ChannelView | 'new' | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const rememberFocus = useDrawerFocus(!!editing);
  const { message } = App.useApp();
  const query = useQuery({ queryKey: ['channels'], queryFn: monitoring.channels, refetchInterval: 5000 });
  const selected = editing && editing !== 'new' ? editing : null;
  const save = async (input: { name: string; enabled: boolean; url?: string; authorization?: string; clear_authorization?: boolean }) => {
    setBusy('save'); setError('');
    try {
      await monitoring.saveChannel({ name: input.name, enabled: input.enabled, ...(input.url ? { url: input.url } : {}),
        ...(input.clear_authorization ? { authorization: '' } : input.authorization ? { authorization: input.authorization } : {}) }, selected?.id);
      await query.refetch(); setEditing(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const act = async (id: string, action: 'test' | 'disable') => {
    setBusy(id);
    try { if (action === 'test') { await monitoring.testChannel(id); message.success('测试通知已入队，请查看投递记录'); } else await monitoring.disableChannel(id); await query.refetch(); }
    catch (e) { message.error((e as Error).message); } finally { setBusy(''); }
  };
  return <section className="panel notification-settings" aria-label="通知设置"><div className="monitor-toolbar"><div><span className="section-kicker">NOTIFICATIONS</span><h2>通知渠道</h2></div><Button type="primary" disabled={!query.data?.configured} onClick={event => { rememberFocus(event.currentTarget); setError(''); setEditing('new'); }}>新增 Webhook</Button></div>
    {query.isError && <ErrorState error={query.error} />}
    {query.data && !query.data.configured && <Alert type="info" showIcon title="通知密钥尚未配置" description="请按运行指南设置中心 NOTIFICATION_KEY_FILE 后保存渠道。原有监控继续运行。" />}
    <p className="muted">默认仅允许 HTTPS，验证证书且不跟随重定向。地址和鉴权加密保存，页面仅返回脱敏地址。</p>
    <div className="monitor-cards">{query.data?.channels.length === 0 && <p className="muted">暂无通知渠道</p>}{query.data?.channels.map(c => <article className="monitor-card" key={c.id}><div className="monitor-card-heading"><h3>{c.name}</h3><Tag>{c.enabled ? '启用' : '停用'}</Tag></div><p className="mono">{c.target}</p><p className="muted">{c.has_authorization ? '已配置鉴权头' : '未配置鉴权头'}</p><div className="monitor-actions"><Button onClick={event => { rememberFocus(event.currentTarget); setError(''); setEditing(c); }}>编辑渠道</Button><Button loading={busy === c.id} disabled={!c.enabled} onClick={() => { void act(c.id, 'test'); }}>测试通知</Button><Button disabled={!c.enabled} onClick={() => { void act(c.id, 'disable'); }}>停用渠道</Button></div></article>)}</div>
    <h3>投递记录</h3><DeliveryList />
    <Drawer title={editing === 'new' ? '新增 Webhook' : '编辑 Webhook'} open={!!editing} size="min(520px, 100vw)" onClose={() => setEditing(null)} focusable={{ focusTriggerAfterClose: false }} destroyOnHidden>
      {editing && <Form key={selected?.id || 'new'} layout="vertical" onFinish={save} initialValues={{ name: selected?.name || '', enabled: selected?.enabled ?? true }}>
        {error && <Alert type="error" showIcon title={error} />}<Form.Item name="name" label="渠道名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input /></Form.Item>
        <Form.Item name="url" label="Webhook URL" rules={selected ? [] : [{ required: true }]} extra={selected ? '留空保留原地址。' : '需要 HTTPS；私网目标须由中心显式允许。'}><Input.Password autoComplete="off" placeholder={selected?.target || 'https://…'} /></Form.Item>
        <Form.Item name="authorization" label="Authorization 鉴权头" extra="编辑时留空保留原值。"><Input.Password autoComplete="off" /></Form.Item>
        {selected && <Form.Item name="clear_authorization" label="清除现有鉴权头" valuePropName="checked"><Switch /></Form.Item>}
        <Form.Item name="enabled" label="启用渠道" valuePropName="checked"><Switch /></Form.Item><Button type="primary" htmlType="submit" loading={busy === 'save'}>保存渠道</Button>
      </Form>}
    </Drawer>
  </section>;
}
