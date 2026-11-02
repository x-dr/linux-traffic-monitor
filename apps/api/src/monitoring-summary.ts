import type { MonitorConfig, TrafficPolicyInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { monthBounds } from './periods.js';
import { billed, trafficBetween } from './traffic-accounting.js';

export function monitoringSummary(db: DB, node: string, config: MonitorConfig, now: number) {
  const count = db.prepare("SELECT COUNT(*) count FROM alert_events WHERE node_id=? AND state IN ('firing','recovering')").get(node) as { count: number };
  const row = db.prepare('SELECT config FROM traffic_policies WHERE node_id=?').get(node) as { config: string } | undefined;
  const policy = row ? JSON.parse(row.config) as TrafficPolicyInput : null;
  let percent: number | null = null;
  if (policy?.enabled) {
    const [, start, end] = monthBounds(now, config);
    const totals = trafficBetween(db, node, policy.interfaces, start.toSeconds(), end.toSeconds());
    percent = Number(billed(policy.direction, totals.rx, totals.tx) * 10000n / BigInt(policy.quota_bytes)) / 100;
  }
  return { active_alerts: count.count, quota_percent: percent };
}
