import type { ReportingView } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';

export function reportingView(db: DB, node: string): ReportingView {
  const row = db.prepare(`SELECT e.capabilities,e.config_version,e.applied_version,e.error,s.config
    FROM nodes n LEFT JOIN agent_extensions e ON e.node_id=n.id
    LEFT JOIN diagnostic_settings s ON s.node_id=n.id WHERE n.id=?`).get(node) as {
    capabilities: string | null; config_version: number | null; applied_version: number | null;
    error: string | null; config: string | null;
  } | undefined;
  return {
    interval_seconds: row?.config ? JSON.parse(row.config).report_interval_seconds ?? 5 : 5,
    supported: row?.capabilities ? JSON.parse(row.capabilities).reporting === 1 : false,
    config_version: row?.config_version ?? 1, applied_version: row?.applied_version ?? 0,
    error: row?.error ?? null,
  };
}

export function reportTiming(db: DB, node: string) {
  const view = reportingView(db, node);
  // Pending configuration may still be using any previously selected interval.
  const interval = !view.supported ? 5 : view.applied_version === view.config_version ? view.interval_seconds : 15;
  return { staleSeconds: Math.max(15, interval * 3), offlineSeconds: Math.max(45, interval * 9) };
}
