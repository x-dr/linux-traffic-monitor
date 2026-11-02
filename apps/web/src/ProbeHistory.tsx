import { useState } from 'react';
import { Pagination } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ProbePair } from '@traffic/contracts';
import { probes, probeStatus } from './probe-api';
import { date } from './format';
import { ErrorState } from './components';
import ProbeChart from './ProbeChart';

const pct = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}%`;
const ms = (v: number | null) => v === null ? '—' : `${v.toFixed(2)} ms`;
export default function ProbeHistoryPanel({ pair, minutes }: { pair: ProbePair; minutes: number }) {
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['probe-history', pair.node_id, pair.task.id, minutes, page], queryFn: () => probes.history(pair.node_id, pair.task.id, minutes, (page - 1) * 100), refetchInterval: 15000 });
  if (query.isError) return <ErrorState error={query.error} />;
  if (!query.data) return <p role="status">正在加载探测历史…</p>;
  const h = query.data, s = h.stats;
  return <section className="panel probe-history" aria-label={`${pair.node_name} 探测历史`}>
    <h2>{pair.node_name} → {pair.task.name}</h2><p className="muted">{date(h.start)} ～ {date(h.end)} · 原始观测，保留 7 天</p>
    <div className="probe-stat-grid"><div><span>观测可用率</span><strong>{pct(s.availability)}</strong><small>{s.success} / {s.valid} 次有效执行</small></div><div><span>覆盖率</span><strong>{pct(s.coverage)}</strong><small>{s.valid} / {s.expected} 次应执行</small></div><div><span>{pair.task.kind === 'icmp' ? 'ICMP 丢包率' : '探测失败率'}</span><strong>{pct(s.failure_rate)}</strong><small>无有效观测不计入失败</small></div><div><span>成功耗时 P50 / P95</span><strong className="probe-quantile">{ms(s.p50_ms)} / {ms(s.p95_ms)}</strong><small>窗口内真实成功样本</small></div></div>
    <ProbeChart points={h.points} /><p className="muted">空缺可能来自离线、跳过、目标限制或未安装扩展；可用率须结合覆盖率阅读。</p>
    <details><summary>原始结果（{h.total} 条，含历史任务版本）</summary><div className="probe-results">{h.results.map(r => <div className="probe-result" key={r.sample_id}><span>{date(r.scheduled_at)} · v{r.task_version}</span><strong>{probeStatus[r.status]} · {ms(r.latency_ms)}</strong><span>执行 {r.attempts} 次{r.http_status ? ` · HTTP ${r.http_status}` : ''}</span></div>)}</div>
      <Pagination current={page} pageSize={100} total={h.total} showSizeChanger={false} onChange={setPage} simple /></details>
  </section>;
}
