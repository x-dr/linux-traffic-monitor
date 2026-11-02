import type { ProbeAssignment, ProbeResult } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { eventById, newEvent } from './alert-store.js';
import { enqueue, enqueueRecovery } from './notification-queue.js';
import { taskById } from './probe-store.js';

export const validProbe = (r: ProbeResult) => r.attempts === 1 && !['unsupported', 'blocked', 'skipped'].includes(r.status);
type State = { version: number; last_at: number; failures: number; successes: number; event_id: string | null; first_failure_at: number };
export function evaluateProbe(db: DB, node: string, config: ProbeAssignment, result: ProbeResult, now: number) {
  const task = taskById(db, result.task_id);
  if (task.archived || !task.enabled || task.version !== result.task_version || now - result.completed_at > Math.max(15, config.interval_seconds * 3) || result.completed_at > now + 5) return;
  const previous = db.prepare('SELECT * FROM probe_states WHERE task_id=? AND node_id=?').get(task.id, node) as State | undefined;
  const state: State = previous ?? { version: task.version, last_at: 0, failures: 0, successes: 0, event_id: null, first_failure_at: 0 };
  if (result.scheduled_at <= state.last_at) return;
  if (result.scheduled_at - state.last_at > config.interval_seconds * 1.5 || !validProbe(result)) { state.failures = 0; state.successes = 0; }
  if (state.event_id && !['firing', 'recovering'].includes(eventById(db, state.event_id).state)) state.event_id = null;
  const resolve = (id: string, reason: string) => {
    db.prepare("UPDATE alert_events SET state='resolved',resolved_at=?,close_reason=?,validity='fresh' WHERE id=?").run(now, reason, id);
    enqueueRecovery(db, eventById(db, id), task.channel_ids, now);
  };
  const fire = (kind: string, title: string, value: number, threshold: number) => {
    const event = newEvent(db, { node_id: node, rule_id: null, kind, title, severity: 'warning', object: task.id,
      state: 'firing', validity: 'fresh', first_anomaly_at: kind === 'probe_failure' ? state.first_failure_at : result.scheduled_at, fired_at: now, last_anomaly_at: result.completed_at,
      value, threshold, detail: `${task.name}；探测任务 v${task.version}；从网络质量页面查看观测与覆盖率` });
    enqueue(db, event, task.channel_ids, 'trigger', now); return event.id;
  };
  if (validProbe(result)) {
    if (result.status === 'success') { state.successes++; state.failures = 0; }
    else { if (!state.failures) state.first_failure_at = result.scheduled_at; state.failures++; state.successes = 0; }
    if (!state.event_id && state.failures >= 3) state.event_id = fire('probe_failure', `${task.name}：连续探测失败`, state.failures, 3);
    if (state.event_id) {
      db.prepare("UPDATE alert_events SET validity='fresh',value=?,last_anomaly_at=CASE WHEN ?>0 THEN ? ELSE last_anomaly_at END WHERE id=?").run(state.failures, state.failures, result.completed_at, state.event_id);
      if (state.successes >= 2) { resolve(state.event_id, '连续两次探测成功'); state.event_id = null; }
    }
  } else if (state.event_id) db.prepare("UPDATE alert_events SET validity='unknown' WHERE id=?").run(state.event_id);
  db.prepare(`INSERT INTO probe_states(task_id,node_id,version,last_at,failures,successes,event_id,first_failure_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,node_id) DO UPDATE SET
    version=excluded.version,last_at=excluded.last_at,failures=excluded.failures,successes=excluded.successes,event_id=excluded.event_id,first_failure_at=excluded.first_failure_at`)
    .run(task.id, node, task.version, result.scheduled_at, state.failures, state.successes, state.event_id, state.first_failure_at);
  if (result.certificate_expires_at === null || !validProbe(result)) {
    db.prepare("UPDATE alert_events SET validity='unknown' WHERE node_id=? AND object=? AND kind='certificate_expiry' AND state='firing'").run(node, task.id); return;
  }
  const expires = result.certificate_expires_at, days = (expires - result.completed_at) / 86400;
  const active = db.prepare(`SELECT DISTINCT e.id FROM probe_certificate_events c JOIN alert_events e ON e.id=c.event_id
    WHERE c.task_id=? AND c.node_id=? AND e.state='firing'`).all(task.id, node) as { id: string }[];
  // A new certificate, including one already near expiry, closes the previous evidence.
  for (const event of active) {
    const old = db.prepare('SELECT expires_at FROM probe_certificate_events WHERE event_id=?').get(event.id) as { expires_at: number };
    if (old.expires_at !== expires || days > 14) resolve(event.id, '证书已更新或远离到期阈值');
    else db.prepare("UPDATE alert_events SET validity='fresh',value=?,last_anomaly_at=? WHERE id=?").run(Math.max(0, days), result.completed_at, event.id);
  }
  const crossed = [14, 7, 3].filter(threshold => days <= threshold && !db.prepare('SELECT 1 FROM probe_certificate_events WHERE task_id=? AND node_id=? AND version=? AND expires_at=? AND threshold=?').get(task.id, node, task.version, expires, threshold));
  if (!crossed.length) return;
  const threshold = Math.min(...crossed);
  const event = fire('certificate_expiry', `${task.name}：证书不足 ${threshold} 天`, Math.max(0, days), threshold);
  for (const tier of crossed) db.prepare('INSERT INTO probe_certificate_events VALUES(?,?,?,?,?,?)').run(task.id, node, task.version, expires, tier, event);
}

export function refreshProbeValidity(db: DB, now: number) {
  db.prepare(`UPDATE alert_events SET validity='unknown' WHERE kind IN ('probe_failure','certificate_expiry') AND state='firing'
    AND id IN (SELECT e.id FROM alert_events e JOIN probe_tasks t ON t.id=e.object
      LEFT JOIN probe_states s ON s.task_id=t.id AND s.node_id=e.node_id
      WHERE s.last_at IS NULL OR s.last_at<?-3*json_extract(t.config,'$.interval_seconds'))`).run(now);
}
