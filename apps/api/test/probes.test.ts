import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Value } from '@sinclair/typebox/value';
import { FormatRegistry, Type } from '@sinclair/typebox';
import { ExtensionsConfigSchema, ProbeResultSchema, ProbeTaskSchema, ReportSchema, type ProbeTaskInput, type ProbeResult } from '../../../packages/contracts/src/index.js';
import { setup, fixture } from './support.js';
import { ingest } from '../src/ingest.js';
import { extensionsConfig, extensionsView, saveProbeTask } from '../src/probe-store.js';
import { probeHistory } from '../src/probe-history.js';
import { refreshProbeValidity } from '../src/probe-alerts.js';
import { migrateDatabase } from '../src/migrations.js';

const input = (node: string): ProbeTaskInput => ({ name: '应用健康', kind: 'http', target: 'https://example.com/health', port: 0,
  family: 'ipv4', interval_seconds: 15, timeout_seconds: 3, node_ids: [node], channel_ids: [], enabled: true });
function result(task: string, version: number, at: number, revision: number, status: ProbeResult['status'] = 'success'): ProbeResult {
  return { sample_id: randomUUID(), task_id: task, task_version: version, revision, scheduled_at: at, started_at: at + 0.01, completed_at: at + 0.1,
    status, attempts: ['blocked', 'unsupported', 'skipped'].includes(status) ? 0 : 1, latency_ms: status === 'success' ? revision * 10 : null,
    http_status: status === 'success' ? 200 : null, certificate_expires_at: null };
}

test('old Agent remains valid; extensions require explicit capability and return independent config and ACK', async () => {
  const c = await setup(); try {
    const n = await c.create(), report = c.report(), task = saveProbeTask(c.db, input(n.node.id), c.now() - 200);
    let reply = ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.deepEqual(reply.server_capabilities, { probes: 1 }); assert.equal(reply.extensions_config, undefined);
    assert.equal(extensionsView(c.db, n.node.id).supported, false);
    report.probes = []; assert.throws(() => ingest(c.db, `Bearer ${n.token}`, report, c.now()), /协商/);
    report.capabilities = { probes: 1 }; report.applied_extensions_config_version = 0;
    reply = ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.deepEqual(reply.extensions_config, extensionsConfig(c.db, n.node.id)); assert.equal(reply.extensions_config!.probes[0].id, task.id);
    assert.equal(reply.ack.probes, 0); assert.equal(extensionsView(c.db, n.node.id).supported, true);
    report.extensions_config_error = 'persist_failed'; ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.equal(extensionsView(c.db, n.node.id).applied_version, 0);
    assert.equal(extensionsView(c.db, n.node.id).error, 'persist_failed');
    report.applied_extensions_config_version = reply.extensions_config_version! + 10;
    assert.throws(() => ingest(c.db, `Bearer ${n.token}`, report, c.now()), /超出/);
  } finally { await c.close(); }
});

test('probe APIs keep authentication/CSRF, validate target shape, versions and ten-task bounds', async () => {
  const c = await setup(); try {
    const n = await c.create(), payload = input(n.node.id);
    assert.equal((await c.app.inject({ url: '/api/v1/probe-tasks' })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/probe-tasks', headers: { cookie: c.cookie }, payload })).statusCode, 403);
    for (const target of ['https://user:secret@example.com/', 'http://example.com/?token=secret', 'file:///etc/passwd', 'https://example.com/#secret']) {
      assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/probe-tasks', headers: c.headers, payload: { ...payload, target } })).statusCode, 400);
    }
    const created = await c.app.inject({ method: 'POST', url: '/api/v1/probe-tasks', headers: c.headers, payload });
    assert.equal(created.statusCode, 201); const task = created.json();
    assert.equal((await c.app.inject({ method: 'PATCH', url: `/api/v1/probe-tasks/${task.id}`, headers: c.headers, payload })).statusCode, 409);
    for (let i = 0; i < 9; i++) saveProbeTask(c.db, payload, c.now());
    assert.throws(() => saveProbeTask(c.db, payload, c.now()), /10/);
    const edited = await c.app.inject({ method: 'PATCH', url: `/api/v1/probe-tasks/${task.id}`, headers: { ...c.headers, 'if-match': '1' }, payload });
    assert.equal(edited.statusCode, 200);
    const archived = await c.app.inject({ method: 'DELETE', url: `/api/v1/probe-tasks/${task.id}`, headers: c.headers });
    assert.equal(archived.statusCode, 200); assert.equal(c.db.prepare('SELECT 1 FROM probe_tasks WHERE id=? AND archived=1').get(task.id) !== undefined, true);
    assert.equal((await c.app.inject({ url: `/api/v1/nodes/${n.node.id}/probe-history?task_id=${task.id}&minutes=10081`, headers: c.headers })).statusCode, 400);
  } finally { await c.close(); }
});

test('duplicate and late multi-source results preserve history without altering base totals or new task status', async () => {
  const c = await setup(); try {
    const a = await c.create('A'), b = await c.create('B');
    const task = saveProbeTask(c.db, { ...input(a.node.id), node_ids: [a.node.id, b.node.id] }, c.now() - 100);
    const configs = [a, b].map(n => extensionsConfig(c.db, n.node.id).probes[0]);
    const reports = [a, b].map((n, i) => ({ ...c.report(), capabilities: { probes: 1 as const }, probes: [result(task.id, 1, configs[i].start_at, 1000)] }));
    for (let i = 0; i < 2; i++) {
      const n = [a, b][i]; const auth = `Bearer ${n.token}`;
      ingest(c.db, auth, reports[i], c.now()); ingest(c.db, auth, reports[i], c.now());
    }
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as any).n, 2);
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM traffic_totals').get() as any).n, fixture.totals.length * 2);
    const old = result(task.id, 1, configs[0].start_at + 15, 1001, 'tcp');
    saveProbeTask(c.db, { ...input(a.node.id), node_ids: [a.node.id, b.node.id] }, c.now(), task.id, 1);
    ingest(c.db, `Bearer ${a.token}`, { ...reports[0], probes: [old] }, c.now());
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as any).n, 3);
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_states').get() as any).n, 0);
    const invalid = { ...old, revision: 2000, sample_id: randomUUID(), scheduled_at: old.scheduled_at + 1, started_at: old.started_at + 1, completed_at: old.completed_at + 1 };
    assert.throws(() => ingest(c.db, `Bearer ${a.token}`, { ...reports[0], probes: [invalid] }, c.now()), /计划时间/);
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as any).n, 3);
  } finally { await c.close(); }
});

test('failure and recovery counts reset across gaps, unsupported results never imply target failure, stale event stays unknown', async () => {
  const c = await setup(); try {
    const n = await c.create(), task = saveProbeTask(c.db, input(n.node.id), c.now() - 45), cfg = extensionsConfig(c.db, n.node.id).probes[0];
    const report = { ...c.report(), capabilities: { probes: 1 as const }, probes: [] as ProbeResult[] };
    let rev = 1000;
    const send = (slot: number, status: ProbeResult['status']) => {
      const r = result(task.id, 1, cfg.start_at + slot * 15, ++rev, status);
      report.probes = [r]; ingest(c.db, `Bearer ${n.token}`, report, r.completed_at); return r;
    };
    send(0, 'tcp'); send(1, 'tcp'); send(2, 'unsupported'); send(3, 'tcp'); send(5, 'tcp'); send(6, 'tcp');
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM alert_events').get() as any).n, 0);
    const last = send(7, 'timeout');
    assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as any).state, 'firing');
    send(8, 'success'); send(10, 'success'); assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as any).state, 'firing');
    refreshProbeValidity(c.db, last.completed_at + 1000); assert.equal((c.db.prepare('SELECT validity FROM alert_events').get() as any).validity, 'unknown');
    send(11, 'success'); assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as any).state, 'resolved');
  } finally { await c.close(); }
});

test('certificate thresholds deduplicate retries, task edits close events and history quantiles use actual successful samples', async () => {
  const c = await setup(); try {
    const n = await c.create(), task = saveProbeTask(c.db, input(n.node.id), c.now() - 200), cfg = extensionsConfig(c.db, n.node.id).probes[0];
    const report = { ...c.report(), capabilities: { probes: 1 as const }, probes: [] as ProbeResult[] };
    for (let i = 0; i < 5; i++) {
      const r = result(task.id, 1, cfg.start_at + i * 15, i + 1, i === 2 ? 'blocked' : 'success');
      r.certificate_expires_at = cfg.start_at + 2 * 86400;
      report.probes = [r]; ingest(c.db, `Bearer ${n.token}`, report, r.completed_at); ingest(c.db, `Bearer ${n.token}`, report, r.completed_at);
    }
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_certificate_events').get() as any).n, 3);
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM alert_events').get() as any).n, 1);
    const h = probeHistory(c.db, n.node.id, task.id, cfg.start_at + 100, 60);
    assert.equal(h.stats.valid, 4); assert.equal(h.stats.success, 4); assert.equal(h.stats.expected, 7);
    assert.equal(h.stats.availability, 100); assert.equal(h.stats.coverage, 4 / 7 * 100);
    assert.equal(h.stats.p50_ms, 20); assert.equal(h.stats.p95_ms, 50); assert.equal(h.points.filter(p => p.latency_ms === null).length, 3);
    saveProbeTask(c.db, { ...input(n.node.id), enabled: false }, c.now(), task.id, 1);
    assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as any).state, 'closed');
    assert.equal(extensionsConfig(c.db, n.node.id).probes.length, 0);
  } finally { await c.close(); }
});

test('v3 to v4 migration is transactional, preserves existing state and can be retried', () => {
  const db = new Database(':memory:'); try {
    migrateDatabase(db, 3); db.exec("INSERT INTO sessions VALUES('existing','csrf',9999999999)");
    db.exec('CREATE TABLE probe_tasks(conflict TEXT)'); assert.throws(() => migrateDatabase(db), /already exists/);
    assert.equal(db.pragma('user_version', { simple: true }), 3); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='agent_extensions'").get(), undefined);
    db.exec('DROP TABLE probe_tasks'); migrateDatabase(db); assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.ok(db.prepare("SELECT * FROM sessions WHERE token_hash='existing'").get()); assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally { db.close(); }
});

test('actual report validation preserves nulls, accepts failures and never creates an expiry event for a missing certificate', async () => {
  const c = await setup(); try {
    const n = await c.create(), task = saveProbeTask(c.db, input(n.node.id), c.now() - 45), cfg = extensionsConfig(c.db, n.node.id).probes[0];
    const report = { ...c.report(), capabilities: { probes: 1 as const }, probes: [] as ProbeResult[] };
    report.snapshot.cpu_percent = null;
    for (let i = 0; i < 3; i++) report.probes.push(result(task.id, 1, cfg.start_at + i * 15, 1000 + i, 'http'));
    const response = await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${n.token}` }, payload: report });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM alert_events WHERE kind='certificate_expiry'").get() as any).n, 0);
    const raw = JSON.parse((c.db.prepare('SELECT result FROM probe_results LIMIT 1').get() as any).result);
    assert.equal(raw.latency_ms, null); assert.equal(raw.certificate_expires_at, null); assert.equal(raw.http_status, null);
    assert.equal(JSON.parse((c.db.prepare('SELECT snapshot FROM nodes WHERE id=?').get(n.node.id) as any).snapshot).cpu_percent, null);
    assert.equal((c.db.prepare("SELECT COUNT(*) n FROM alert_events WHERE kind='probe_failure'").get() as any).n, 1);
    const replay = structuredClone(report); replay.probes = [report.probes[0]]; replay.probes[0].revision = 2000;
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${n.token}` }, payload: replay })).statusCode, 200);
    assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as any).n, 3);
  } finally { await c.close(); }
});

test('extended fixtures validate; base projection remains accepted by the pre-M2 schema', () => {
  const old = Type.Omit(ReportSchema, ['capabilities', 'probes', 'applied_extensions_config_version', 'extensions_config_error', 'probe_drops']);
  assert.equal(Value.Check(old, fixture), true); assert.equal(Value.Check(ReportSchema, fixture), true);
  assert.equal(Value.Check(old, { ...fixture, capabilities: { probes: 1 } }), false);
  assert.equal(ProbeTaskSchema.additionalProperties, false); assert.equal(ProbeResultSchema.additionalProperties, false); assert.equal(ExtensionsConfigSchema.additionalProperties, false);
  FormatRegistry.Set('uuid', value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value));
  const extended = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/probes.json', import.meta.url), 'utf8'));
  assert.equal(Value.Check(ProbeTaskSchema, extended.task), true); assert.equal(Value.Check(ExtensionsConfigSchema, extended.config), true);
  assert.equal(Value.Check(ProbeResultSchema, extended.result), true);
  assert.equal(Value.Check(ReportSchema, { ...fixture, capabilities: extended.capabilities, probes: [extended.result] }), true);
  const exported = JSON.parse(readFileSync(new URL('../../../packages/contracts/probes.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(exported.definitions.ProbeResult, JSON.parse(JSON.stringify(ProbeResultSchema)));
});
