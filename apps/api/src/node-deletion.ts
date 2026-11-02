import type { AlertRuleInput, Maintenance, ProbeTaskInput, ReportJobInput, ReportRow } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';

function removeNodeScopes(db: DB, id: string) {
  const rules = db.prepare('SELECT id,config FROM alert_rules').all() as { id: string; config: string }[];
  for (const row of rules) {
    const rule = JSON.parse(row.config) as AlertRuleInput;
    if (!rule.scope.node_ids.includes(id)) continue;
    rule.scope.node_ids = rule.scope.node_ids.filter(node => node !== id);
    if (rule.scope.kind === 'nodes' && !rule.scope.node_ids.length) rule.enabled = false;
    db.prepare('UPDATE alert_rules SET config=? WHERE id=?').run(JSON.stringify(rule), row.id);
  }
  const windows = db.prepare('SELECT id,config FROM maintenance_windows').all() as { id: string; config: string }[];
  for (const row of windows) {
    const window = JSON.parse(row.config) as Maintenance;
    if (!window.scope.node_ids.includes(id)) continue;
    window.scope.node_ids = window.scope.node_ids.filter(node => node !== id);
    db.prepare('UPDATE maintenance_windows SET config=? WHERE id=?').run(JSON.stringify(window), row.id);
  }
  const probes = db.prepare('SELECT id,config,archived FROM probe_tasks').all() as { id: string; config: string; archived: number }[];
  for (const row of probes) {
    const task = JSON.parse(row.config) as ProbeTaskInput;
    if (!task.node_ids.includes(id)) continue;
    task.node_ids = task.node_ids.filter(node => node !== id);
    if (!task.node_ids.length) task.enabled = false;
    // Other executors keep their task version and existing assignments.
    db.prepare('UPDATE probe_tasks SET config=?,archived=? WHERE id=?')
      .run(JSON.stringify(task), task.node_ids.length ? row.archived : 1, row.id);
  }
}

function removeNodeReports(db: DB, id: string) {
  const jobs = db.prepare('SELECT id,config FROM report_jobs').all() as { id: string; config: string }[];
  for (const row of jobs) {
    const job = JSON.parse(row.config) as ReportJobInput;
    if (!job.node_ids.includes(id)) continue;
    job.node_ids = job.node_ids.filter(node => node !== id);
    if (!job.node_ids.length) job.enabled = false;
    db.prepare('UPDATE report_jobs SET config=?,version=version+1 WHERE id=?').run(JSON.stringify(job), row.id);
    db.prepare(`UPDATE notification_outbox SET status='cancelled' WHERE phase='report'
      AND json_extract(payload,'$.report_job_id')=? AND status IN ('pending','suppressed','sending')`).run(row.id);
  }
  const runs = db.prepare('SELECT id,data FROM report_runs WHERE EXISTS (SELECT 1 FROM json_each(report_runs.data) WHERE json_extract(value,\'$.node_id\')=?)')
    .all(id) as { id: string; data: string }[];
  for (const row of runs) {
    const data = (JSON.parse(row.data) as ReportRow[]).filter(node => node.node_id !== id);
    // Retain the run, including empty runs, to preserve period deduplication.
    db.prepare('UPDATE report_runs SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
  }
}

export function deleteNode(db: DB, id: string) {
  db.transaction(() => {
    findNode(db, id);
    removeNodeScopes(db, id);
    removeNodeReports(db, id);

    // Report deliveries have no node_id; remove copies embedded in their payloads too.
    const deliveries = `SELECT id FROM notification_outbox WHERE node_id=?
      OR event_id IN (SELECT id FROM alert_events WHERE node_id=?)
      OR (phase='report' AND EXISTS (SELECT 1 FROM json_each(notification_outbox.payload,'$.rows')
        WHERE json_extract(value,'$.node_id')=?))`;
    db.prepare(`DELETE FROM notification_attempts WHERE delivery_id IN (${deliveries})`).run(id, id, id);
    db.prepare(`DELETE FROM notification_outbox WHERE id IN (${deliveries})`).run(id, id, id);

    // Child tables precede their parents; several legacy tables have no FK.
    for (const table of [
      'traffic_threshold_events', 'asset_threshold_events', 'alert_states', 'probe_states', 'probe_certificate_events',
      'alert_events', 'node_events', 'probe_results', 'probe_assignments', 'agent_extensions',
      'traffic_policies', 'node_assets', 'diagnostic_settings', 'agent_sync_health', 'registration_claims',
      'history_rollups', 'rollup_dirty', 'telemetry_minutes', 'disk_minutes', 'resource_minutes', 'traffic_minutes', 'traffic_totals',
    ]) db.prepare(`DELETE FROM ${table} WHERE node_id=?`).run(id);
    db.prepare('DELETE FROM nodes WHERE id=?').run(id);
  })();
}
