import { useDrawerFocus } from './useDrawerFocus';
import { useState } from 'react';
import { App, Button, Drawer, Select, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { client } from './api';
import { monitoring } from './monitoring-api';
import { date } from './format';
import { ErrorState } from './components';
import DeliveryList from './DeliveryList';

export const eventStateLabels: Record<string, string> = { firing: '告警中', recovering: '恢复观察', resolved: '已恢复', closed: '配置关闭' };
export default function AlertEvents({ nodeId }: { nodeId?: string }) {
  const [params, setParams] = useSearchParams(), { message } = App.useApp();
  const [busy, setBusy] = useState('');
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: client.nodes });
  const state = params.get('state') || 'active', severity = params.get('severity') || '', node = nodeId || params.get('node') || '';
  const hours = [24, 168, 720, 4320].includes(Number(params.get('hours'))) ? Number(params.get('hours')) : 4320;
  const page = Math.max(0, Math.min(2000, Number(params.get('page')) || 0));
  const query = useQuery({ queryKey: ['alerts', state, severity, node, hours, page], queryFn: () => {
    const query = new URLSearchParams({ state, start: String(Date.now() / 1000 - hours * 3600), limit: '20', offset: String(page * 20) });
    if (node) query.set('node_id', node); if (severity) query.set('severity', severity);
    return monitoring.alerts(query);
  }, refetchInterval: 5000 });
  const selected = params.get('event') || '';
  const rememberFocus = useDrawerFocus(!!selected);
  const detail = useQuery({ queryKey: ['alert', selected], queryFn: () => monitoring.event(selected), enabled: !!selected, refetchInterval: 5000 });
  const change = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); if (key !== 'page' && key !== 'event') next.delete('page'); setParams(next, { replace: key !== 'event', preventScrollReset: true }); };
  const act = async (action: 'acknowledge' | 'silence') => {
    setBusy(action);
    try { await monitoring[action](selected); await detail.refetch(); await query.refetch(); }
    catch (e) { message.error((e as Error).message); } finally { setBusy(''); }
  };
  const e = detail.data?.event;
  return <>
    <div className="monitor-filters">
      <Select aria-label="告警状态筛选" value={state} onChange={v => change('state', v)} options={[{ value: 'active', label: '当前事件' }, { value: 'all', label: '全部事件' }, { value: 'resolved', label: '已恢复' }, { value: 'closed', label: '配置关闭' }]} />
      {!nodeId && <Select aria-label="告警节点筛选" value={node || undefined} placeholder="全部节点" allowClear onChange={v => change('node', v || '')} options={nodes.data?.nodes.map(n => ({ value: n.id, label: n.name }))} />}
      <Select aria-label="告警级别筛选" value={severity || undefined} placeholder="全部级别" allowClear onChange={v => change('severity', v || '')} options={[{ value: 'warning', label: '警告' }, { value: 'critical', label: '严重' }]} />
      <Select aria-label="告警时间范围" value={hours} onChange={v => change('hours', String(v))} options={[{ value: 24, label: '最近 24 小时' }, { value: 168, label: '最近 7 天' }, { value: 720, label: '最近 30 天' }, { value: 4320, label: '最近 180 天' }]} />
    </div>
    {query.isError && <ErrorState error={query.error} />}
    {query.isPending && <p role="status">正在加载事件…</p>}
    <div className="monitor-cards">
      {query.data?.events.length === 0 && <section className="panel"><p className="muted">当前筛选没有事件。启用规则后由中心每 5 秒独立判定。</p></section>}
      {query.data?.events.map(event => <article className="monitor-card panel" key={event.id}>
        <div className="monitor-card-heading"><Button type="link" className="event-title" onClick={click => { rememberFocus(click.currentTarget); change('event', event.id); }}>{event.title}</Button><Tag color={event.state === 'resolved' ? 'success' : event.state === 'closed' ? 'default' : event.severity === 'critical' ? 'error' : 'warning'}>{eventStateLabels[event.state]}</Tag></div>
        <p><Link to={`/nodes/${event.node_id}`}>{event.node_name}</Link> · {date(event.fired_at)} · {event.severity === 'critical' ? '严重' : '警告'}</p>
        <p className="muted">{event.validity === 'fresh' ? '数据有效' : event.validity === 'unsupported' ? '指标不支持' : '数据未知，未作为恢复证据'} · {event.acknowledged_at ? '已确认' : '未确认'}</p>
      </article>)}
    </div>
    <div className="monitor-actions"><Button disabled={!page} onClick={() => change('page', String(page - 1))}>上一页事件</Button><span>{query.data?.total ?? 0} 条</span><Button disabled={(page + 1) * 20 >= (query.data?.total ?? 0)} onClick={() => change('page', String(page + 1))}>下一页事件</Button></div>
    <Drawer focusable={{ focusTriggerAfterClose: false }} title="事件详情" open={!!selected} size="min(560px, 100vw)" onClose={() => change('event', '')}>
      {detail.isError && <ErrorState error={detail.error} />}
      {e && <div className="event-detail"><h2>{e.title}</h2><Tag>{eventStateLabels[e.state]}</Tag><p><Link to={`/nodes/${e.node_id}`}>{e.node_name}</Link></p>
        <dl><dt>首次异常</dt><dd>{date(e.first_anomaly_at)}</dd><dt>确认触发</dt><dd>{date(e.fired_at)}</dd><dt>最近异常</dt><dd>{date(e.last_anomaly_at)}</dd><dt>恢复 / 关闭</dt><dd>{date(e.resolved_at)} {e.close_reason}</dd><dt>当前值 / 阈值</dt><dd>{e.value ?? '未知'} / {e.threshold}</dd><dt>数据状态</dt><dd>{e.validity}</dd><dt>人工确认</dt><dd>{date(e.acknowledged_at)}</dd><dt>静默至</dt><dd>{date(e.silenced_until)}</dd></dl>
        <p className="muted">{e.detail}</p><div className="monitor-actions"><Button disabled={!!e.acknowledged_at} loading={busy === 'acknowledge'} onClick={() => { void act('acknowledge'); }}>确认事件</Button><Button disabled={['resolved', 'closed'].includes(e.state)} loading={busy === 'silence'} onClick={() => { void act('silence'); }}>静默 1 小时</Button></div>
        {['probe_failure', 'certificate_expiry'].includes(e.kind) && <p><Link to={`/probes?probe_node=${e.node_id}&probe_task=${e.object}`}>查看对应探测历史</Link></p>}
        <p className="muted">确认只标记人工处理；静默只暂停通知，指标仍继续判定。</p><h3>投递记录</h3><DeliveryList event={e.id} />
      </div>}
    </Drawer>
  </>;
}
