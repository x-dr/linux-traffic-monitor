import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/migrations.js';
import { extensionsConfig, saveProbeTask } from '../src/probe-store.js';
import { setup } from './support.js';
import type { ProbeResult, ProbeTaskInput } from '../../../packages/contracts/src/index.js';

const input = (node: string): ProbeTaskInput => ({
  name: '迁移探测', kind: 'tcp', target: 'example.com', port: 443, family: 'ipv4',
  interval_seconds: 15, timeout_seconds: 3, node_ids: [node], channel_ids: [], enabled: true,
});
const columns = (db: Database.Database) => db.pragma('table_info(probe_states)') as { name: string }[];

test('legacy v5 probe state migrates and rejected Agent batches retry once through failure and recovery', async t => {
  const c = await setup(); t.after(c.close);
  const node = await c.create(), task = saveProbeTask(c.db, input(node.node.id), c.now() - 45);
  const cfg = extensionsConfig(c.db, node.node.id).probes[0];
  c.db.exec('ALTER TABLE probe_states DROP COLUMN first_failure_at; PRAGMA user_version=5;');
  c.db.prepare('INSERT INTO probe_states VALUES(?,?,?,?,?,?,?)').run(task.id, node.node.id, 1, cfg.start_at, 1, 0, null);
  const report = { ...c.report(), capabilities: { probes: 1 as const }, probes: [] as ProbeResult[] };
  const send = () => c.app.inject({ method: 'POST', url: '/api/v1/agent/report',
    headers: { authorization: `Bearer ${node.token}` }, payload: report });
  const sample = (slot: number, status: ProbeResult['status']) => {
    const at = cfg.start_at + slot * cfg.interval_seconds;
    report.probes = [{ sample_id: randomUUID(), task_id: task.id, task_version: 1, revision: 1000 + slot,
      scheduled_at: at, started_at: at + 0.01, completed_at: at + 0.1, status, attempts: 1,
      latency_ms: status === 'success' ? 10 : null, http_status: null, certificate_expires_at: null }];
    if (at + 0.1 > c.now()) c.advance(at + 0.1 - c.now());
  };
  sample(1, 'timeout');
  const rejected = await send();
  assert.equal(rejected.statusCode, 500, rejected.body);
  for (const table of ['probe_results', 'traffic_minutes', 'traffic_totals', 'resource_minutes']) {
    assert.equal((c.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n, 0);
  }
  assert.equal((c.db.prepare('SELECT last_received_at FROM nodes').get() as { last_received_at: number | null }).last_received_at, null);

  migrateDatabase(c.db);
  assert.equal(c.db.pragma('user_version', { simple: true }), 6);
  assert.deepEqual(c.db.prepare('SELECT failures,first_failure_at FROM probe_states').get(), { failures: 1, first_failure_at: cfg.start_at });
  const accepted = await send();
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().ack.probes, 1001);
  assert.equal((await send()).statusCode, 200);
  assert.deepEqual(c.db.prepare('SELECT failures,successes FROM probe_states').get(), { failures: 2, successes: 0 });
  assert.equal((c.db.prepare('SELECT COUNT(*) n FROM probe_results').get() as { n: number }).n, 1);
  assert.equal((c.db.prepare('SELECT rx_bytes FROM traffic_totals').get() as { rx_bytes: number }).rx_bytes, Number(report.totals[0].rx_bytes));
  sample(2, 'timeout'); assert.equal((await send()).statusCode, 200);
  assert.deepEqual(c.db.prepare('SELECT kind,state,first_anomaly_at FROM alert_events').get(),
    { kind: 'probe_failure', state: 'firing', first_anomaly_at: cfg.start_at });
  sample(3, 'success'); assert.equal((await send()).statusCode, 200);
  sample(4, 'success'); assert.equal((await send()).statusCode, 200);
  assert.deepEqual(c.db.prepare('SELECT state FROM alert_events').get(), { state: 'resolved' });
});

test('v4 and v5 seven-column schemas upgrade without losing probe counters or sessions', () => {
  for (const version of [4, 5]) {
    const db = new Database(':memory:');
    try {
      migrateDatabase(db, version);
      // Both historical seven-column databases and newer eight-column databases existed.
      if (columns(db).some(column => column.name === 'first_failure_at')) db.exec('ALTER TABLE probe_states DROP COLUMN first_failure_at');
      db.exec("INSERT INTO sessions VALUES('existing','csrf',9999999999)");
      db.prepare('INSERT INTO probe_states VALUES(?,?,?,?,?,?,?)').run('task', 'node', 2, 120, 2, 0, null);
      migrateDatabase(db);
      assert.equal(db.pragma('user_version', { simple: true }), 6);
      assert.deepEqual(db.prepare('SELECT * FROM probe_states').get(), { task_id: 'task', node_id: 'node', version: 2,
        last_at: 120, failures: 2, successes: 0, event_id: null, first_failure_at: 120 });
      assert.ok(db.prepare("SELECT 1 FROM sessions WHERE token_hash='existing'").get());
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally { db.close(); }
  }
});

test('already extended v5 probe states keep original failure times and migration is repeatable', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db);
    db.exec('PRAGMA user_version=5');
    db.prepare('INSERT INTO probe_states VALUES(?,?,?,?,?,?,?,?)').run('task', 'node', 1, 120, 3, 0, null, 90);
    migrateDatabase(db); migrateDatabase(db);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
    assert.deepEqual(db.prepare('SELECT failures,first_failure_at FROM probe_states').get(), { failures: 3, first_failure_at: 90 });
    assert.equal(columns(db).filter(column => column.name === 'first_failure_at').length, 1);
  } finally { db.close(); }
});

test('failed probe state migration rolls back the column, counters and schema version', () => {
  const db = new Database(':memory:');
  try {
    migrateDatabase(db, 5);
    if (columns(db).some(column => column.name === 'first_failure_at')) db.exec('ALTER TABLE probe_states DROP COLUMN first_failure_at');
    db.prepare('INSERT INTO probe_states VALUES(?,?,?,?,?,?,?)').run('task', 'node', 1, 120, 2, 0, null);
    db.exec("CREATE TRIGGER fail_probe_backfill BEFORE UPDATE ON probe_states BEGIN SELECT RAISE(ABORT, 'simulated migration failure'); END");
    assert.throws(() => migrateDatabase(db), /simulated migration failure/);
    assert.equal(db.pragma('user_version', { simple: true }), 5);
    assert.equal(columns(db).some(column => column.name === 'first_failure_at'), false);
    assert.deepEqual(db.prepare('SELECT failures FROM probe_states').get(), { failures: 2 });
    db.exec('DROP TRIGGER fail_probe_backfill'); migrateDatabase(db);
    assert.equal(db.pragma('user_version', { simple: true }), 6);
  } finally { db.close(); }
});
