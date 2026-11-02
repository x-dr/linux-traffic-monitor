import { DateTime } from 'luxon';
import type { MonitorConfig, QuotaView, Snapshot, TrafficPolicy, TrafficPolicyInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode, type NodeRow } from './nodes.js';
import { monthBounds } from './periods.js';
import { httpError } from './auth.js';
import { newEvent, nodeEvent, validateChannels } from './alert-store.js';
import { enqueue } from './notification-queue.js';
import { billed, trafficBetween } from './traffic-accounting.js';
import { resourceFresh } from './alert-engine.js';

type PolicyRow = { node_id: string; config: string; version: number; cycle_config: string; recalculated: number };
export function getPolicy(db: DB, node: string): TrafficPolicy | null {
  const row = db.prepare('SELECT * FROM traffic_policies WHERE node_id=?').get(node) as PolicyRow | undefined;
  return row ? { ...JSON.parse(row.config), version: row.version } : null;
}
function forecast(db: DB, node: NodeRow, policy: TrafficPolicy, now: number, end: number, current: { rx: bigint; tx: bigint }): QuotaView['forecast'] {
  const cfg = JSON.parse(node.config) as MonitorConfig;
  const today = DateTime.fromSeconds(now, { zone: cfg.timezone }).startOf('day');
  let rx = 0n, tx = 0n, seconds = 0, days = 0, minimumCoverage = 1;
  let start: string | null = null, stop: string | null = null;
  for (let i = 7; i >= 1; i--) {
    const from = today.minus({ days: i }), to = from.plus({ days: 1 });
    const duration = to.toSeconds() - from.toSeconds();
    const sample = trafficBetween(db, node.id, policy.interfaces, from.toSeconds(), to.toSeconds());
    const coverage = Math.min(...[...sample.coverage.values()].map(count => Math.min(1, count * 60 / duration)));
    if (coverage < .95) continue;
    days++; seconds += duration; rx += sample.rx; tx += sample.tx;
    minimumCoverage = Math.min(minimumCoverage, coverage); start ??= from.toISO(); stop = to.toISO();
  }
  const base = { available: false, days, coverage: days ? minimumCoverage : 0, window_start: start, window_end: stop,
    projected_bytes: null, exhaustion_at: null };
  if (!resourceFresh(node, now)) return { ...base, reason: '当前采样异常，暂停预测' };
  const snapshot = JSON.parse(node.snapshot!) as Snapshot;
  if (policy.interfaces.some(name => !snapshot.selected_interfaces.includes(name) || !snapshot.readable_interfaces.includes(name))) return { ...base, reason: '计费网卡当前未被采集或不可读，暂停预测' };
  if (days < 3) return { ...base, reason: '至少需要 3 个计费网卡分钟记录覆盖率均达到 95% 的完整自然日' };
  const quota = BigInt(policy.quota_bytes), remaining = Math.max(0, Math.floor(end - now));
  const projected = billed(policy.direction, current.rx + rx * BigInt(remaining) / BigInt(seconds), current.tx + tx * BigInt(remaining) / BigInt(seconds));
  const duration = (used: bigint, total: bigint) => used >= quota ? 0 : total > 0n ? Number((quota - used) * BigInt(seconds) / total) : Infinity;
  const until = policy.direction === 'max' ? Math.min(duration(current.rx, rx), duration(current.tx, tx))
    : duration(billed(policy.direction, current.rx, current.tx), billed(policy.direction, rx, tx));
  return { available: true, days, coverage: minimumCoverage, window_start: start, window_end: stop,
    projected_bytes: String(projected), exhaustion_at: Number.isFinite(until) ? now + until : null,
    reason: billed(policy.direction, current.rx, current.tx) >= quota ? '已超额' : Number.isFinite(until) ? '按有效自然日真实时长加权估算' : '近期有效速率为零，无法估算耗尽时间' };
}
export function quotaView(db: DB, node: NodeRow, policy: TrafficPolicy, now: number, includeForecast = true): QuotaView {
  const [, start, end] = monthBounds(now, JSON.parse(node.config));
  const traffic = trafficBetween(db, node.id, policy.interfaces, start.toSeconds(), end.toSeconds());
  const used = billed(policy.direction, traffic.rx, traffic.tx), quota = BigInt(policy.quota_bytes);
  const selected = node.snapshot ? (JSON.parse(node.snapshot).selected_interfaces as string[]) : [];
  const expected = Math.max(1, Math.floor((now - start.toSeconds()) / 60));
  return { policy, start: start.toISO()!, end: end.toISO()!, rx_bytes: String(traffic.rx), tx_bytes: String(traffic.tx), billed_bytes: String(used),
    remaining_bytes: String(used >= quota ? 0n : quota - used), percent: Number(used * 10000n / quota) / 100, exceeded: used >= quota,
    missing_interfaces: policy.interfaces.filter(name => !selected.includes(name) || (traffic.coverage.get(name) ?? 0) < expected * .95),
    forecast: includeForecast ? forecast(db, node, policy, now, end.toSeconds(), traffic) : { available: false, reason: '未请求预测', days: 0, coverage: 0, window_start: null, window_end: null, projected_bytes: null, exhaustion_at: null },
    basis: '基于中心已收到记录估算；分钟记录不证明连续采样或补传完毕，不等同于服务商账单。', remaining_seconds: Math.max(0, end.toSeconds() - now) };
}
export function closeQuotaEvents(db: DB, node: string, now: number, reason: string) {
  db.prepare(`UPDATE notification_outbox SET status='cancelled' WHERE event_id IN
    (SELECT id FROM alert_events WHERE node_id=? AND kind='traffic' AND state='firing') AND status IN ('pending','suppressed','sending')`).run(node);
  db.prepare("UPDATE alert_events SET state='closed',resolved_at=?,close_reason=? WHERE node_id=? AND kind='traffic' AND state='firing'").run(now, reason, node);
}
export function savePolicy(db: DB, nodeId: string, input: TrafficPolicyInput, now: number, expectedVersion: number, expectedConfig: number) {
  const node = findNode(db, nodeId), old = getPolicy(db, nodeId);
  if ((old?.version ?? 0) !== expectedVersion || node.config_version !== expectedConfig) throw httpError(409, '配置已经变化，请重新预览');
  validateChannels(db, input.channel_ids);
  const config = JSON.stringify({ enabled: input.enabled, quota_bytes: input.quota_bytes, input_unit: input.input_unit,
    direction: input.direction, interfaces: [...input.interfaces].sort(), thresholds: [...input.thresholds].sort((a, b) => a - b), channel_ids: [...input.channel_ids].sort() });
  return db.transaction(() => {
    if (old && JSON.stringify({ ...old, version: undefined }) === config) return old;
    const version = (old?.version ?? 0) + 1;
    closeQuotaEvents(db, nodeId, now, '配置关闭：套餐变更后重算');
    db.prepare(`INSERT INTO traffic_policies VALUES(?,?,?,?,1) ON CONFLICT(node_id) DO UPDATE SET config=excluded.config,
      version=excluded.version,cycle_config=excluded.cycle_config,recalculated=1`).run(nodeId, config, version, node.config);
    nodeEvent(db, nodeId, 'traffic_policy_changed', now, `套餐版本 ${version}，配置变更后重算`);
    return getPolicy(db, nodeId)!;
  })();
}
export function updatePolicyCycle(db: DB, node: string, config: MonitorConfig, now: number) {
  const row = db.prepare('SELECT * FROM traffic_policies WHERE node_id=?').get(node) as PolicyRow | undefined;
  if (!row) return;
  const old = JSON.parse(row.cycle_config) as MonitorConfig;
  if (old.month_start_day === config.month_start_day && old.month_start_time === config.month_start_time && old.timezone === config.timezone) return;
  closeQuotaEvents(db, node, now, '配置关闭：计费周期变更');
  db.prepare('UPDATE traffic_policies SET version=version+1,cycle_config=?,recalculated=1 WHERE node_id=?').run(JSON.stringify(config), node);
  nodeEvent(db, node, 'traffic_cycle_changed', now, '计费周期变更；套餐版本递增，等待重算');
}
export function evaluateQuotas(db: DB, now: number, publicUrl?: string) {
  db.transaction(() => {
    for (const row of db.prepare('SELECT * FROM traffic_policies').all() as PolicyRow[]) {
      const node = findNode(db, row.node_id), policy = getPolicy(db, node.id)!;
      if (!policy.enabled || !node.enabled || node.archived) continue;
      const view = quotaView(db, node, policy, now, false), start = DateTime.fromISO(view.start).toSeconds();
      db.prepare("UPDATE alert_events SET value=?,last_anomaly_at=? WHERE node_id=? AND kind='traffic' AND state='firing'").run(view.percent, now, node.id);
      db.prepare(`UPDATE notification_outbox SET status='cancelled' WHERE event_id IN
        (SELECT id FROM alert_events WHERE node_id=? AND kind='traffic' AND state='firing' AND fired_at<?) AND status IN ('pending','suppressed','sending')`).run(node.id, start);
      db.prepare("UPDATE alert_events SET state='closed',resolved_at=?,close_reason='新周期重新计算' WHERE node_id=? AND kind='traffic' AND state='firing' AND fired_at<?").run(now, node.id, start);
      const crossed = policy.thresholds.filter(t => BigInt(view.billed_bytes) * 100n >= BigInt(policy.quota_bytes) * BigInt(t)
        && !db.prepare('SELECT 1 FROM traffic_threshold_events WHERE node_id=? AND cycle_start=? AND policy_version=? AND threshold=?').get(node.id, start, policy.version, t));
      if (!crossed.length) continue;
      const highest = Math.max(...crossed);
      closeQuotaEvents(db, node.id, now, '额度阈值升级');
      const event = newEvent(db, { node_id: node.id, rule_id: null, kind: 'traffic', title: `流量额度达到 ${highest}%`, severity: highest >= 100 ? 'critical' : 'warning',
        object: policy.interfaces.join(','), state: 'firing', validity: 'fresh', first_anomaly_at: now, fired_at: now, last_anomaly_at: now,
        value: view.percent, threshold: highest, detail: `${row.recalculated ? '配置变更后重算；' : ''}策略 v${policy.version}；周期 ${view.start} → ${view.end}；计费 ${view.billed_bytes} 字节；${view.basis}` });
      for (const threshold of crossed) db.prepare('INSERT INTO traffic_threshold_events VALUES(?,?,?,?,?)').run(node.id, start, policy.version, threshold, event.id);
      enqueue(db, event, policy.channel_ids, 'trigger', now, highest, publicUrl);
      db.prepare('UPDATE traffic_policies SET recalculated=0 WHERE node_id=?').run(node.id);
    }
  })();
}
