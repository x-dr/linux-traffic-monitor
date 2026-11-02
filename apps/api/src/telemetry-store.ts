import type { AgentReport, DiagnosticSettings, SyncHealth, TelemetryMinute, TelemetryObject, TelemetryView } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { httpError } from './auth.js';
import { findNode } from './nodes.js';
export type TelemetryStream = 'diagnostics' | 'workloads';
export const serverCapabilities = { probes: 1, diagnostics: 1, workloads: 1 } as const;
export const defaultDiagnosticSettings = (): DiagnosticSettings => ({ diagnostics: { enabled: false, services: [] }, workloads: { enabled: false, docker: false, processes: [] } });
export function diagnosticSettings(db: DB, node: string): DiagnosticSettings {
  const row = db.prepare('SELECT config FROM diagnostic_settings WHERE node_id=?').get(node) as { config: string } | undefined;
  return row ? JSON.parse(row.config) : defaultDiagnosticSettings();
}
export function ingestTelemetry(db: DB, node: string, report: AgentReport, now: number) {
  for (const stream of ['diagnostics','workloads'] as const) {
    if (report[stream] !== undefined && report.capabilities?.[stream] !== 1) throw httpError(400, '指标扩展需要先声明相应能力');
    if(report[stream]===undefined)continue;
    const version=(db.prepare('SELECT config_version FROM agent_extensions WHERE node_id=?').get(node) as {config_version:number}|undefined)?.config_version??1;
    for (const row of report[stream] ?? []) {
      if(row.config_version>version)throw httpError(409,'指标配置版本超出中心版本');
      if (row.minute_ts % 60 || row.minute_ts > now + 5) throw httpError(400, '扩展分钟时间无效');
      const seen = new Set<string>();
      for (const o of row.objects) {
        if (o.observed_at < row.minute_ts || o.observed_at >= row.minute_ts + 60 || o.observed_at > now + 5 || seen.has(o.object)) throw httpError(400, '对象时间或身份重复');
        seen.add(o.object);
        for (const v of Object.values(o.values)) if ((!v.count && (v.avg !== null || v.max !== null || v.last !== null || v.seconds !== 0)) || (v.count > 0 && (v.avg === null || v.max === null || v.avg > v.max!))) throw httpError(400, '指标统计无效');
      }
      if (row.minute_ts < now - 30 * 86400) continue;
      const changed = db.prepare(`INSERT INTO telemetry_minutes VALUES(?,?,?,?,?,?,?) ON CONFLICT(node_id,stream,minute_ts)
        DO UPDATE SET revision=excluded.revision,config_version=excluded.config_version,data=excluded.data
        WHERE excluded.revision>telemetry_minutes.revision`).run(node, report.source_id, stream, row.minute_ts, row.revision, row.config_version, JSON.stringify(row));
      if (changed.changes) markRollupDirty(db, node, stream, row.minute_ts);
    }
  }
  if (report.sync_health) {
    if (report.capabilities?.diagnostics !== 1) throw httpError(400, '同步诊断需要 diagnostics:1');
    db.prepare('INSERT INTO agent_sync_health VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET received_at=excluded.received_at,data=excluded.data')
      .run(node, now, JSON.stringify(report.sync_health));
  }
}
export function markRollupDirty(db: DB, node: string, domain: string, ts: number) {
  db.prepare('INSERT OR IGNORE INTO rollup_dirty VALUES(?,?,?)').run(node, domain, Math.floor(ts / 3600) * 3600);
}
export function latestTelemetry(db: DB, node: string, stream: TelemetryStream, version?:number): TelemetryObject[] {
  const rows = db.prepare('SELECT data FROM telemetry_minutes WHERE node_id=? AND stream=? ORDER BY minute_ts DESC LIMIT 3').all(node,stream) as {data:string}[];
  const objects=new Map<string,TelemetryObject>();
  for(const row of rows){const data=JSON.parse(row.data) as TelemetryMinute;if(version!==undefined&&data.config_version!==version)continue;for(const o of data.objects){if(!objects.has(o.object)||objects.get(o.object)!.observed_at<o.observed_at)objects.set(o.object,o);}}
  return [...objects.values()];
}
export function telemetryView(db: DB, node: string, stream: TelemetryStream, now: number): TelemetryView {
  findNode(db, node);
  const extension = db.prepare('SELECT * FROM agent_extensions WHERE node_id=?').get(node) as { capabilities: string; config_version: number; applied_version: number; error: string | null } | undefined;
  const sync = db.prepare('SELECT data FROM agent_sync_health WHERE node_id=?').get(node) as { data: string } | undefined;
  const settings = diagnosticSettings(db, node);
  return { supported: !!extension && JSON.parse(extension.capabilities)[stream] === 1, enabled: settings[stream].enabled,
    config_version: extension?.config_version ?? 1, applied_version: extension?.applied_version ?? 0, error: extension?.error ?? null, settings,
    latest: latestTelemetry(db, node, stream, extension?.config_version??1).map(o => ({ ...o, fresh: settings[stream].enabled && extension?.applied_version===extension?.config_version && o.status === 'ok' && now - o.observed_at <= Math.max(15, o.interval_seconds * 3) && o.observed_at <= now + 5 })),
    sync: sync ? JSON.parse(sync.data) as SyncHealth : null };
}
