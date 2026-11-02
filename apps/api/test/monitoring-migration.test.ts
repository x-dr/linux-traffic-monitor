import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrateDatabase } from '../src/migrations.js';
import { openDatabase } from '../src/database.js';
import { createNode } from '../src/nodes.js';
import { ingest } from '../src/ingest.js';
import { fixture, TEST_PASSWORD } from './support.js';
import { initializeAdmin } from '../src/auth.js';
import { cpuRule } from './monitoring-support.js';
import { AlertEngine } from '../src/alert-engine.js';
import { NotificationWorker } from '../src/notification-worker.js';
import { encryptSecret, loadNotificationKey } from '../src/webhook-security.js';
import { pruneMonitoring } from '../src/background.js';

test('isolated v2 migration preserves node credentials, sessions, configurations, revisions and all original history', () => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-migrate-'));
  try {
    const path = join(root, 'control.db'), old = new Database(path); migrateDatabase(old, 2);
    initializeAdmin(old, 'migration-admin', TEST_PASSWORD);
    const node = createNode(old, { name: 'v2 existing' }, fixture.snapshot.observed_at);
    old.exec("CREATE TABLE rollup_dirty(node_id TEXT,domain TEXT,bucket INTEGER,PRIMARY KEY(node_id,domain,bucket))");
    ingest(old, `Bearer ${node.token}`, structuredClone(fixture), fixture.snapshot.observed_at);
    old.exec("DROP TABLE rollup_dirty");
    old.prepare('INSERT INTO sessions VALUES(?,?,?)').run('hash-only', 'test-csrf', 9999999999);
    const before = old.prepare('SELECT * FROM nodes').get() as Record<string, unknown>;
    const admin = old.prepare('SELECT * FROM admin').get();
    old.close(); const upgraded = openDatabase(path);
    try {
      const after = upgraded.prepare('SELECT * FROM nodes').get() as Record<string, unknown>; delete after.enabled_at;
      assert.deepEqual(after, before); assert.equal(upgraded.pragma('user_version', { simple: true }), 6);
      assert.deepEqual(upgraded.prepare('SELECT * FROM admin').get(), admin);
      for (const table of ['sessions', 'traffic_minutes', 'traffic_totals', 'resource_minutes']) assert.ok((upgraded.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n > 0);
      assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM alert_rules').get() as any).n, 0); assert.deepEqual(upgraded.pragma('foreign_key_check'), []);
      migrateDatabase(upgraded); assert.equal(upgraded.pragma('user_version', { simple: true }), 6);
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('migration failures roll back the whole monitoring migration and never reinitialize existing tables', () => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-migrate-failure-'));
  try {
    const path = join(root, 'control.db'), old = new Database(path); migrateDatabase(old, 2);
    createNode(old, { name: 'preserve me' }, 1000); old.exec('CREATE TABLE alert_rules(conflict TEXT)'); old.close();
    assert.throws(() => openDatabase(path), /already exists/);
    const check = new Database(path);
    try {
      assert.equal(check.pragma('user_version', { simple: true }), 2);
      assert.equal((check.prepare('SELECT COUNT(*) n FROM nodes').get() as any).n, 1);
      assert.equal((check.pragma('table_info(nodes)') as { name: string }[]).some(c => c.name === 'enabled_at'), false);
    } finally { check.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real database close and reopen retain active events, outbox idempotency keys and separately restored encryption key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-restart-'));
  try {
    const path = join(root, 'control.db'), keyFile = join(root, 'notification.key'), key = randomBytes(32); writeFileSync(keyFile, key, { mode: 0o600 });
    let db = openDatabase(path); const node = createNode(db, { name: 'restart' }, fixture.snapshot.observed_at), channel = randomUUID();
    db.prepare('INSERT INTO notification_channels VALUES(?,?,1,?)').run(channel, 'restart', encryptSecret(key, { url: 'https://8.8.8.8/', authorization: 'Bearer test' }));
    db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(randomUUID(), JSON.stringify({ ...cpuRule, threshold: 1, duration_seconds: 0, channel_ids: [channel] }));
    ingest(db, `Bearer ${node.token}`, structuredClone(fixture), fixture.snapshot.observed_at); new AlertEngine(db).tick(fixture.snapshot.observed_at);
    const before = db.prepare('SELECT * FROM notification_outbox').get() as any; assert.ok(before);
    db.close(); db = openDatabase(path);
    try {
      new AlertEngine(db).restart(); assert.equal((db.prepare('SELECT state FROM alert_events').get() as any).state, 'firing');
      let received = '';
      const worker = new NotificationWorker(db, loadNotificationKey(keyFile), async (_s, _p, key) => { received = key; return { status: 200 }; }, () => fixture.snapshot.observed_at);
      worker.restart(); await worker.tick(); await worker.close();
      assert.equal(received, before.idempotency_key); assert.equal((db.prepare('SELECT status FROM notification_outbox').get() as any).status, 'sent');
      pruneMonitoring(db, fixture.snapshot.observed_at + 181 * 86400);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM alert_events').get() as any).n, 1);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
