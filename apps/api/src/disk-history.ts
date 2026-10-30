import type { History, HistoryPoint } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';

type DiskRow = { device: string; minute_ts: bigint; read_bytes: bigint; write_bytes: bigint; observed_seconds: number };

export function diskHistory(db: DB, id: string, start: number, end: number, now: number, step: number,
  points: Map<number, HistoryPoint>, device?: string): History['disk_io'] {
  const devices = (db.prepare('SELECT DISTINCT device FROM disk_minutes WHERE node_id=? AND minute_ts>=? ORDER BY device')
    .all(id, now - 30 * 86400) as { device: string }[]).map(row => row.device);
  const rows = db.prepare(`SELECT device,minute_ts,read_bytes,write_bytes,observed_seconds FROM disk_minutes
    WHERE node_id=? AND minute_ts>=? AND minute_ts<? ${device ? 'AND device=?' : ''} ORDER BY minute_ts`)
    .safeIntegers().all(id, Math.max(start, Math.ceil((now - 30 * 86400) / 60) * 60), end,
      ...device ? [device] : []) as DiskRow[];
  const buckets = new Map<number, Map<string, { read: bigint; write: bigint; seconds: number }>>();
  let read = 0n, write = 0n;
  for (const row of rows) {
    const ts = Math.floor(Number(row.minute_ts) / step) * step;
    const bucket = buckets.get(ts) || new Map();
    const value = bucket.get(row.device) || { read: 0n, write: 0n, seconds: 0 };
    value.read += row.read_bytes; value.write += row.write_bytes; value.seconds += row.observed_seconds;
    bucket.set(row.device, value); buckets.set(ts, bucket);
    read += row.read_bytes; write += row.write_bytes;
  }
  for (const [ts, devices] of buckets) {
    const value = { read_bytes: '0', write_bytes: '0', read_bps: 0, write_bps: 0 };
    for (const device of devices.values()) {
      value.read_bytes = String(BigInt(value.read_bytes) + device.read);
      value.write_bytes = String(BigInt(value.write_bytes) + device.write);
      value.read_bps += Number(device.read) / device.seconds;
      value.write_bps += Number(device.write) / device.seconds;
    }
    points.get(ts)!.disk_io = value;
  }
  return { devices, device: device || null,
    total: { read_bytes: rows.length ? String(read) : null, write_bytes: rows.length ? String(write) : null } };
}
