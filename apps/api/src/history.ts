import type { DB } from './database.js';
import type { History, HistoryFilters, HistoryPoint, MetricKey, ResourceMinute } from '../../../packages/contracts/src/index.js';
import { diskHistory } from './disk-history.js';

export function history(db: DB, id: string, minutes: number, now: number, filters: HistoryFilters = {}): History {
  const step = filters.granularity === 'day' ? 86400 : filters.granularity === 'hour' || minutes > 1440 ? 3600 : 60;
  const endMinute = Math.floor(now / 60) * 60;
  const start = endMinute - (minutes - 1) * 60;
  const points = new Map<number, HistoryPoint>();
  for (let ts = Math.floor(start / step) * step; ts <= endMinute; ts += step) {
    points.set(ts, { ts, duration_seconds: Math.max(1, Math.min(now, ts + step) - Math.max(start, ts)),
      rx_bytes: null, tx_bytes: null, values: null, disk_io: null });
  }
  const traffic = db.prepare(`SELECT minute_ts,rx_bytes,tx_bytes FROM traffic_minutes
    WHERE node_id=? AND minute_ts>=? AND minute_ts<? ${filters.interface ? 'AND interface=?' : ''} ORDER BY minute_ts`)
    .safeIntegers().all(id, start, endMinute + 60, ...filters.interface ? [filters.interface] : []) as
      { minute_ts: bigint; rx_bytes: bigint; tx_bytes: bigint }[];
  let rx = 0n, tx = 0n;
  for (const row of traffic) {
    const point = points.get(Math.floor(Number(row.minute_ts) / step) * step)!;
    point.rx_bytes = String(BigInt(point.rx_bytes || '0') + row.rx_bytes);
    point.tx_bytes = String(BigInt(point.tx_bytes || '0') + row.tx_bytes);
    rx += row.rx_bytes; tx += row.tx_bytes;
  }
  const resources = db.prepare('SELECT minute_ts,metrics FROM resource_minutes WHERE node_id=? AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts')
    .all(id, start, endMinute + 60) as { minute_ts: number; metrics: string }[];
  for (const row of resources) {
    const point = points.get(Math.floor(row.minute_ts / step) * step)!;
    const values = JSON.parse(row.metrics) as ResourceMinute['values'];
    if (!point.values) { point.values = values; continue; }
    for (const key of Object.keys(values) as MetricKey[]) {
      const a = point.values[key], b = values[key];
      if (!a) { point.values[key] = b; continue; }
      const count = a.count + b.count;
      point.values[key] = {
        avg: count ? ((a.avg || 0) * a.count + (b.avg || 0) * b.count) / count : null,
        max: a.max === null ? b.max : b.max === null ? a.max : Math.max(a.max, b.max), count,
      };
    }
  }
  const interfaces = (db.prepare('SELECT DISTINCT interface FROM traffic_minutes WHERE node_id=? ORDER BY interface')
    .all(id) as { interface: string }[]).map(row => row.interface);
  const diskIO = diskHistory(db, id, start, endMinute + 60, now, step, points, filters.device);
  return {
    points: [...points.values()], step, minutes, start, end: now,
    network: { interfaces, interface: filters.interface || null,
      total: { rx_bytes: String(rx), tx_bytes: String(tx), total_bytes: String(rx + tx) } },
    disk_io: diskIO,
  };
}
