import type { ProbeHistory, ProbeResult, ProbeStats } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { validProbe } from './probe-alerts.js';
import { taskById } from './probe-store.js';

export function probeHistory(db: DB, node: string, task: string, now: number, minutes: number, offset = 0): ProbeHistory {
  const start = now - minutes * 60, end = now;
  const rows = db.prepare(`SELECT result FROM probe_results WHERE node_id=? AND task_id=? AND scheduled_at>=? AND scheduled_at<? ORDER BY scheduled_at`)
    .all(node, task, start, end) as { result: string }[];
  const results: ProbeResult[] = rows.map(r => JSON.parse(r.result));
  const assignments = db.prepare(`SELECT start_at,end_at,config FROM probe_assignments WHERE node_id=? AND task_id=? AND start_at<? AND (end_at IS NULL OR end_at>?)`).all(node, task, end, start) as { start_at: number; end_at: number | null; config: string }[];
  let expected = 0;
  for (const a of assignments) {
    const interval = JSON.parse(a.config).interval_seconds as number;
    const first = Math.max(0, Math.ceil((start - a.start_at) / interval));
    // A slot still inside its execution timeout is not yet missing.
    const until = Math.min(end - JSON.parse(a.config).timeout_seconds, a.end_at ?? end);
    expected += Math.max(0, Math.ceil((until - a.start_at) / interval) - first);
    expected += results.filter(r => r.task_version === JSON.parse(a.config).version && r.scheduled_at >= until && r.scheduled_at >= start && r.scheduled_at < Math.min(end, a.end_at ?? end)).length;
  }
  const valid = results.filter(validProbe), successes = valid.filter(r => r.status === 'success');
  const latencies = successes.map(r => r.latency_ms!).sort((a, b) => a - b);
  const quantile = (p: number) => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] : null;
  const stats: ProbeStats = { expected, valid: valid.length, success: successes.length,
    availability: valid.length ? successes.length / valid.length * 100 : null,
    coverage: expected ? Math.min(100, valid.length / expected * 100) : null,
    failure_rate: valid.length ? (valid.length - successes.length) / valid.length * 100 : null, p50_ms: quantile(0.5), p95_ms: quantile(0.95) };
  const points: ProbeHistory['points'] = [];
  for (const a of assignments) {
    const cfg = JSON.parse(a.config) as { version: number; interval_seconds: number };
    const bySlot = new Map(results.filter(r => r.task_version === cfg.version).map(r => [r.scheduled_at, r]));
    for (let ts = a.start_at + Math.max(0, Math.ceil((start - a.start_at) / cfg.interval_seconds)) * cfg.interval_seconds; ts < Math.min(end, a.end_at ?? end); ts += cfg.interval_seconds) {
      const r = bySlot.get(ts); points.push({ ts, latency_ms: r?.status === 'success' ? r.latency_ms : null, task_version: cfg.version });
    }
  }
  points.sort((a, b) => a.ts - b.ts);
  return { start, end, task: taskById(db, task), stats, total: results.length, results: [...results].reverse().slice(offset, offset + 100), points };
}
