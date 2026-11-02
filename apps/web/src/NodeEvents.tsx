import { useState } from 'react';
import { Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { monitoring } from './monitoring-api';
import { date } from './format';
import { ErrorState } from './components';
import AlertEvents from './AlertEvents';

export default function NodeEvents({ id }: { id: string }) {
  const [offset, setOffset] = useState(0);
  const query = useQuery({ queryKey: ['node-events', id, offset], queryFn: () => monitoring.nodeEvents(id, offset), refetchInterval: 5000 });
  return <><h2>节点告警</h2><AlertEvents nodeId={id} /><section className="panel"><h2>事件时间线</h2>
    {query.isError && <ErrorState error={query.error} />}
    <div className="monitor-cards">{query.data?.events.length === 0 && <p className="muted">暂无节点事件</p>}{query.data?.events.map(e => <article className="monitor-card" key={e.id}><strong>{e.detail}</strong><p className="muted">{date(e.created_at)} · {e.kind}</p></article>)}</div>
    <div className="monitor-actions"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页时间线</Button><Button disabled={(query.data?.events.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>下一页时间线</Button></div>
  </section></>;
}
