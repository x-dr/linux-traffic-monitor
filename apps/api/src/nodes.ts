import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { DB } from './database.js';
import { monthBounds } from './periods.js';
import { defaultConfig, type ByteSummary, type MonitorConfig, type NodeView, type Overview, type Snapshot } from '../../../packages/contracts/src/index.js';
import { monitoringSummary } from './monitoring-summary.js';
import { trafficBetween } from './traffic-accounting.js';
import { reportTiming } from './reporting.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type NodeRow = {
  id: string; name: string; group_name: string; tags: string; token_hash: string;
  enabled: number; archived: number; created_at: number; last_received_at: number | null;
  last_sample_received_at: number | null;
  source_id: string | null; config: string; config_version: number; applied_config_version: number;
  config_error: string | null; snapshot: string | null; snapshot_revision: number;
  enabled_at: number | null;
};
export function findNode(db: DB, id: string) {
  const row = db.prepare('SELECT * FROM nodes WHERE id=?').get(id) as NodeRow | undefined;
  if (!row) throw Object.assign(new Error('节点不存在'), { statusCode: 404 });
  return row;
}
export function createNode(db: DB, data: { name: string; group?: string; tags?: string[] }, now: number) {
  if (!data.name.trim()) throw Object.assign(new Error('名称不能为空'), { statusCode: 400 });
  const id = randomUUID(), token = randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO nodes(id,name,group_name,tags,token_hash,created_at,config) VALUES(?,?,?,?,?,?,?)`)
    .run(id, data.name.trim(), data.group || '', JSON.stringify(data.tags || []), digest(token), now, JSON.stringify(defaultConfig));
  return { id, token };
}

function summary(rows: { rx_bytes: bigint; tx_bytes: bigint }[]): ByteSummary {
  let rx = 0n, tx = 0n;
  for (const row of rows) { rx += row.rx_bytes; tx += row.tx_bytes; }
  return { rx_bytes: String(rx), tx_bytes: String(tx), total_bytes: String(rx + tx) };
}
export function trafficSummary(db: DB, id: string, cfg: MonitorConfig, now: number) {
  const [prev, curr, next] = monthBounds(now, cfg);
  const inPeriod = (from: number, to: number) => {
    const { rx, tx } = trafficBetween(db, id, null, from, to);
    return { rx_bytes: String(rx), tx_bytes: String(tx), total_bytes: String(rx + tx) };
  };
  const total = summary(db.prepare('SELECT rx_bytes,tx_bytes FROM traffic_totals WHERE node_id=?').safeIntegers().all(id) as { rx_bytes: bigint; tx_bytes: bigint }[]);
  return {
    total,
    month: { ...inPeriod(curr.toSeconds(), next.toSeconds()), start: curr.toISO()!, end: next.toISO()! },
    previous_month: { ...inPeriod(prev.toSeconds(), curr.toSeconds()), start: prev.toISO()!, end: curr.toISO()! },
  };
}
export function nodeView(db: DB, row: NodeRow, now = Date.now() / 1000): NodeView {
  const age = row.last_received_at === null ? Infinity : now - row.last_received_at;
  const sampleAge = row.last_sample_received_at === null ? Infinity : now - row.last_sample_received_at;
  const timing = reportTiming(db, row.id);
  const status = row.archived ? 'archived' : !row.enabled ? 'disabled' : row.last_received_at === null ? 'pending' : age > timing.offlineSeconds ? 'offline' : age > timing.staleSeconds || sampleAge > timing.staleSeconds ? 'stale' : 'online';
  const config = JSON.parse(row.config) as MonitorConfig;
  return {
    id: row.id, name: row.name, group: row.group_name, tags: JSON.parse(row.tags),
    enabled: !!row.enabled, archived: !!row.archived, created_at: row.created_at,
    last_received_at: row.last_received_at, source_id: row.source_id, status, config,
    config_version: row.config_version, applied_config_version: row.applied_config_version, config_error: row.config_error,
    snapshot: row.snapshot ? JSON.parse(row.snapshot) as Snapshot : null,
    traffic: trafficSummary(db, row.id, config, now),
    ...monitoringSummary(db, row.id, config, now),
  };
}
export function listNodes(db: DB, now = Date.now() / 1000) {
  return (db.prepare('SELECT * FROM nodes ORDER BY created_at DESC,id').all() as NodeRow[]).map(row => nodeView(db, row, now));
}
export function overview(nodes: NodeView[]): Overview {
  const active = nodes.filter(n => !n.archived && n.enabled);
  const sum = (key: 'total' | 'month') => {
    const rx = active.reduce((v, n) => v + BigInt(n.traffic[key].rx_bytes), 0n);
    const tx = active.reduce((v, n) => v + BigInt(n.traffic[key].tx_bytes), 0n);
    return { rx_bytes: String(rx), tx_bytes: String(tx), total_bytes: String(rx + tx) };
  };
  return {
    nodes: active.length, online: active.filter(n => n.status === 'online').length,
    stale: active.filter(n => n.status === 'stale').length, offline: active.filter(n => n.status === 'offline').length,
    pending: active.filter(n => n.status === 'pending').length,
    rx_bps: active.filter(n => n.status === 'online').reduce((v, n) => v + (n.snapshot?.rx_bps || 0), 0),
    tx_bps: active.filter(n => n.status === 'online').reduce((v, n) => v + (n.snapshot?.tx_bps || 0), 0),
    month: sum('month'), total: sum('total'),
    active_alerts: active.reduce((sum, node) => sum + (node.active_alerts ?? 0), 0),
    quota_attention: active.filter(node => (node.quota_percent ?? 0) >= 80).length,
  };
}
