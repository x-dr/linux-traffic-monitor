import { telemetryReading } from './telemetry-alerts.js';
import type { AlertRuleInput, AlertValidity, Snapshot } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import type { NodeRow } from './nodes.js';
import { closeEvents, eventById, matches, newEvent, nodeEvent } from './alert-store.js';
import { enqueue, enqueueRecovery } from './notification-queue.js';
import { reportTiming } from './reporting.js';

type State = { phase: 'normal' | 'pending' | 'firing' | 'recovering'; since: number; event: string | null;
  revision: number; observed: number; evaluated: number; repeat: number; next_repeat: number; identity?: string };
type Reading = { value: number | null; validity: AlertValidity; observed: number; revision: number; maxGap?: number; identity?: string };
export function resourceFresh(node: NodeRow, now: number, maxAge = 15) {
  const s = node.snapshot ? JSON.parse(node.snapshot) as Snapshot : null;
  return !!s && !s.error && node.last_sample_received_at !== null && now - node.last_sample_received_at <= maxAge
    && node.last_received_at !== null && now - node.last_received_at <= maxAge && now - s.observed_at <= maxAge && s.observed_at <= now + 5;
}
function reading(db: DB, node: NodeRow, rule: AlertRuleInput, now: number): Reading {
  const extended = telemetryReading(db, node.id, rule, now); if (extended) return extended;
  const s = node.snapshot ? JSON.parse(node.snapshot) as Snapshot : null;
  if (rule.metric === 'offline') return { value: now - node.last_received_at!, validity: 'fresh', observed: now, revision: node.snapshot_revision };
  if (rule.metric === 'stale') return { value: now - Math.min(node.last_sample_received_at ?? 0, s?.observed_at ?? 0), validity: 'fresh', observed: now, revision: node.snapshot_revision };
  const base = { revision: node.snapshot_revision, observed: s?.observed_at ?? 0, maxGap: reportTiming(db, node.id).staleSeconds };
  if (!resourceFresh(node, now, base.maxGap)) return { ...base, value: null, validity: 'unknown' };
  const disk = s!.disks.find(d => d.mount === rule.object);
  const value = rule.metric === 'cpu' ? s!.cpu_percent : rule.metric === 'memory' ? s!.memory_percent
    : rule.metric === 'disk_percent' ? disk?.used_percent ?? null : rule.metric === 'disk_free' ? (disk ? Number(disk.free_bytes) : null)
    : Math.max(s!.rx_bps, s!.tx_bps) * 8 / (rule.bandwidth_mbps! * 1e6) * 100;
  return { ...base, value, validity: value === null ? (disk === undefined && rule.metric.startsWith('disk_') ? 'unsupported' : 'unknown') : 'fresh' };
}

export class AlertEngine {
  constructor(private db: DB, private publicUrl?: string) {}
  restart() {
    // Persist active events, but never count downtime as continuous sampling.
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT * FROM alert_states').all() as { rule_id: string; node_id: string; object: string; data: string }[];
      for (const row of rows) {
        const state = JSON.parse(row.data) as State;
        if (state.phase === 'pending') state.phase = 'normal';
        if (state.phase === 'recovering') state.phase = 'firing';
        state.evaluated = 0; state.since = 0;
        if (state.event) this.db.prepare("UPDATE alert_events SET state='firing',validity='unknown' WHERE id=?").run(state.event);
        this.db.prepare('UPDATE alert_states SET data=? WHERE rule_id=? AND node_id=? AND object=?').run(JSON.stringify(state), row.rule_id, row.node_id, row.object);
      }
    })();
  }
  tick(now: number) {
    this.db.transaction(() => {
      const nodes = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
      const rules = this.db.prepare('SELECT id,config FROM alert_rules WHERE archived=0').all() as { id: string; config: string }[];
      for (const { id, config } of rules) {
        const rule = JSON.parse(config) as AlertRuleInput;
        if (!rule.enabled) continue;
        for (const node of nodes) {
          const row = this.db.prepare('SELECT data FROM alert_states WHERE rule_id=? AND node_id=? AND object=?').get(id, node.id, rule.object) as { data: string } | undefined;
          if (!node.enabled || node.archived || !matches(rule.scope, node)) {
            if (row) { closeEvents(this.db, now, '配置关闭：节点范围或启用状态变化', id, node.id); nodeEvent(this.db, node.id, 'rule_scope_changed', now, rule.name); }
            continue;
          }
          if (node.last_received_at === null) continue;
          const enabledAt = (node as NodeRow & { enabled_at: number | null }).enabled_at;
          if (enabledAt && now - enabledAt < Math.max(120, rule.threshold) && node.last_received_at < enabledAt) continue;
          const state: State = row ? JSON.parse(row.data) : { phase: 'normal', since: 0, event: null, revision: -1, observed: 0, evaluated: 0, repeat: 0, next_repeat: 0 };
          if (!row) nodeEvent(this.db, node.id, 'rule_scope_joined', now, rule.name);
          const point = reading(this.db, node, rule, now);
          this.advance(id, node, rule, state, point, now);
          this.db.prepare('INSERT INTO alert_states VALUES(?,?,?,?) ON CONFLICT(rule_id,node_id,object) DO UPDATE SET data=excluded.data')
            .run(id, node.id, rule.object, JSON.stringify(state));
        }
      }
      for (const node of nodes) {
        const enabledAt = (node as NodeRow & { enabled_at: number | null }).enabled_at;
        if (!node.enabled || node.archived || !enabledAt || now - enabledAt < 120 || (node.last_received_at ?? 0) >= enabledAt) continue;
        if (!this.db.prepare("SELECT 1 FROM node_events WHERE node_id=? AND kind='enabled_no_report' AND created_at>=?").get(node.id, enabledAt)) nodeEvent(this.db, node.id, 'enabled_no_report', now, '启用后超过 120 秒未上报');
      }
    })();
  }
  private advance(id: string, node: NodeRow, rule: AlertRuleInput, state: State, point: Reading, now: number) {
    const wallClock = ['offline', 'stale'].includes(rule.metric);
    const disconnected = state.evaluated === 0 || now - state.evaluated > (point.maxGap ?? 15) || (!wallClock && point.observed - state.observed > (point.maxGap ?? 15) || (point.identity !== undefined && point.identity !== state.identity));
    state.evaluated = now;
    if (point.validity !== 'fresh') {
      if (state.phase === 'pending') { state.phase = 'normal'; state.since = 0; }
      if (state.phase === 'recovering') { state.phase = 'firing'; state.since = 0; }
      if (state.event) this.db.prepare("UPDATE alert_events SET validity=?,state='firing',value=NULL WHERE id=?").run(point.validity, state.event);
      return;
    }
    if (!wallClock && (point.revision <= state.revision || point.observed <= state.observed)) return;
    if (disconnected) {
      if (state.phase === 'pending') state.phase = 'normal';
      if (state.phase === 'recovering') state.phase = 'firing';
    }
    state.identity = point.identity; state.revision = point.revision; state.observed = point.observed;
    const value = point.value!;
    const bad = rule.metric === 'disk_free' ? value < rule.threshold : value > rule.threshold;
    const freshSeconds = reportTiming(this.db, node.id).staleSeconds;
    const good = wallClock ? (rule.metric === 'offline' ? now - node.last_received_at! <= Math.min(freshSeconds, rule.recovery_threshold) : resourceFresh(node, now, freshSeconds) && value <= Math.min(freshSeconds, rule.recovery_threshold))
      : rule.metric === 'disk_free' ? value > rule.recovery_threshold : value < rule.recovery_threshold;
    const time = wallClock ? now : point.observed;
    if (state.event) {
      this.db.prepare('UPDATE alert_events SET validity=?,value=?,last_anomaly_at=CASE WHEN ? THEN ? ELSE last_anomaly_at END WHERE id=?')
        .run(point.validity, value, Number(bad), now, state.event);
    }
    if (state.phase === 'normal' && bad) { state.phase = 'pending'; state.since = time; }
    if (state.phase === 'pending') {
      if (!bad) state.phase = 'normal';
      else if (time - state.since >= rule.duration_seconds) {
        const event = newEvent(this.db, { node_id: node.id, rule_id: id, kind: rule.metric, title: rule.name, severity: rule.severity,
          object: rule.object, state: 'firing', validity: point.validity, first_anomaly_at: state.since, fired_at: now,
          last_anomaly_at: now, value, threshold: rule.threshold, detail: wallClock ? '通知等待时间独立于列表状态阈值' : '仅由新鲜、不同 revision 的有效样本推进' });
        state.event = event.id; state.phase = 'firing'; state.repeat = 0; state.next_repeat = now + rule.repeat_seconds;
        enqueue(this.db, event, rule.channel_ids, 'trigger', now, 0, this.publicUrl);
      }
    }
    if (state.phase === 'firing' && good) { state.phase = 'recovering'; state.since = time; }
    if (state.phase === 'recovering') {
      if (!good) state.phase = 'firing';
      else if (time - state.since >= rule.recovery_seconds) {
        this.db.prepare("UPDATE alert_events SET state='resolved',resolved_at=?,close_reason='指标恢复' WHERE id=?").run(now, state.event);
        const event = eventById(this.db, state.event!);
        enqueueRecovery(this.db, event, rule.channel_ids, now, this.publicUrl);
        nodeEvent(this.db, node.id, 'alert_resolved', now, rule.name);
        state.event = null; state.phase = 'normal'; state.since = 0;
      }
    }
    if (state.event) {
      this.db.prepare('UPDATE alert_events SET state=? WHERE id=?').run(state.phase, state.event);
      if (bad && rule.repeat_seconds && now >= state.next_repeat) {
        enqueue(this.db, eventById(this.db, state.event), rule.channel_ids, 'reminder', now, ++state.repeat, this.publicUrl);
        state.next_repeat = now + rule.repeat_seconds;
      }
    }
  }
}
