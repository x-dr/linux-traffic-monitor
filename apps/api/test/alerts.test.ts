import test from 'node:test';
import assert from 'node:assert/strict';
import { monitorSetup, cpuRule } from './monitoring-support.js';
import { eventById } from '../src/alert-store.js';

test('resource duration, hysteresis, acknowledge and recovery advance only on new fresh samples', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule();
  c.sample(); c.tick(); assert.equal(c.events().length, 0);
  c.advance(5); c.sample(); c.tick(); c.advance(5); c.sample(); c.tick();
  assert.equal(c.events().length, 1); const id = c.events()[0].id;
  const ack = await c.app.inject({ method: 'POST', url: `/api/v1/alerts/${id}/acknowledge`, headers: c.headers });
  assert.equal(ack.statusCode, 200); assert.equal(ack.json().state, 'firing');
  c.advance(5); c.sample(85); c.tick(); assert.equal(c.events()[0].state, 'firing');
  c.advance(5); c.sample(70); c.tick(); assert.equal(c.events()[0].state, 'recovering');
  c.advance(5); c.sample(70); c.tick(); c.advance(5); c.sample(70); c.tick();
  assert.equal(c.events()[0].state, 'resolved'); assert.ok(c.events()[0].acknowledged_at);
});

test('repeated revisions, stale backfill, null values, errors and future samples never prove health', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, recovery_seconds: 0 });
  c.sample(); c.tick(); const id = c.events()[0].id;
  c.advance(16); c.sample(0, c.now(), null, true); c.tick();
  assert.equal(eventById(c.db, id).state, 'firing'); assert.equal(eventById(c.db, id).validity, 'unknown');
  for (const [cpu, observed, error] of [[0, c.now() - 3600, null], [null, c.now(), null], [0, c.now(), '不可读'], [0, c.now() + 10, null]] as const) {
    c.sample(cpu, observed, error); c.tick(); assert.equal(eventById(c.db, id).state, 'firing'); assert.equal(eventById(c.db, id).validity, 'unknown');
  }
  c.sample(50); c.tick(); assert.equal(eventById(c.db, id).state, 'resolved');
});

test('pending duration resets across gaps and restart does not count service downtime', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule(); c.sample(); c.tick();
  c.advance(20); c.sample(); c.tick(); assert.equal(c.events().length, 0);
  c.advance(5); c.sample(); c.tick(); c.engine.restart(); c.advance(100); c.sample(); c.tick();
  assert.equal(c.events().length, 0);
  for (let i = 0; i < 2; i++) { c.advance(5); c.sample(); c.tick(); }
  assert.equal(c.events().length, 1);
  c.advance(5); c.sample(50); c.tick(); c.engine.restart(); c.advance(100); c.sample(50); c.tick();
  assert.equal(c.events()[0].state, 'recovering');
  c.advance(5); c.sample(50); c.tick(); c.advance(5); c.sample(50); c.tick(); assert.equal(c.events()[0].state, 'resolved');
});

test('offline and stale rules run without ingestion; recovery requires a fresh continuous interval', async t => {
  const c = await monitorSetup(); t.after(c.close);
  c.rule({ metric: 'offline', threshold: 120, duration_seconds: 0, recovery_seconds: 30 });
  c.sample(20); c.tick(); c.advance(121); c.tick(); assert.equal(c.events()[0].kind, 'offline');
  for (let i = 0; i < 6; i++) { c.advance(5); c.sample(20); c.tick(); }
  assert.equal(c.events()[0].state, 'recovering');
  c.advance(5); c.sample(20); c.tick(); assert.equal(c.events()[0].state, 'resolved');
  c.rule({ metric: 'stale', threshold: 120, duration_seconds: 0 });
  c.advance(121); c.sample(20, c.now() - 121, null, true); c.tick();
  assert.equal(c.events().find(e => e.kind === 'stale')?.state, 'firing');
});

test('pending, disabled and archived nodes do not alert; re-enabled nodes get a grace period and no-report event', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ metric: 'offline', threshold: 120, duration_seconds: 0 });
  c.advance(1000); c.tick(); assert.equal(c.events().length, 0);
  c.sample(20); c.advance(121); c.tick(); assert.equal(c.events().length, 1);
  await c.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${c.node.node.id}`, headers: c.headers, payload: { enabled: false } });
  assert.equal(c.events()[0].state, 'closed'); assert.match(c.events()[0].close_reason, /配置关闭/);
  c.advance(100); c.tick(); assert.equal(c.events().length, 1);
  await c.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${c.node.node.id}`, headers: c.headers, payload: { enabled: true } });
  c.tick(); assert.equal(c.events().length, 1);
  c.advance(121); c.tick(); assert.equal(c.events().length, 2);
  assert.ok(c.db.prepare("SELECT 1 FROM node_events WHERE kind='enabled_no_report'").get());
});

test('rule edits, membership changes and archival close with configuration reasons and cancel unsent messages', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const id = c.rule({ duration_seconds: 0, channel_ids: [c.channel], scope: { kind: 'group', value: '测试分组', node_ids: [] } });
  c.sample(); c.tick(); assert.equal(c.events().length, 1);
  await c.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${c.node.node.id}`, headers: c.headers, payload: { group: '其他' } }); c.tick();
  assert.equal(c.events()[0].state, 'closed'); assert.equal((c.db.prepare('SELECT status FROM notification_outbox').get() as { status: string }).status, 'cancelled');
  const edited = await c.app.inject({ method: 'PATCH', url: `/api/v1/alert-rules/${id}`, headers: c.headers, payload: { ...cpuRule, duration_seconds: 0 } });
  assert.equal(edited.statusCode, 200); c.tick(); assert.equal(c.events().length, 2);
  await c.app.inject({ method: 'DELETE', url: `/api/v1/alert-rules/${id}`, headers: c.headers }); assert.equal(c.events()[1].state, 'closed');
});

test('disk object support and bandwidth units are explicit; scopes and invalid hysteresis are rejected', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const noAuth = await c.app.inject({ method: 'POST', url: '/api/v1/alert-rules', payload: cpuRule }); assert.equal(noAuth.statusCode, 401);
  for (const payload of [{ ...cpuRule, recovery_threshold: 95 }, { ...cpuRule, metric: 'bandwidth' }, { ...cpuRule, scope: { kind: 'nodes', node_ids: [], value: '' } }]) {
    assert.equal((await c.app.inject({ method: 'POST', url: '/api/v1/alert-rules', headers: c.headers, payload })).statusCode, 400);
  }
  c.rule({ metric: 'disk_percent', object: '/not-present', duration_seconds: 0 }); c.sample(); c.tick(); assert.equal(c.events().length, 0);
  c.rule({ metric: 'bandwidth', bandwidth_mbps: 1, threshold: 50, duration_seconds: 0 });
  c.sample(); c.tick(); assert.equal(c.events()[0].kind, 'bandwidth');
  const preview = await c.app.inject({ method: 'POST', url: '/api/v1/alert-rules/preview', headers: c.headers, payload: { kind: 'tag', node_ids: [], value: 'test' } });
  assert.equal(preview.json().nodes.length, 1);
});
