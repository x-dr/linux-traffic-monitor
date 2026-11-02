import { useState } from 'react';
import { App, Button, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { monitoring } from './monitoring-api';
import { date } from './format';
import { ErrorState } from './components';

const statuses: Record<string, string> = { pending: '待投递', sending: '发送中', sent: '成功', failed: '失败', cancelled: '已取消', suppressed: '维护 / 静默' };
export default function DeliveryList({ event }: { event?: string }) {
  const [offset, setOffset] = useState(0), [busy, setBusy] = useState('');
  const { message } = App.useApp();
  const query = useQuery({ queryKey: ['deliveries', event, offset], queryFn: () => monitoring.deliveries(event, offset), refetchInterval: 5000 });
  const retry = async (id: string) => {
    setBusy(id); try { await monitoring.retry(id); await query.refetch(); } catch (e) { message.error((e as Error).message); } finally { setBusy(''); }
  };
  if (query.isError) return <ErrorState error={query.error} />;
  return <div className="monitor-cards" aria-label="通知投递记录">
    {query.isPending && <p role="status">正在加载投递记录…</p>}
    {query.data?.deliveries.length === 0 && <p className="muted">暂无投递记录</p>}
    {query.data?.deliveries.map(d => <article className="monitor-card" key={d.id}>
      <div className="monitor-card-heading"><strong>{d.channel_name} · {d.phase}</strong><Tag color={d.status === 'sent' ? 'success' : d.status === 'failed' ? 'error' : 'default'}>{statuses[d.status] ?? d.status}</Tag></div>
      <p>尝试 {d.attempts} 次 · {date(d.created_at)}</p>
      {d.last_error && <p>{d.last_error}</p>}
      {['pending', 'suppressed'].includes(d.status) && <p>下次处理：{date(d.next_attempt_at)}</p>}
      {d.status === 'failed' && <Button loading={busy === d.id} onClick={() => { void retry(d.id); }}>重试投递</Button>}
    </article>)}
    <div className="monitor-actions"><Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页投递</Button><Button disabled={(query.data?.deliveries.length ?? 0) < 20} onClick={() => setOffset(offset + 20)}>下一页投递</Button></div>
  </div>;
}
