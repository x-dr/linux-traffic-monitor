import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from './support.js';
import { cpuRule, monitorSetup, trafficPolicy } from './monitoring-support.js';
import { ingest } from '../src/ingest.js';
import { newEvent } from '../src/alert-store.js';
import { emptyAsset, saveAsset } from '../src/asset-store.js';
import { enqueue } from '../src/notification-queue.js';
import { NotificationWorker } from '../src/notification-worker.js';
import { saveProbeTask, taskById } from '../src/probe-store.js';
import { evaluateQuotas, savePolicy } from '../src/traffic-policy.js';
import { executeReports, reportJobs, reportRuns, saveReportJob } from '../src/reports.js';
import type { DB } from '../src/database.js';
import type { ProbeTaskInput, ReportJobInput } from '../../../packages/contracts/src/index.js';

const probeInput = (node_ids: string[]): ProbeTaskInput => ({ name: '共享探测', kind: 'tcp', target: 'example.com', port: 443,
  family: 'ipv4', interval_seconds: 15, timeout_seconds: 3, node_ids, enabled: true, channel_ids: [] });
const reportInput = (node_ids: string[], channel_ids: string[] = []): ReportJobInput => ({ name: '日报', enabled: true,
  period: 'day', timezone: 'Asia/Shanghai', node_ids, group: '', channel_ids });
function dump(db: DB) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  return tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT * FROM ${name}`).all() }));
}

test('node deletion requires admin session, CSRF and same origin; validates IDs and supports every lifecycle state', async t => {
  const c = await setup(); t.after(c.close);
  const node = await c.create(), url = `/api/v1/nodes/${node.node.id}`;
  for (const [headers, expected] of [
    [{}, 401], [{ authorization: `Bearer ${node.token}` }, 401], [{ cookie: c.cookie }, 403],
    [{ ...c.headers, origin: 'https://other.example' }, 403],
  ] as const) assert.equal((await c.app.inject({ method: 'DELETE', url, headers })).statusCode, expected);
  assert.equal((await c.app.inject({ url, headers: c.headers })).statusCode, 200);
  assert.equal((await c.app.inject({ method: 'DELETE', url: '/api/v1/nodes/invalid', headers: c.headers })).statusCode, 400);
  assert.equal((await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${randomUUID()}`, headers: c.headers })).statusCode, 404);
  for (const state of [{}, { enabled: false }, { archived: true }]) {
    const n = await c.create();
    await c.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${n.node.id}`, headers: c.headers, payload: state });
    const removed = await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${n.node.id}`, headers: c.headers });
    assert.equal(removed.statusCode, 200, removed.body); assert.deepEqual(removed.json(), { ok: true });
    assert.equal((await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${n.node.id}`, headers: c.headers })).statusCode, 404);
  }
});

test('permanent deletion clears all related storage, scrubs shared scopes and reports, and preserves the other node', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const a = c.node, b = await c.create('保留节点'), id = a.node.id;
  const sharedRule = c.rule({ scope: { kind: 'nodes', node_ids: [id, b.node.id], value: '' } });
  const soleRule = c.rule({ scope: { kind: 'nodes', node_ids: [id], value: '' } });
  const sharedProbe = saveProbeTask(c.db, probeInput([id, b.node.id]), c.now() - 100);
  const soleProbe = saveProbeTask(c.db, probeInput([id]), c.now() - 100);
  const reports = [a, b].map(() => c.report());
  for (const [index, n] of [a, b].entries()) {
    ingest(c.db, `Bearer ${n.token}`, reports[index], c.now());
    saveAsset(c.db, n.node.id, { ...emptyAsset(), expires_at: c.now() + 86400, price_minor: 100 }, 0, c.now());
  }
  const event = newEvent(c.db, { node_id: id, rule_id: sharedRule, kind: 'cpu', title: '删除测试', severity: 'warning',
    object: '', state: 'firing', validity: 'fresh', first_anomaly_at: c.now(), fired_at: c.now(), last_anomaly_at: c.now(),
    value: 95, threshold: 90, detail: '' });
  enqueue(c.db, event, [c.channel], 'trigger', c.now());
  savePolicy(c.db, id, { ...trafficPolicy, channel_ids: [c.channel] }, c.now(), 0, 1);
  evaluateQuotas(c.db, c.now());
  c.db.prepare('INSERT INTO alert_states VALUES(?,?,?,?)').run(sharedRule, id, '', '{}');
  c.db.prepare('INSERT INTO disk_minutes VALUES(?,?,?,?,?,?,?)').run(id, 'vda', c.now(), 1, 100, 200, 60);
  c.db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(id, '{}');
  c.db.prepare('INSERT INTO agent_sync_health VALUES(?,?,?)').run(id, c.now(), '{}');
  c.db.prepare('INSERT INTO telemetry_minutes VALUES(?,?,?,?,?,?,?)').run(id, reports[0].source_id, 'diagnostics', c.now(), 1, 1, '{"objects":[]}');
  c.db.prepare('INSERT INTO probe_results VALUES(?,?,?,?,?,?,?,?)').run(id, reports[0].source_id, randomUUID(), sharedProbe.id, 1, 1, c.now(), '{}');
  c.db.prepare('INSERT INTO probe_states(task_id,node_id,version,event_id) VALUES(?,?,?,?)').run(sharedProbe.id, id, 1, event.id);
  c.db.prepare('INSERT INTO probe_certificate_events VALUES(?,?,?,?,?,?)').run(sharedProbe.id, id, 1, c.now(), 14, event.id);
  const registration = (await c.app.inject({ method: 'POST', url: '/api/v1/registration-tokens', headers: c.headers,
    payload: { name: '保留注册令牌', group: '', expires_in: 300, max_uses: 5 } })).json();
  c.db.prepare('INSERT INTO registration_claims VALUES(?,?,?)').run(registration.id, randomUUID(), id);
  c.db.prepare('UPDATE registration_tokens SET uses=1 WHERE id=?').run(registration.id);
  for (const ids of [[id], [id, b.node.id]]) {
    const window = { name: '维护', scope: { kind: 'nodes', node_ids: ids, value: '' }, start_at: c.now(), end_at: c.now() + 60 };
    c.db.prepare('INSERT INTO maintenance_windows VALUES(?,?,?,?)').run(randomUUID(), JSON.stringify(window), window.start_at, window.end_at);
  }
  const globalJob = saveReportJob(c.db, reportInput([], [c.channel]), c.now());
  const sharedJob = saveReportJob(c.db, reportInput([id, b.node.id], [c.channel]), c.now());
  const soleJob = saveReportJob(c.db, reportInput([id], [c.channel]), c.now());
  executeReports(c.db, c.now());
  // Include delayed work and a historical delivery attempt, not just fresh samples.
  c.db.prepare('INSERT OR IGNORE INTO rollup_dirty VALUES(?,?,?)').run(id, 'resource', 0);
  c.db.prepare('INSERT OR IGNORE INTO history_rollups VALUES(?,?,?,?,?,?)').run(id, 'resource', '', 86400, 0, '{}');
  const delivery = c.db.prepare('SELECT id FROM notification_outbox WHERE event_id=?').get(event.id) as { id: string };
  c.db.prepare('INSERT INTO notification_attempts VALUES(?,?,?,?,?)').run(randomUUID(), delivery.id, c.now(), 503, 'test');
  const beforeB = dump(c.db).map(table => ({ ...table, rows: table.rows.filter(row => (row as { node_id?: string }).node_id === b.node.id) }));
  const beforeOverview = (await c.app.inject({ url: '/api/v1/overview', headers: c.headers })).json();
  const removed = await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${id}`, headers: c.headers });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(c.db.pragma('foreign_key_check'), []);
  for (const table of dump(c.db)) {
    assert.ok(table.rows.every(row => (row as { node_id?: string }).node_id !== id), `${table.name} retains deleted-node rows`);
  }
  const afterB = dump(c.db).map(table => ({ ...table, rows: table.rows.filter(row => (row as { node_id?: string }).node_id === b.node.id) }));
  assert.deepEqual(afterB, beforeB);
  assert.equal((await c.app.inject({ url: `/api/v1/nodes/${id}`, headers: c.headers })).statusCode, 404);
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${a.token}` }, payload: reports[0] })).statusCode, 401);
  assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${b.token}` }, payload: reports[1] })).statusCode, 200);
  const nodes = (await c.app.inject({ url: '/api/v1/nodes', headers: c.headers })).json().nodes;
  assert.deepEqual(nodes.map((n: { id: string }) => n.id), [b.node.id]);
  const afterOverview = (await c.app.inject({ url: '/api/v1/overview', headers: c.headers })).json();
  assert.equal(afterOverview.nodes, 1); assert.ok(BigInt(afterOverview.total.total_bytes) < BigInt(beforeOverview.total.total_bytes));
  const rule = (ruleId: string) => JSON.parse((c.db.prepare('SELECT config FROM alert_rules WHERE id=?').get(ruleId) as { config: string }).config);
  assert.deepEqual(rule(sharedRule).scope.node_ids, [b.node.id]); assert.equal(rule(soleRule).enabled, false);
  assert.deepEqual(taskById(c.db, sharedProbe.id).node_ids, [b.node.id]);
  assert.equal(taskById(c.db, sharedProbe.id).version, 1); assert.equal(taskById(c.db, soleProbe.id).archived, true);
  const jobs = reportJobs(c.db);
  assert.equal(jobs.find(j => j.id === soleJob.id)!.enabled, false);
  assert.deepEqual(jobs.find(j => j.id === sharedJob.id)!.node_ids, [b.node.id]);
  assert.equal(jobs.find(j => j.id === globalJob.id)!.version, 1);
  const runs = reportRuns(c.db); assert.equal(runs.length, 3);
  assert.ok(runs.every(run => run.rows.every(row => row.node_id === b.node.id)));
  assert.equal(runs.find(run => run.job_id === soleJob.id)!.rows.length, 0);
  assert.deepEqual(c.db.prepare('SELECT * FROM notification_attempts').all(), []);
  assert.equal((c.db.prepare('SELECT COUNT(*) n FROM notification_outbox').get() as { n: number }).n, 0);
  const token = c.db.prepare('SELECT uses FROM registration_tokens WHERE id=?').get(registration.id) as { uses: number };
  assert.equal(token.uses, 1); assert.ok(c.db.prepare('SELECT 1 FROM notification_channels WHERE id=?').get(c.channel));
});

test('a failure at the final node delete rolls back history, configuration, reports and delivery cleanup', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const id = c.node.node.id;
  c.rule({ scope: { kind: 'nodes', node_ids: [id], value: '' }, duration_seconds: 0, channel_ids: [c.channel] });
  c.sample(); c.tick();
  saveProbeTask(c.db, probeInput([id]), c.now());
  saveReportJob(c.db, reportInput([id], [c.channel]), c.now()); executeReports(c.db, c.now());
  const before = dump(c.db);
  c.db.exec("CREATE TRIGGER prevent_node_delete BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  const response = await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${id}`, headers: c.headers });
  assert.equal(response.statusCode, 500); assert.deepEqual(dump(c.db), before);
  c.db.exec('DROP TRIGGER prevent_node_delete');
  assert.equal((await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${id}`, headers: c.headers })).statusCode, 200);
});

for (const phase of ['trigger', 'report']) test(`deletion while a ${phase} delivery is in flight does not recreate attempts or retry`, async t => {
  const c = await monitorSetup(); t.after(c.close);
  if (phase === 'trigger') { c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick(); }
  else { saveReportJob(c.db, reportInput([c.node.node.id], [c.channel]), c.now()); executeReports(c.db, c.now()); }
  let finish!: (value: { status: number }) => void, calls = 0;
  const worker = new NotificationWorker(c.db, c.key, async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, c.now);
  t.after(() => worker.close());
  const sending = worker.tick();
  assert.equal(calls, 1);
  const response = await c.app.inject({ method: 'DELETE', url: `/api/v1/nodes/${c.node.node.id}`, headers: c.headers });
  finish({ status: 503 }); await sending;
  assert.equal(response.statusCode, 200, response.body);
  c.advance(1000); await worker.tick(); assert.equal(calls, 1);
  assert.deepEqual(c.db.prepare('SELECT * FROM notification_attempts').all(), []);
  assert.deepEqual(c.db.pragma('foreign_key_check'), []);
});
