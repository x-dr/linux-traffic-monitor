import type { AgentReport, ReportReply, ProbeAssignment, ProbeResult } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import type { NodeRow } from './nodes.js';
import { httpError } from './auth.js';
import { isDeepStrictEqual } from 'node:util';
import { extensionsConfig, extensionsView } from './probe-store.js';
import { evaluateProbe } from './probe-alerts.js';

export function ingestProbes(db: DB, node: NodeRow, report: AgentReport, now: number): Partial<ReportReply> {
  const extra = report.probes !== undefined || report.applied_extensions_config_version !== undefined || report.extensions_config_error !== undefined || report.probe_drops !== undefined;
  if (extra && report.capabilities?.probes !== 1) throw httpError(400, '探测扩展需要协商 probes:1');
  if (!report.capabilities) return { server_capabilities: { probes: 1 } };
  db.prepare(`INSERT INTO agent_extensions(node_id,capabilities) VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET capabilities=excluded.capabilities`).run(node.id, JSON.stringify(report.capabilities));
  if (report.capabilities.probes !== 1) return { server_capabilities: { probes: 1 } };
  const view = extensionsView(db, node.id);
  if ((report.applied_extensions_config_version ?? 0) > view.config_version) throw httpError(409, '扩展配置确认超出中心版本，请检查是否恢复过中心数据库');
  db.prepare('UPDATE agent_extensions SET applied_version=?,error=?,drops=? WHERE node_id=?').run(report.applied_extensions_config_version ?? 0,
    report.extensions_config_error ?? null, JSON.stringify(report.probe_drops ?? view.drops), node.id);
  const insert = db.prepare('INSERT OR IGNORE INTO probe_results VALUES(?,?,?,?,?,?,?,?)');
  for (const result of [...report.probes ?? []].sort((a, b) => a.scheduled_at - b.scheduled_at)) {
    validateResult(result, now);
    const assignment = db.prepare('SELECT config,end_at FROM probe_assignments WHERE task_id=? AND node_id=? AND version=?').get(result.task_id, node.id, result.task_version) as { config: string; end_at: number | null } | undefined;
    // Unknown versions are rejected, so a bad batch never receives a misleading ACK.
    if (!assignment) throw httpError(400, '探测结果不属于该节点的已知分配');
    const config: ProbeAssignment = JSON.parse(assignment.config);
    const slot = (result.scheduled_at - config.start_at) / config.interval_seconds;
    if (slot < 0 || Math.abs(slot - Math.round(slot)) > 0.001 || (assignment.end_at !== null && result.scheduled_at >= assignment.end_at)) throw httpError(400, '探测计划时间不属于任务分配');
    if (result.scheduled_at < now - 7 * 86400) continue;
    const changed = insert.run(node.id, report.source_id, result.sample_id, result.task_id, result.task_version, result.revision, result.scheduled_at, JSON.stringify(result));
    if (!changed.changes) {
      const existing = db.prepare('SELECT result FROM probe_results WHERE node_id=? AND source_id=? AND sample_id=?').get(node.id, report.source_id, result.sample_id) as { result: string } | undefined;
      if (!existing) throw httpError(409, '探测结果身份或 revision 冲突');
      const { revision: oldRevision, ...old } = JSON.parse(existing.result) as ProbeResult;
      const { revision, ...incoming } = result;
      if (!isDeepStrictEqual(old, incoming)) throw httpError(409, '探测结果身份冲突');
      if (revision > oldRevision) {
        if (db.prepare('SELECT 1 FROM probe_results WHERE node_id=? AND source_id=? AND revision=?').get(node.id, report.source_id, revision)) throw httpError(409, '探测 revision 冲突');
        db.prepare('UPDATE probe_results SET revision=?,result=? WHERE node_id=? AND source_id=? AND sample_id=?').run(revision, JSON.stringify(result), node.id, report.source_id, result.sample_id);
      }
    }
    if (changed.changes && assignment.end_at === null) evaluateProbe(db, node.id, config, result, now);
  }
  return { server_capabilities: { probes: 1 }, extensions_config: extensionsConfig(db, node.id), extensions_config_version: view.config_version };
}
function validateResult(r: ProbeResult, now: number) {
  if (r.scheduled_at > r.started_at || r.started_at > r.completed_at || r.completed_at > now + 300 || r.completed_at - r.started_at > 15) throw httpError(400, '探测结果时间无效');
  const valid = !['unsupported', 'blocked', 'skipped'].includes(r.status);
  if (r.attempts !== (valid ? 1 : 0) || (r.status === 'success' && r.latency_ms === null) || (r.status !== 'success' && r.latency_ms !== null)) throw httpError(400, '探测结果次数或耗时无效');
}
