import test from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import { ReportSchema } from '../../../packages/contracts/src/index.js';
import { fixture, setup, TEST_PASSWORD } from './support.js';
import { pruneResources } from '../src/database.js';

test('shared protocol fixture conforms to JSON Schema', () => assert.equal(Value.Check(ReportSchema, fixture), true));

test('authentication, CSRF, origin and node credentials stay isolated', async t => {
  const ctx = await setup(); t.after(ctx.close);
  assert.equal((await ctx.app.inject('/api/v1/nodes')).statusCode, 401);
  const first = await ctx.create(), second = await ctx.create('节点二');
  const nodes = await ctx.app.inject({ url: '/api/v1/nodes', headers: ctx.headers });
  assert.equal(nodes.statusCode, 200); assert.equal(nodes.body.includes(first.token), false); assert.equal(nodes.body.includes('token_hash'), false);
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/nodes', headers: { cookie: ctx.cookie }, payload: { name: '非法写入' } })).statusCode, 403);
  assert.equal((await ctx.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${first.node.id}`, headers: { ...ctx.headers, origin: 'https://attacker.invalid' }, payload: { name: '伪造' } })).statusCode, 403);
  assert.equal((await ctx.app.inject({ url: '/api/v1/nodes', headers: { authorization: `Bearer ${first.token}` } })).statusCode, 401);
  const report = ctx.report();
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${first.token}` }, payload: report })).statusCode, 200);
  const other = (await ctx.app.inject({ url: `/api/v1/nodes/${second.node.id}`, headers: ctx.headers })).json();
  assert.equal(other.last_received_at, null);
});

test('login rejects invalid credentials, rate limits and logout invalidates session', async t => {
  const ctx = await setup(); t.after(ctx.close);
  for (let i = 0; i < 9; i++) assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'wrong' } })).statusCode, 401);
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: TEST_PASSWORD } })).statusCode, 429);
  assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: ctx.headers })).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: '/api/v1/nodes', headers: ctx.headers })).statusCode, 401);
});

test('password changes require current password and revoke existing sessions', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const call = (current: string) => ctx.app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: ctx.headers, payload: { current_password: current, password: 'replacement-test-password' } });
  assert.equal((await call('wrong')).statusCode, 400);
  assert.equal((await call(TEST_PASSWORD)).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: '/api/v1/auth/session', headers: ctx.headers })).statusCode, 401);
});

test('idempotent and out-of-order reports preserve exact integers and latest snapshot', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const node = await ctx.create(), value = ctx.report();
  value.traffic[0].rx_bytes = value.totals[0].rx_bytes = '9007199254740993';
  const send = (payload: typeof value) => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload });
  const initial = await send(value); assert.equal(initial.statusCode, 200); assert.equal(initial.json().ack.traffic, 1);
  await send(value); // Lost acknowledgement: exact same report is retried.
  const old = structuredClone(value); old.traffic[0].rx_bytes = old.totals[0].rx_bytes = '1'; old.snapshot.hostname = 'old'; old.snapshot.revision = 1;
  await send(old);
  const view = (await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json();
  assert.equal(view.traffic.total.rx_bytes, '9007199254740993'); assert.equal(view.traffic.month.rx_bytes, '9007199254740993'); assert.equal(view.snapshot.hostname, value.snapshot.hostname);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 1);
  value.traffic[0].revision = 4; value.traffic[0].rx_bytes = '9007199254741000'; value.totals[0].revision = 5; value.totals[0].rx_bytes = value.traffic[0].rx_bytes;
  await send(value);
  assert.equal((await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json().traffic.month.rx_bytes, '9007199254741000');
});

test('failed report transactions do not partially store data or mark a node online', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const node = await ctx.create();
  ctx.db.exec("CREATE TRIGGER fail_resource BEFORE INSERT ON resource_minutes BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;");
  const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: ctx.report() });
  assert.equal(response.statusCode, 500);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 0);
  assert.equal((await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json().last_received_at, null);
});

test('rejects source replacement, oversized integers and unsupported protocols', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const node = await ctx.create(), value = ctx.report();
  const send = (payload: unknown) => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  assert.equal((await send(value)).statusCode, 200);
  assert.equal((await send(ctx.report())).statusCode, 409);
  assert.equal((await send({ ...value, protocol_version: 2 })).statusCode, 400);
  value.traffic[0].rx_bytes = '9223372036854775808'; assert.equal((await send(value)).statusCode, 400);
});

test('node status changes with central time; stale speed is excluded from overview', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create();
  const get = async () => (await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json();
  assert.equal((await get()).status, 'pending');
  await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: ctx.report() });
  assert.equal((await get()).status, 'online'); ctx.advance(16); assert.equal((await get()).status, 'stale');
  assert.equal((await ctx.app.inject({ url: '/api/v1/overview', headers: ctx.headers })).json().rx_bps, 0);
  ctx.advance(30); assert.equal((await get()).status, 'offline'); assert.ok((await get()).snapshot);
});

test('a connected Agent repeating an old snapshot is stale rather than healthy', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create(), value = ctx.report();
  const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
  await send(); ctx.advance(16); await send();
  const view = (await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json();
  assert.equal(view.status, 'stale'); assert.equal(view.last_received_at, ctx.now());
  value.snapshot.revision++; value.snapshot.observed_at = ctx.now(); await send();
  assert.equal((await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json().status, 'online');
});

test('configuration imports once, applies by version, and rejects invalid zones', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create(), value = ctx.report();
  value.imported_config = { interfaces: ['ens3'], month_start_day: 15, month_start_time: '08:30', timezone: 'Asia/Shanghai' };
  const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
  assert.equal((await send()).json().config.month_start_day, 15);
  const config = { ...value.imported_config, month_start_day: 31 };
  assert.equal((await ctx.app.inject({ method: 'PUT', url: `/api/v1/nodes/${node.node.id}/config`, headers: ctx.headers, payload: { ...config, timezone: 'invalid/zone' } })).statusCode, 400);
  const saved = await ctx.app.inject({ method: 'PUT', url: `/api/v1/nodes/${node.node.id}/config`, headers: ctx.headers, payload: config });
  assert.equal(saved.json().config_version, 2); value.applied_config_version = 2; value.config_error = 'disk full';
  assert.equal((await send()).json().config.month_start_day, 31);
  const view = (await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers })).json();
  assert.equal(view.applied_config_version, 2); assert.equal(view.config_error, 'disk full');
});

test('resource retention never removes traffic and history gaps remain null', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create(), value = ctx.report();
  const expired = Math.floor((ctx.now() - 31 * 86400) / 60) * 60;
  value.resources[0].minute_ts = expired; value.traffic[0].minute_ts = expired;
  const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
  assert.equal(response.statusCode, 200); assert.equal(response.json().ack.resources, 2);
  pruneResources(ctx.db, ctx.now());
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM resource_minutes').get() as { n: number }).n, 0);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 1);
  const history = (await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}/history?minutes=60`, headers: ctx.headers })).json();
  assert.equal(history.points.length, 60); assert.equal(history.points[0].rx_bytes, null); assert.equal(history.points[0].values, null);
  assert.equal((await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}/history?minutes=43201`, headers: ctx.headers })).statusCode, 400);
});

test('archiving disables ingestion and preserves history; restoring works', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create(), value = ctx.report();
  const send = () => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
  await send();
  const patch = (archived: boolean) => ctx.app.inject({ method: 'PATCH', url: `/api/v1/nodes/${node.node.id}`, headers: ctx.headers, payload: { archived } });
  assert.equal((await patch(true)).json().status, 'archived'); assert.equal((await send()).statusCode, 403);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_totals').get() as { n: number }).n, 1);
  await patch(false); assert.equal((await send()).statusCode, 200);
});
