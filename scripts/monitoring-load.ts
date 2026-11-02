import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import type { AgentReport, AlertRuleInput, ProbeAssignment, ProbeResult, TrafficPolicyInput } from '../packages/contracts/src/index.js';
import { buildApp } from '../apps/api/src/app.js';
import { openDatabase } from '../apps/api/src/database.js';
import { initializeAdmin } from '../apps/api/src/auth.js';
import { createNode } from '../apps/api/src/nodes.js';
import { EventHub } from '../apps/api/src/events.js';
import { encryptSecret } from '../apps/api/src/webhook-security.js';
import { extensionsConfig, saveProbeTask } from '../apps/api/src/probe-store.js';

const root = mkdtempSync(join(tmpdir(), 'monitoring-load-')), db = openDatabase(join(root, 'control.db'));
const fixture = JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/report.json', import.meta.url), 'utf8')) as AgentReport;
const clock = () => Date.now() / 1000, minute = Math.floor(clock() / 60) * 60, duration = Number(process.env.LOAD_SECONDS || 30);
const channel = randomUUID(), key = randomBytes(32), attempts = new Map<string, number>();
db.prepare('INSERT INTO notification_channels VALUES(?,?,1,?)').run(channel, '模拟负载渠道', encryptSecret(key, { url: 'https://8.8.8.8/', authorization: '' }));
const app = await buildApp({ db, notificationKey: key, webhookSender: async (_s, _payload, id) => {
  const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count); return { status: count === 1 ? 503 : 204 };
} });
initializeAdmin(db, 'load-admin', 'isolated-monitoring-load-password');
const nodes = Array.from({ length: 50 }, (_, i) => ({ ...createNode(db, { name: `synthetic-${i}`, group: 'load-only' }, clock()), source: randomUUID() }));
const withDiagnostics=process.env.LOAD_DIAGNOSTICS==='1';
const withProbes = process.env.LOAD_PROBES === '1', assignments = new Map<string, ProbeAssignment[]>(), sentSlots = new Map<string, number>();
let probeRows = 0, probeRevision = 100000;
const probeResult = (p: ProbeAssignment, at: number): ProbeResult => ({ sample_id: randomUUID(), task_id: p.id, task_version: p.version, revision: ++probeRevision,
  scheduled_at: at, started_at: at, completed_at: at + .05, status: 'success', attempts: 1, latency_ms: 50, http_status: 204, certificate_expires_at: null });
if (withProbes) {
  for (let i = 0; i < 10; i++) saveProbeTask(db, { name: `synthetic-probe-${i}`, kind: 'http', target: 'https://example.com/health', port: 0, family: 'ipv4',
    interval_seconds: 60, timeout_seconds: 3, enabled: true, node_ids: nodes.map(n => n.id), channel_ids: [channel] }, clock() - 7200);
  const insert = db.prepare('INSERT INTO probe_results VALUES(?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const node of nodes) {
      const configs = extensionsConfig(db, node.id).probes; assignments.set(node.id, configs);
      for (const p of configs) for (let at = p.start_at; at < minute - 60; at += 60) {
        const r = probeResult(p, at); insert.run(node.id, node.source, r.sample_id, p.id, p.version, r.revision, at, JSON.stringify(r)); probeRows++;
      }
    }
  })();
}
let resourceRows = 0, trafficRows = 0;
const resources = db.prepare('INSERT INTO resource_minutes VALUES(?,?,1,?)'), traffic = db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,1,600,300)');
db.transaction(() => {
  for (const node of nodes) {
    // Representative 30-day resources at 5-minute stride; network has full 7-day minutes.
    for (let time = minute - 30 * 86400; time < minute; time += 300) { resources.run(node.id, time, JSON.stringify(fixture.resources[0].values)); resourceRows++; }
    for (let time = minute - 7 * 86400; time < minute; time += 60) { traffic.run(node.id, fixture.traffic[0].interface, time); trafficRows++; }
    const policy: TrafficPolicyInput = { enabled: true, quota_bytes: '1000000', input_unit: 'GB', direction: 'sum', interfaces: [fixture.traffic[0].interface], thresholds: [80, 90, 100], channel_ids: [channel] };
    db.prepare('INSERT INTO traffic_policies VALUES(?,?,1,?,0)').run(node.id, JSON.stringify(policy), JSON.stringify({ interfaces: 'auto', month_start_day: 1, month_start_time: '00:00', timezone: 'Asia/Shanghai' }));
  }
})();
const rule: AlertRuleInput = { name: 'CPU load threshold', enabled: true, scope: { kind: 'all', node_ids: [], value: '' }, metric: 'cpu', object: '', threshold: 90,
  duration_seconds: 0, recovery_threshold: 80, recovery_seconds: 0, severity: 'warning', channel_ids: [channel], repeat_seconds: 0 };
db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(randomUUID(), JSON.stringify(rule));
const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'load-admin', password: 'isolated-monitoring-load-password' } });
const cookie = String(login.headers['set-cookie']).split(';')[0], session = db.prepare('SELECT * FROM sessions').get() as any;
let sseFrames = 0;
class Sink extends EventEmitter { write() { sseFrames++; return true; } end() { this.emit('close'); } }
const hub = new EventHub(db, clock); hub.add(new Sink() as unknown as ServerResponse, session.token_hash, session.expires_at);
const diagnosticMs:number[]=[];
const reportMs: number[] = [], overviewMs: number[] = [], historyMs: number[] = [], probeHistoryMs: number[] = [];
const measure = async (url: string, samples: number[]) => {
  const start = performance.now(); const response = await app.inject({ url, headers: { cookie } }); samples.push(performance.now() - start); assert.equal(response.statusCode, 200); return response;
};
try {
  const started = performance.now(); let cycle = 0;
  while (performance.now() - started < duration * 1000) {
    const target = started + cycle * 5000; if (performance.now() < target) await setTimeout(target - performance.now());
    for (const [index, node] of nodes.entries()) {
      const value = structuredClone(fixture), now = clock(); value.source_id = node.source;
      value.snapshot.observed_at = now; value.snapshot.revision = cycle * 3 + 3; value.snapshot.cpu_percent = index % 2 ? 95 : 20;
      for (const row of value.traffic) { row.minute_ts = Math.floor(now / 60) * 60; row.revision = cycle * 3 + 1; }
      for (const row of value.resources) { row.minute_ts = Math.floor(now / 60) * 60; row.revision = cycle * 3 + 2; }
      for (const row of value.totals) row.revision = cycle * 3 + 3;
      if (withProbes) {
        value.capabilities = { probes: 1 }; value.probes = [];
        for (const p of assignments.get(node.id)!) {
          const at = p.start_at + Math.floor((now - .1 - p.start_at) / p.interval_seconds) * p.interval_seconds;
          const key = `${node.id}:${p.id}`;
          if (sentSlots.get(key) !== at) { const r = probeResult(p, at); value.probes.push(r); sentSlots.set(key, at); }
        }
      }
      if(withDiagnostics){
        const version=(db.prepare('SELECT config_version FROM agent_extensions WHERE node_id=?').get(node.id) as {config_version:number}|undefined)?.config_version??1;
        value.capabilities={...value.capabilities,diagnostics:1,workloads:1};value.applied_extensions_config_version=version;
        const stats=(v:number)=>({last:v,avg:v,max:v,count:1,seconds:5});
        value.diagnostics=[{minute_ts:Math.floor(now/60)*60,revision:cycle+100,config_version:version,objects:[{object:'cpu',identity:'load-boot',observed_at:now,interval_seconds:5,status:'ok',values:{iowait_percent:stats(5),steal_percent:stats(1)}}]}];
        value.workloads=[{minute_ts:Math.floor(now/60)*60,revision:cycle+100,config_version:version,objects:[{object:'process:demo',identity:'load-process',observed_at:now,interval_seconds:30,status:'ok',values:{running:stats(1),rss_bytes:stats(1024**2)}}]}];
      }
      const before = performance.now(); const result = await app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
      assert.equal(result.statusCode, 200); reportMs.push(performance.now() - before);
    }
    assert.equal((await measure('/api/v1/overview', overviewMs)).json().nodes, 50);
    await measure(`/api/v1/nodes/${nodes[0].id}/history?minutes=43200`, historyMs); hub.broadcast(); cycle++;
    if(withDiagnostics)await measure(`/api/v1/nodes/${nodes[0].id}/diagnostics-history?minutes=1440&object=cpu`,diagnosticMs);
    if (withProbes) await measure(`/api/v1/nodes/${nodes[0].id}/probe-history?task_id=${assignments.get(nodes[0].id)![0].id}&minutes=10080`, probeHistoryMs);
  }
  const p95 = (values: number[]) => Number(values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * .95))].toFixed(2));
  console.log(JSON.stringify({ agents: 50, resource_rows: resourceRows, resource_days: 30, resource_stride_seconds: 300, traffic_rows: trafficRows, traffic_days: 7,
    interval_seconds: 5, reports: reportMs.length, probe_assignments: withProbes ? 500 : 0, seeded_probe_rows: probeRows, probe_history_p95_ms: withProbes ? p95(probeHistoryMs) : null,
    elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    diagnostic_history_p95_ms:withDiagnostics?p95(diagnosticMs):null,diagnostic_streams:withDiagnostics?100:0,scheduler:db.prepare('SELECT scheduler_lag_ms,last_tick_at FROM control_diagnostics WHERE id=1').get(),rollup_pending:(db.prepare('SELECT COUNT(*) n FROM rollup_dirty').get() as {n:number}).n,
    report_p95_ms: p95(reportMs), overview_p95_ms: p95(overviewMs), history_p95_ms: p95(historyMs), sse_frames: sseFrames,
    events: (db.prepare('SELECT COUNT(*) n FROM alert_events').get() as any).n,
    deliveries: (db.prepare('SELECT status,COUNT(*) count FROM notification_outbox GROUP BY status').all()), notification_transport: 'mock 503 then 204' }, null, 2));
} finally { hub.close(); await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
