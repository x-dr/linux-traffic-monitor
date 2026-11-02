import { useState } from 'react';
import { App, Button, Drawer, Select, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { ProbePair, ProbeTask } from '@traffic/contracts';
import { probes, probeInput, probeStatus } from './probe-api';
import { ErrorState, PageTitle } from './components';
import { date } from './format';
import { useDrawerFocus } from './useDrawerFocus';
import ProbeEditor from './ProbeEditor';
import ProbeHistoryPanel from './ProbeHistory';
import './probes.css';

export default function ProbesPage({ node }: { node?: string }) {
  const [params, setParams] = useSearchParams(), [editing, setEditing] = useState<ProbeTask | 'new' | null>(null), [busy, setBusy] = useState('');
  const remember = useDrawerFocus(!!editing), { message } = App.useApp();
  const query = useQuery({ queryKey: ['probes'], queryFn: probes.list, refetchInterval: 5000 });
  const nodeFilter = node ?? params.get('probe_node') ?? '', taskFilter = params.get('probe_task') ?? '';
  const archiveMode = params.get('probe_archive') ?? (query.data?.tasks.find(t => t.id === taskFilter)?.archived ? 'archived' : 'active');
  const rawMinutes = Number(params.get('probe_minutes')), minutes = [60, 360, 1440, 10080].includes(rawMinutes) ? rawMinutes : 60;
  const set = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key === 'probe_archive') next.delete('probe_task'); setParams(next, { preventScrollReset: true }); };
  const matchesArchive = (task: ProbeTask) => archiveMode === 'all' || task.archived === (archiveMode === 'archived');
  const tasks = query.data?.tasks.filter(t => matchesArchive(t) && (!node || t.node_ids.includes(node))) ?? [];
  const pairs = query.data?.pairs.filter(p => matchesArchive(p.task) && (!nodeFilter || p.node_id === nodeFilter) && (!taskFilter || p.task.id === taskFilter)) ?? [];
  const edit = (task: ProbeTask | 'new', trigger: HTMLElement) => { remember(trigger); setEditing(task); };
  const change = async (task: ProbeTask, archive = false) => {
    setBusy(task.id); try { if (archive) await probes.archive(task.id); else await probes.save({ ...probeInput(task), enabled: !task.enabled }, task); await query.refetch(); }
    catch (e) { message.error((e as Error).message); } finally { setBusy(''); }
  };
  const failed = pairs.filter(p => p.fresh && p.task.enabled && p.node_active && p.latest?.attempts === 1 && p.latest.status !== 'success').length;
  const unknown = pairs.filter(p => p.task.enabled && p.node_active && (!p.fresh || !p.extensions.supported || p.latest?.attempts !== 1)).length;
  const title = <Button type="primary" onClick={e => edit('new', e.currentTarget)}>新建探测</Button>;
  return <div className="probes-page">
    {node ? <div className="monitor-toolbar"><h2>网络质量</h2>{title}</div> : <PageTitle eyebrow="NETWORK OBSERVABILITY" title="网络质量" subtitle="从执行节点观察目标服务，结合可用率与覆盖率判断网络状况。" extra={title} />}
    <div className="probe-summary"><div><span>探测分配</span><strong>{pairs.length}</strong></div><div><span>最近有效失败</span><strong>{failed}</strong></div><div><span>无有效观测 / 待升级</span><strong>{unknown}</strong></div></div>
    <div className="probe-filters"><Select aria-label="探测归档筛选" value={archiveMode} onChange={v => set('probe_archive', v)} options={[{ value: 'active', label: '当前任务' }, { value: 'archived', label: '已归档任务' }, { value: 'all', label: '全部任务' }]} />{!node && <Select aria-label="探测节点筛选" value={nodeFilter} onChange={v => set('probe_node', v)} options={[{ value: '', label: '全部执行节点' }, ...[...new Map(query.data?.pairs.map(p => [p.node_id, { value: p.node_id, label: p.node_name }])).values()]]} />}<Select aria-label="探测任务筛选" value={taskFilter} onChange={v => set('probe_task', v)} options={[{ value: '', label: '全部探测任务' }, ...tasks.map(t => ({ value: t.id, label: t.name }))]} /><Select aria-label="探测历史窗口" value={minutes} onChange={v => set('probe_minutes', String(v))} options={[{ value: 60, label: '最近 1 小时' }, { value: 360, label: '最近 6 小时' }, { value: 1440, label: '最近 24 小时' }, { value: 10080, label: '最近 7 天' }]} /></div>
    {query.isError && <ErrorState error={query.error} />}
    {!query.isPending && !pairs.length && <p className="panel muted">尚无匹配的探测任务。先选择执行节点并保存；旧 Agent 会显示待升级。</p>}
    <div className="probe-cards">{pairs.map(p => <article className="panel probe-card" key={`${p.task.id}:${p.node_id}`}>
      <div className="monitor-card-heading"><h3>{p.node_name} → {p.task.name}</h3><Tag color={p.fresh && p.latest?.status === 'success' ? 'success' : p.fresh && p.latest?.attempts === 1 ? 'warning' : 'default'}>{pairStatus(p)}</Tag></div>
      <p className="probe-target">{p.task.kind.toUpperCase()} · {p.task.family.toUpperCase()} · {p.task.target}{p.task.port ? `:${p.task.port}` : ''}</p>
      <p className="muted">每 {p.task.interval_seconds} 秒 · 超时 {p.task.timeout_seconds} 秒 · {application(p)}</p>
      <p>最近观测：{date(p.latest?.completed_at)}{p.latest?.latency_ms !== null && p.latest?.latency_ms !== undefined ? ` · ${p.latest.latency_ms.toFixed(2)} ms` : ''}</p>
      {p.latest?.certificate_expires_at !== null && p.latest?.certificate_expires_at !== undefined && <p>证书到期：{date(p.latest.certificate_expires_at)}</p>}
      {p.extensions.drops.count > 0 && <p className="muted">Agent 已清理 {p.extensions.drops.count} 条超过 7 天的未确认结果，历史存在缺口。</p>}
      <div className="monitor-actions"><Button onClick={() => set('probe_task', p.task.id)}>查看历史 / 多节点对比</Button><Button disabled={p.task.archived} onClick={e => edit(p.task, e.currentTarget)}>编辑探测</Button><Button disabled={p.task.archived} loading={busy === p.task.id} onClick={() => { void change(p.task); }}>{p.task.enabled ? '停用探测' : '启用探测'}</Button><Button disabled={p.task.archived} onClick={() => { void change(p.task, true); }}>归档探测</Button><Link to={`/nodes/${p.node_id}?tab=probes`}>节点详情</Link></div>
    </article>)}</div>
    {taskFilter && <><p className="muted">同一目标按来源节点分别统计；最多同时展示 4 个来源，可筛选节点查看其余历史。</p>{pairs.slice(0, 4).map(p => <ProbeHistoryPanel key={`${p.task.id}:${p.node_id}:${minutes}`} pair={p} minutes={minutes} />)}</>}
    <Drawer title={editing === 'new' ? '新建网络探测' : '编辑网络探测'} open={!!editing} onClose={() => setEditing(null)} size="min(560px, 100vw)" focusable={{ focusTriggerAfterClose: false }} destroyOnHidden>{editing && <ProbeEditor task={editing === 'new' ? undefined : editing} node={node} onSaved={() => setEditing(null)} />}</Drawer>
  </div>;
}
function application(p: ProbePair) { return !p.extensions.supported ? 'Agent 待升级 / 尚未协商' : p.extensions.error ? p.extensions.error === 'persist_failed' ? '扩展配置保存失败' : '扩展配置校验失败' : p.extensions.config_version === p.extensions.applied_version ? '扩展配置已应用' : '扩展配置待应用'; }
function pairStatus(p: ProbePair) { return p.task.archived ? '已归档' : !p.task.enabled ? '已停用' : !p.node_active ? '节点已停用' : !p.extensions.supported ? '待升级' : !p.fresh ? '无新鲜观测' : p.latest ? probeStatus[p.latest.status] : '等待首次探测'; }
