import type { TrafficPolicyInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';

export function billed(direction: TrafficPolicyInput['direction'], rx: bigint, tx: bigint) {
  return direction === 'rx' ? rx : direction === 'tx' ? tx : direction === 'sum' ? rx + tx : rx > tx ? rx : tx;
}
export function trafficBetween(db: DB, node: string, interfaces: string[] | null, start: number, end: number) {
  let rx = 0n, tx = 0n;
  const coverage = new Map((interfaces ?? []).map(name => [name, 0]));
  // Split counters into 32-bit limbs before SUM. Each interface/UTC-day group
  // contains at most 1440 aligned minute rows, so both limb sums fit in int64.
  // The time predicate is applied before grouping, preserving arbitrary cycles.
  const query = db.prepare(`SELECT interface,COUNT(*) count,
      SUM(rx_bytes >> 32) rx_high,SUM(rx_bytes & 4294967295) rx_low,
      SUM(tx_bytes >> 32) tx_high,SUM(tx_bytes & 4294967295) tx_low
    FROM traffic_minutes WHERE node_id=? AND minute_ts>=? AND minute_ts<?
    ${interfaces ? `AND interface IN (${interfaces.map(() => '?').join(',')})` : ''}
    GROUP BY interface,minute_ts/86400`).safeIntegers();
  for (const row of query.iterate(node, start, end, ...(interfaces ?? [])) as Iterable<{ interface: string; count: bigint; rx_high: bigint; rx_low: bigint; tx_high: bigint; tx_low: bigint }>) {
    rx += (row.rx_high << 32n) + row.rx_low; tx += (row.tx_high << 32n) + row.tx_low;
    coverage.set(row.interface, (coverage.get(row.interface) ?? 0) + Number(row.count));
  }
  return { rx, tx, coverage };
}
