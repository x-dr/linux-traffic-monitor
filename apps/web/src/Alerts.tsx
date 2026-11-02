import { useState } from 'react';
import { App, Button, Drawer, Tabs, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AlertRule } from '@traffic/contracts';
import { monitoring } from './monitoring-api';
import { ErrorState, PageTitle } from './components';
import AlertEvents from './AlertEvents';
import AlertRuleEditor, { metricLabels, ruleInput } from './AlertRuleEditor';
import MaintenanceWindows from './MaintenanceWindows';
import './monitoring.css';
import { useDrawerFocus } from './useDrawerFocus';

export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const tab = ['events', 'rules', 'maintenance'].includes(params.get('tab') || '') ? params.get('tab')! : 'events';
  return <><PageTitle eyebrow="ALERT CENTER" title="告警中心" subtitle="中心持续判定，关闭浏览器后仍记录事件并投递通知。" />
    <Tabs activeKey={tab} onChange={value => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next, { preventScrollReset: true }); }} items={[
      { key: 'events', label: '事件', children: <AlertEvents /> }, { key: 'rules', label: '规则', children: <Rules /> },
      { key: 'maintenance', label: '维护', children: <MaintenanceWindows /> },
    ]} /></>;
}
function Rules() {
  const [editing, setEditing] = useState<AlertRule | 'new' | null>(null), [busy, setBusy] = useState('');
  const rememberFocus = useDrawerFocus(!!editing);
  const edit = (value: AlertRule | 'new', button: HTMLElement) => { rememberFocus(button); setEditing(value); };
  const query = useQuery({ queryKey: ['rules'], queryFn: monitoring.rules, refetchInterval: 5000 }), { message } = App.useApp();
  const change = async (rule: AlertRule, archive: boolean) => {
    setBusy(rule.id);
    try { if (archive) await monitoring.archiveRule(rule.id); else await monitoring.saveRule({ ...ruleInput(rule), enabled: !rule.enabled }, rule.id); await query.refetch(); }
    catch (e) { message.error((e as Error).message); } finally { setBusy(''); }
  };
  return <><div className="monitor-toolbar"><p className="muted">模板默认关闭，保存后启用。规则变更会关闭原事件并重新判定。</p><Button type="primary" onClick={event => edit('new', event.currentTarget)}>新建规则</Button></div>
    {query.isError && <ErrorState error={query.error} />}
    <div className="monitor-cards">{query.data?.rules.length === 0 && <p className="muted">尚未创建规则</p>}{query.data?.rules.map(r => <article className="monitor-card panel" key={r.id}><div className="monitor-card-heading"><h3>{r.name}</h3><Tag color={r.enabled ? 'success' : 'default'}>{r.enabled ? '已启用' : '未启用'}</Tag></div><p>{metricLabels[r.metric]} · 阈值 {r.threshold} · 持续 {r.duration_seconds} 秒 · 匹配 {r.matched_nodes.length} 台</p><div className="monitor-actions"><Button onClick={event => edit(r, event.currentTarget)}>编辑规则</Button><Button loading={busy === r.id} onClick={() => { void change(r, false); }}>{r.enabled ? '停用规则' : '启用规则'}</Button><Button onClick={() => { void change(r, true); }}>归档规则</Button></div></article>)}</div>
    <Drawer title={editing === 'new' ? '新建告警规则' : '编辑告警规则'} open={!!editing} size="min(560px, 100vw)" onClose={() => setEditing(null)} focusable={{ focusTriggerAfterClose: false }} destroyOnHidden>
      {editing && <AlertRuleEditor key={editing === 'new' ? 'new' : editing.id} rule={editing === 'new' ? undefined : editing} onSaved={() => setEditing(null)} />}
    </Drawer>
  </>;
}
