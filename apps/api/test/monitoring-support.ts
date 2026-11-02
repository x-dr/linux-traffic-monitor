import { randomBytes, randomUUID } from 'node:crypto';
import type { AlertRuleInput, TrafficPolicyInput } from '../../../packages/contracts/src/index.js';
import { setup } from './support.js';
import { AlertEngine } from '../src/alert-engine.js';
import { ingest } from '../src/ingest.js';
import { encryptSecret } from '../src/webhook-security.js';

export const cpuRule: AlertRuleInput = { name: 'CPU 告警', enabled: true, scope: { kind: 'all', node_ids: [], value: '' }, metric: 'cpu', object: '',
  threshold: 90, duration_seconds: 10, recovery_threshold: 80, recovery_seconds: 10, severity: 'warning', channel_ids: [], repeat_seconds: 0 };
export const trafficPolicy: TrafficPolicyInput = { enabled: true, quota_bytes: '1000', input_unit: 'GB', direction: 'tx', interfaces: ['ens3'], thresholds: [80, 90, 100], channel_ids: [] };
export async function monitorSetup() {
  const key = randomBytes(32);
  const ctx = await setup({ notificationKey: key }), node = await ctx.create(), report = ctx.report(), engine = new AlertEngine(ctx.db);
  let revision = 0;
  const sample = (cpu: number | null = 95, observed = ctx.now(), error: string | null = null, same = false) => {
    report.snapshot.cpu_percent = cpu; report.snapshot.observed_at = observed; report.snapshot.error = error;
    if (!same) report.snapshot.revision = ++revision;
    report.traffic = []; report.resources = []; report.totals = [];
    ingest(ctx.db, `Bearer ${node.token}`, report, ctx.now());
  };
  const rule = (override: Partial<AlertRuleInput> = {}) => {
    const id = randomUUID(); ctx.db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(id, JSON.stringify({ ...cpuRule, ...override })); return id;
  };
  const channel = randomUUID();
  ctx.db.prepare('INSERT INTO notification_channels VALUES(?,?,1,?)').run(channel, '隔离渠道', encryptSecret(key, { url: 'https://8.8.8.8/test-secret', authorization: 'Bearer test-only-secret' }));
  const events = () => ctx.db.prepare('SELECT * FROM alert_events ORDER BY fired_at,id').all() as Record<string, any>[];
  const tick = () => engine.tick(ctx.now());
  return { ...ctx, node, sample, rule, tick, engine, events, key, channel };
}
