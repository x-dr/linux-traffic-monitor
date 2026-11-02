import { useDrawerFocus } from './useDrawerFocus';
import { useState } from 'react';
import { App, Alert, Button, Drawer, Form, Input } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { AlertScope, Maintenance } from '@traffic/contracts';
import { client } from './api';
import { monitoring } from './monitoring-api';
import { date } from './format';
import { ErrorState } from './components';
import AlertScopeFields from './AlertScopeFields';

type WindowInput = { name: string; scope: AlertScope; start: string; end: string };
export default function MaintenanceWindows() {
  const [editing, setEditing] = useState<Maintenance | 'new' | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const rememberFocus = useDrawerFocus(!!editing);
  const { message } = App.useApp();
  const query = useQuery({ queryKey: ['maintenance'], queryFn: monitoring.windows, refetchInterval: 5000 });
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: client.nodes });
  const selected = editing && editing !== 'new' ? editing : null;
  const save = async (input: WindowInput) => {
    setBusy(true); setError('');
    try {
      const start_at = Date.parse(input.start) / 1000, end_at = Date.parse(input.end) / 1000;
      if (!Number.isFinite(start_at) || !Number.isFinite(end_at) || !/(Z|[+-]\d\d:\d\d)$/.test(input.start) || !/(Z|[+-]\d\d:\d\d)$/.test(input.end)) throw new Error('时间必须包含 Z 或 +08:00 等时区');
      await monitoring.saveWindow({ name: input.name, scope: input.scope, start_at, end_at }, selected?.id);
      await query.refetch(); setEditing(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { try { await monitoring.removeWindow(id); await query.refetch(); } catch (e) { message.error((e as Error).message); } };
  return <><div className="monitor-toolbar"><p className="muted">维护期间继续记录事件，结束时只发送仍存在异常的摘要。</p><Button type="primary" onClick={event => { rememberFocus(event.currentTarget); setError(''); setEditing('new'); }}>新建维护窗口</Button></div>
    {query.isError && <ErrorState error={query.error} />}
    <div className="monitor-cards">{query.data?.windows.length === 0 && <p className="muted">暂无维护窗口</p>}{query.data?.windows.map(w => <article className="monitor-card panel" key={w.id}><h3>{w.name}</h3><p>{date(w.start_at)} → {date(w.end_at)}</p><div className="monitor-actions"><Button onClick={event => { rememberFocus(event.currentTarget); setError(''); setEditing(w); }}>编辑维护</Button><Button onClick={() => { void remove(w.id); }}>取消维护</Button></div></article>)}</div>
    <Drawer title="维护窗口" open={!!editing} size="min(520px, 100vw)" onClose={() => setEditing(null)} focusable={{ focusTriggerAfterClose: false }} destroyOnHidden>
      {editing && <Form key={selected?.id || 'new'} layout="vertical" initialValues={{ name: selected?.name || '', scope: selected?.scope || { kind: 'all', node_ids: [], value: '' }, start: new Date((selected?.start_at ?? Date.now() / 1000) * 1000).toISOString(), end: new Date((selected?.end_at ?? Date.now() / 1000 + 3600) * 1000).toISOString() }} onFinish={save}>
        {error && <Alert type="error" title={error} showIcon />}<Form.Item name="name" label="维护名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input /></Form.Item><AlertScopeFields nodes={nodes.data?.nodes ?? []} />
        <Form.Item name="start" label="开始时间（含时区）" rules={[{ required: true }]}><Input placeholder="2026-11-02T09:00:00+08:00" /></Form.Item><Form.Item name="end" label="结束时间（含时区）" rules={[{ required: true }]}><Input /></Form.Item><p className="muted">时间按输入的时区解析；事件时间按浏览器本地时区显示。窗口最长 30 天。</p><Button htmlType="submit" type="primary" loading={busy}>保存维护</Button>
      </Form>}
    </Drawer>
  </>;
}
