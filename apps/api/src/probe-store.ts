import { diagnosticSettings } from './telemetry-store.js';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { AgentExtensionsView, ExtensionsConfig, ProbeTask, ProbeTaskInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { httpError } from './auth.js';
import { nodeEvent, validateChannels } from './alert-store.js';

export function taskById(db: DB, id: string): ProbeTask {
  const row = db.prepare('SELECT * FROM probe_tasks WHERE id=?').get(id) as { config: string; version: number; archived: number } | undefined;
  if (!row) throw httpError(404, '探测任务不存在');
  return { ...JSON.parse(row.config), id, version: row.version, archived: !!row.archived };
}
export function validateProbeTarget(input: ProbeTaskInput) {
  if (!input.name.trim()) throw httpError(400, '任务名称不能为空');
  if (input.timeout_seconds >= input.interval_seconds) throw httpError(400, '超时必须小于探测间隔');
  let host = input.target;
  if (input.kind === 'http') {
    let url: URL;
    try { url = new URL(input.target); } catch { throw httpError(400, 'HTTP 目标须为完整 URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || input.target.includes('?') || input.target.includes('#')) throw httpError(400, 'HTTP 目标只允许无凭据、查询参数和片段的 HTTP(S) URL');
    host = url.hostname.replace(/^\[|\]$/g, '');
    if (input.port !== 0) throw httpError(400, 'HTTP 端口请写在 URL 中');
  } else if (!isIP(host) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) throw httpError(400, '目标须为主机名或 IP 地址');
  if (!host || host.includes('%')) throw httpError(400, '目标地址无效');
  if (input.kind === 'tcp' && !input.port) throw httpError(400, 'TCP 需要端口');
  if (input.kind === 'icmp' && input.port) throw httpError(400, 'ICMP 不使用端口');
  if (isIP(host) && isIP(host) !== (input.family === 'ipv4' ? 4 : 6)) throw httpError(400, '目标 IP 与地址族不一致');
}
export function closeProbeEvents(db: DB, task: string, now: number, reason: string, node?: string) {
  const rows = db.prepare("SELECT id FROM alert_events WHERE object=? AND kind IN ('probe_failure','certificate_expiry') AND state IN ('firing','recovering') AND (? IS NULL OR node_id=?)").all(task, node ?? null, node ?? null) as { id: string }[];
  for (const row of rows) {
    db.prepare("UPDATE alert_events SET state='closed',resolved_at=?,close_reason=? WHERE id=?").run(now, reason, row.id);
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE event_id=? AND status IN ('pending','suppressed','sending')").run(row.id);
  }
  db.prepare('DELETE FROM probe_states WHERE task_id=? AND (? IS NULL OR node_id=?)').run(task, node ?? null, node ?? null);
}
export function saveProbeTask(db: DB, input: ProbeTaskInput, now: number, id: string = randomUUID(), expected?: number) {
  validateProbeTarget(input); validateChannels(db, input.channel_ids);
  const old = db.prepare('SELECT version,archived FROM probe_tasks WHERE id=?').get(id) as { version: number; archived: number } | undefined;
  if (old?.archived) throw httpError(409, '任务已归档');
  if (old && expected !== old.version) throw httpError(409, '任务已改变，请刷新后重试');
  for (const node of input.node_ids) {
    findNode(db, node);
    const count = db.prepare(`SELECT COUNT(*) n FROM probe_assignments a JOIN probe_tasks t ON t.id=a.task_id
      WHERE a.node_id=? AND a.end_at IS NULL AND a.task_id<>? AND t.archived=0`).get(node, id) as { n: number };
    if (input.enabled && count.n >= 10) throw httpError(400, '每节点最多启用 10 个探测任务');
  }
  const version = (old?.version ?? 0) + 1;
  db.transaction(() => {
    const previous = db.prepare('SELECT node_id FROM probe_assignments WHERE task_id=? AND end_at IS NULL').all(id) as { node_id: string }[];
    if (old) closeProbeEvents(db, id, now, '探测配置变更');
    db.prepare('INSERT INTO probe_tasks(id,version,config) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config').run(id, version, JSON.stringify(input));
    db.prepare('UPDATE probe_assignments SET end_at=? WHERE task_id=? AND end_at IS NULL').run(now, id);
    if (input.enabled) for (const node of input.node_ids) {
      const offset = [...id + node].reduce((n, c) => n + c.charCodeAt(0), 0) % input.interval_seconds;
      const { kind, target, port, family, interval_seconds, timeout_seconds } = input;
      const config = { id, version, start_at: Math.ceil(now) + offset, kind, target, port, family, interval_seconds, timeout_seconds };
      db.prepare('INSERT INTO probe_assignments VALUES(?,?,?,?,NULL,?)').run(id, node, version, config.start_at, JSON.stringify(config));
    }
    for (const node of new Set([...previous.map(n => n.node_id), ...input.node_ids])) {
      db.prepare('INSERT INTO agent_extensions(node_id) VALUES(?) ON CONFLICT(node_id) DO UPDATE SET config_version=config_version+1').run(node);
      nodeEvent(db, node, 'probe_config_changed', now, `探测任务配置已更新，版本 ${version}`);
    }
  })();
  return taskById(db, id);
}
export function extensionsConfig(db: DB, node: string, capabilities?: {probes?:number;diagnostics?:number;workloads?:number}): ExtensionsConfig {
  const rows = db.prepare('SELECT config FROM probe_assignments WHERE node_id=? AND end_at IS NULL ORDER BY task_id').all(node) as { config: string }[];
  const caps = capabilities ?? {probes:1,diagnostics:1,workloads:1};
  const settings = diagnosticSettings(db, node);
  return { probes: caps.probes === 1 ? rows.map(row => JSON.parse(row.config)) : [],
    ...(caps.diagnostics === 1 ? { diagnostics: settings.diagnostics } : {}),
    ...(caps.workloads === 1 ? { workloads: settings.workloads } : {}) };
}
export function extensionsView(db: DB, node: string): AgentExtensionsView {
  const row = db.prepare('SELECT * FROM agent_extensions WHERE node_id=?').get(node) as { capabilities: string; config_version: number; applied_version: number; error: string | null; drops: string } | undefined;
  return { supported: row ? JSON.parse(row.capabilities).probes === 1 : false, config_version: row?.config_version ?? 1,
    applied_version: row?.applied_version ?? 0, error: row?.error ?? null, drops: row ? JSON.parse(row.drops) : { count: 0, oldest_at: null, newest_at: null } };
}
