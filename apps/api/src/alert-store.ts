import { randomUUID } from 'node:crypto';
import type { AlertEvent, AlertRuleInput, AlertScope, Maintenance } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import type { NodeRow } from './nodes.js';
import { httpError } from './auth.js';

export function matches(scope: AlertScope, node: NodeRow) {
  return scope.kind === 'all' || (scope.kind === 'nodes' && scope.node_ids.includes(node.id))
    || (scope.kind === 'group' && scope.value === node.group_name)
    || (scope.kind === 'tag' && (JSON.parse(node.tags) as string[]).includes(scope.value));
}
export function validateScope(scope: AlertScope) {
  if (scope.kind === 'nodes' && !scope.node_ids.length) throw httpError(400, '请选择节点');
  if (['group', 'tag'].includes(scope.kind) && !scope.value.trim()) throw httpError(400, '请填写分组或标签');
}
export function nodeEvent(db: DB, node: string, kind: string, now: number, detail: string) {
  db.prepare('INSERT INTO node_events VALUES(?,?,?,?,?)').run(randomUUID(), node, kind, now, detail);
}
export function eventById(db: DB, id: string): AlertEvent {
  const row = db.prepare('SELECT e.*,n.name node_name FROM alert_events e JOIN nodes n ON n.id=e.node_id WHERE e.id=?').get(id) as AlertEvent | undefined;
  if (!row) throw httpError(404, '事件不存在');
  return row;
}
export function newEvent(db: DB, input: Omit<AlertEvent, 'id' | 'node_name' | 'acknowledged_at' | 'silenced_until' | 'resolved_at' | 'close_reason'>) {
  const id = randomUUID();
  db.prepare(`INSERT INTO alert_events(id,node_id,rule_id,kind,title,severity,object,state,validity,first_anomaly_at,fired_at,last_anomaly_at,value,threshold,detail)
    VALUES(@id,@node_id,@rule_id,@kind,@title,@severity,@object,@state,@validity,@first_anomaly_at,@fired_at,@last_anomaly_at,@value,@threshold,@detail)`).run({ id, ...input });
  nodeEvent(db, input.node_id, 'alert_fired', input.fired_at, input.title);
  return eventById(db, id);
}
export function closeEvents(db: DB, now: number, reason: string, rule?: string, node?: string) {
  const rows = db.prepare(`SELECT id,node_id,title FROM alert_events WHERE state IN ('firing','recovering')
    AND (? IS NULL OR rule_id=?) AND (? IS NULL OR node_id=?)`).all(rule ?? null, rule ?? null, node ?? null, node ?? null) as { id: string; node_id: string; title: string }[];
  for (const row of rows) {
    db.prepare("UPDATE alert_events SET state='closed',resolved_at=?,close_reason=? WHERE id=?").run(now, reason, row.id);
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE event_id=? AND status IN ('pending','suppressed','sending')").run(row.id);
    nodeEvent(db, row.node_id, 'alert_closed', now, `${row.title}：${reason}`);
  }
  db.prepare('DELETE FROM alert_states WHERE (? IS NULL OR rule_id=?) AND (? IS NULL OR node_id=?)')
    .run(rule ?? null, rule ?? null, node ?? null, node ?? null);
}
export function isSuppressed(db: DB, node: NodeRow, event: AlertEvent | null, now: number) {
  if (event?.silenced_until && event.silenced_until > now) return true;
  const windows = db.prepare('SELECT config FROM maintenance_windows WHERE start_at<=? AND end_at>?').all(now, now) as { config: string }[];
  return windows.some(row => matches((JSON.parse(row.config) as Maintenance).scope, node));
}
export function validateChannels(db: DB, ids: string[]) {
  for (const id of ids) if (!db.prepare('SELECT 1 FROM notification_channels WHERE id=?').get(id)) throw httpError(400, '通知渠道不存在');
}
export function validateRule(db: DB, rule: AlertRuleInput) {
  validateScope(rule.scope); validateChannels(db, rule.channel_ids);
  if (!rule.name.trim()) throw httpError(400, '规则名称不能为空');
  if (rule.repeat_seconds > 0 && rule.repeat_seconds < 60) throw httpError(400, '重复提醒至少间隔 60 秒');
  if (['disk_percent', 'disk_free'].includes(rule.metric) && !rule.object.startsWith('/')) throw httpError(400, '磁盘规则需要绝对挂载点');
  if (rule.metric === 'bandwidth' && !rule.bandwidth_mbps) throw httpError(400, '带宽规则需要 Mbps 容量');
  if (['offline', 'stale'].includes(rule.metric) && (rule.threshold < 15 || rule.recovery_threshold <= 0 || rule.recovery_threshold > 15)) throw httpError(400, '连接告警等待至少 15 秒，恢复新鲜度须为 1～15 秒');
  if (['cpu', 'memory', 'disk_percent', 'bandwidth'].includes(rule.metric) && (rule.threshold > 100 || rule.recovery_threshold > 100)) throw httpError(400, '百分比须为 0～100');
  if (!['offline', 'stale'].includes(rule.metric) && (rule.metric === 'disk_free' ? rule.recovery_threshold <= rule.threshold : rule.recovery_threshold >= rule.threshold)) throw httpError(400, '恢复阈值必须形成滞回区间');
}
