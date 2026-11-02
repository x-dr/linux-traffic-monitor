import type { DB } from './database.js';
import { digest, type NodeRow } from './nodes.js';
import { httpError } from './auth.js';
import { validateTimezone } from './periods.js';
import { updatePolicyCycle } from './traffic-policy.js';
import type { AgentReport, ReportReply } from '../../../packages/contracts/src/index.js';
import { ingestProbes } from './probe-ingest.js';

const MAX_BYTES = 9223372036854775807n;
function checkBytes(values: { rx_bytes: string; tx_bytes: string }[]) {
  for (const value of values) if (BigInt(value.rx_bytes) > MAX_BYTES || BigInt(value.tx_bytes) > MAX_BYTES) throw httpError(400, '字节累计超出 64 位整数范围');
}
export function ingest(db: DB, authorization: string | undefined, report: AgentReport, now: number): ReportReply {
  if (!authorization?.startsWith('Bearer ')) throw httpError(401, 'Agent 凭据无效');
  const node = db.prepare('SELECT * FROM nodes WHERE token_hash=?').get(digest(authorization.slice(7))) as NodeRow | undefined;
  if (!node) throw httpError(401, 'Agent 凭据无效');
  if (!node.enabled || node.archived) throw httpError(403, '节点已停用或归档');
  if (node.source_id && node.source_id !== report.source_id) throw httpError(409, '采集源发生变化，请创建新节点以保留原历史');
  checkBytes([...report.traffic, ...report.totals]);
  for (const row of report.disk_io || []) {
    if (BigInt(row.read_bytes) > MAX_BYTES || BigInt(row.write_bytes) > MAX_BYTES) throw httpError(400, '磁盘读写超出 64 位整数范围');
  }
  const snapshotBytes = [report.snapshot.memory_total, report.snapshot.memory_available, report.snapshot.swap_total, ...report.snapshot.disks.flatMap(d => [d.total_bytes, d.used_bytes, d.free_bytes])];
  if (snapshotBytes.some(v => BigInt(v) > MAX_BYTES)) throw httpError(400, '容量超出 64 位整数范围');
  for (const point of [...report.traffic, ...report.resources, ...report.disk_io || []]) {
    if (point.minute_ts % 60 || point.minute_ts > now + 300) throw httpError(400, '分钟时间戳无效或采集端时钟超前');
  }
  if (report.snapshot.observed_at > now + 300) throw httpError(400, '采集端时钟超前，请校时');
  if (report.imported_config) validateTimezone(report.imported_config);
  const trafficInsert = db.prepare(`INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)
    ON CONFLICT(node_id,interface,minute_ts) DO UPDATE SET revision=excluded.revision,rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes
    WHERE excluded.revision>traffic_minutes.revision`);
  const totalInsert = db.prepare(`INSERT INTO traffic_totals VALUES(?,?,?,?,?)
    ON CONFLICT(node_id,interface) DO UPDATE SET revision=excluded.revision,rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes
    WHERE excluded.revision>traffic_totals.revision`);
  const resourceInsert = db.prepare(`INSERT INTO resource_minutes VALUES(?,?,?,?)
    ON CONFLICT(node_id,minute_ts) DO UPDATE SET revision=excluded.revision,metrics=excluded.metrics
    WHERE excluded.revision>resource_minutes.revision`);
  const diskInsert = db.prepare(`INSERT INTO disk_minutes VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(node_id,device,minute_ts) DO UPDATE SET revision=excluded.revision,read_bytes=excluded.read_bytes,
      write_bytes=excluded.write_bytes,observed_seconds=excluded.observed_seconds
    WHERE excluded.revision>disk_minutes.revision`);
  let extensions: Partial<ReportReply> = {};
  db.transaction(() => {
    extensions = ingestProbes(db, node, report, now);
    for (const row of report.traffic) trafficInsert.run(node.id, row.interface, row.minute_ts, row.revision, BigInt(row.rx_bytes), BigInt(row.tx_bytes));
    for (const row of report.totals) totalInsert.run(node.id, row.interface, row.revision, BigInt(row.rx_bytes), BigInt(row.tx_bytes));
    for (const row of report.resources) {
      if (row.minute_ts >= now - 30 * 86400) resourceInsert.run(node.id, row.minute_ts, row.revision, JSON.stringify(row.values));
    }
    for (const row of report.disk_io || []) {
      if (row.minute_ts >= now - 30 * 86400) diskInsert.run(node.id, row.device, row.minute_ts, row.revision,
        BigInt(row.read_bytes), BigInt(row.write_bytes), row.observed_seconds);
    }
    if (!node.last_received_at && node.config_version === 1 && report.imported_config) {
      updatePolicyCycle(db, node.id, report.imported_config, now);
      node.config = JSON.stringify(report.imported_config);
      db.prepare('UPDATE nodes SET config=? WHERE id=?').run(node.config, node.id);
    }
    const newer = report.snapshot.revision > node.snapshot_revision;
    db.prepare(`UPDATE nodes SET source_id=?,last_received_at=?,last_sample_received_at=?,snapshot=?,snapshot_revision=?,applied_config_version=?,config_error=? WHERE id=?`)
      .run(report.source_id, now, newer ? now : node.last_sample_received_at, newer ? JSON.stringify(report.snapshot) : node.snapshot,
        newer ? report.snapshot.revision : node.snapshot_revision,
        Math.min(node.config_version, report.applied_config_version), report.config_error, node.id);
  })();
  return {
    ack: {
      traffic: Math.max(0, ...report.traffic.map(row => row.revision)),
      resources: Math.max(0, ...report.resources.map(row => row.revision)),
      totals: Math.max(0, ...report.totals.map(row => row.revision)),
      ...(report.disk_io ? { disk_io: Math.max(0, ...report.disk_io.map(row => row.revision)) } : {}),
      ...(report.probes ? { probes: Math.max(0, ...report.probes.map(row => row.revision)) } : {}),
    },
    config: JSON.parse(node.config), config_version: node.config_version, received_at: now,
    ...extensions,
  };
}
