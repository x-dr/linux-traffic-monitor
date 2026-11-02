import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { monitorSetup, trafficPolicy } from './monitoring-support.js';
import { billed, trafficBetween } from '../src/traffic-accounting.js';
import { evaluateQuotas, getPolicy, quotaView, savePolicy } from '../src/traffic-policy.js';
import { findNode, nodeView } from '../src/nodes.js';
import type { MonitorConfig } from '../../../packages/contracts/src/index.js';

test('all four billing formulas aggregate before max, preserve BigInt and do not change original totals', async t => {
  const c = await monitorSetup(); t.after(c.close); c.sample(10); const id = c.node.node.id;
  const minute = Math.floor(c.now() / 60) * 60;
  for (const [time, iface, rx, tx] of [[minute - 60, 'ens3', '900', '1'], [minute, 'ens3', '1', '900'], [minute, 'eth1', '9223372036854775807', '9223372036854775807'], [minute - 60, 'eth1', '9223372036854775807', '9223372036854775807']] as const) {
    c.db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)').run(id, iface, time, 1, BigInt(rx), BigInt(tx));
  }
  const separate = trafficBetween(c.db, id, ['ens3'], minute - 60, minute + 60);
  assert.equal(billed('max', separate.rx, separate.tx), 901n);
  assert.equal(billed('sum', separate.rx, separate.tx), 1802n);
  assert.equal(billed('rx', separate.rx, separate.tx), 901n); assert.equal(billed('tx', separate.rx, separate.tx), 901n);
  const before = nodeView(c.db, findNode(c.db, id), c.now()).traffic;
  const policy = savePolicy(c.db, id, { ...trafficPolicy, interfaces: ['ens3', 'eth1'], direction: 'sum' }, c.now(), 0, 1);
  const quota = quotaView(c.db, findNode(c.db, id), policy, c.now());
  assert.equal(quota.billed_bytes, String(4n * 9223372036854775807n + 1802n));
  assert.deepEqual(nodeView(c.db, findNode(c.db, id), c.now()).traffic, before);
});

test('thresholds merge to highest tier and dedupe across repeat evaluation, restart, backfill and past cycles', async t => {
  const c = await monitorSetup(); t.after(c.close); c.sample(10); const id = c.node.node.id, minute = Math.floor(c.now() / 60) * 60;
  savePolicy(c.db, id, { ...trafficPolicy, channel_ids: [c.channel] }, c.now(), 0, 1);
  c.db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)').run(id, 'ens3', minute, 1, 0, 950);
  evaluateQuotas(c.db, c.now()); evaluateQuotas(c.db, c.now());
  assert.equal(c.events().length, 1); assert.equal(c.events()[0].threshold, 90);
  assert.equal((c.db.prepare('SELECT COUNT(*) n FROM traffic_threshold_events').get() as any).n, 2);
  c.engine.restart(); evaluateQuotas(c.db, c.now()); assert.equal(c.events().length, 1);
  c.db.prepare('UPDATE traffic_minutes SET tx_bytes=1100,revision=2 WHERE node_id=?').run(id); evaluateQuotas(c.db, c.now());
  assert.equal(c.events().length, 2); assert.equal(c.events().find(e => e.state === 'firing')?.threshold, 100);
  c.db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)').run(id, 'ens3', minute - 60 * 86400, 3, 0, 100000);
  evaluateQuotas(c.db, c.now()); assert.equal(c.events().length, 2);
  c.advance(35 * 86400); evaluateQuotas(c.db, c.now()); assert.equal(c.events().filter(e => e.state === 'firing').length, 0);
});

test('policy preview and save use explicit versions; invalid quota, scope and stale previews are rejected', async t => {
  const c = await monitorSetup(); t.after(c.close); const id = c.node.node.id;
  const preview = await c.app.inject({ method: 'POST', url: `/api/v1/nodes/${id}/traffic-policy/preview`, headers: c.headers, payload: trafficPolicy });
  assert.equal(preview.statusCode, 200); assert.equal(preview.json().policy_version, 0);
  const save = (version = '0') => c.app.inject({ method: 'PUT', url: `/api/v1/nodes/${id}/traffic-policy`, headers: { ...c.headers, 'if-match': version, 'x-config-version': '1' }, payload: trafficPolicy });
  assert.equal((await save()).statusCode, 200); assert.equal((await save()).statusCode, 409);
  assert.equal((await save('1')).statusCode, 200); assert.equal(getPolicy(c.db, id)!.version, 1);
  for (const input of [{ ...trafficPolicy, quota_bytes: '0' }, { ...trafficPolicy, interfaces: [] }, { ...trafficPolicy, quota_bytes: '-1' }]) {
    assert.equal((await c.app.inject({ method: 'POST', url: `/api/v1/nodes/${id}/traffic-policy/preview`, headers: c.headers, payload: input })).statusCode, 400);
  }
});

test('calendar changes increment policy versions while Agent interface changes keep fixed billing interfaces', async t => {
  const c = await monitorSetup(); t.after(c.close); const id = c.node.node.id;
  savePolicy(c.db, id, trafficPolicy, c.now(), 0, 1);
  const config = JSON.parse(findNode(c.db, id).config) as MonitorConfig;
  assert.equal((await c.app.inject({ method: 'PUT', url: `/api/v1/nodes/${id}/config`, headers: c.headers, payload: { ...config, interfaces: ['other0'] } })).statusCode, 200);
  assert.deepEqual(getPolicy(c.db, id)!.interfaces, ['ens3']); assert.equal(getPolicy(c.db, id)!.version, 1);
  assert.equal((await c.app.inject({ method: 'PUT', url: `/api/v1/nodes/${id}/config`, headers: c.headers, payload: { ...config, month_start_day: 31, timezone: 'America/New_York' } })).statusCode, 200);
  assert.equal(getPolicy(c.db, id)!.version, 2);
  const view = quotaView(c.db, findNode(c.db, id), getPolicy(c.db, id)!, c.now());
  assert.match(view.start, /T00:00:00/); assert.match(view.end, /T00:00:00/);
});

test('first-report legacy config import also versions an existing pending-node traffic policy', async t => {
  const c = await monitorSetup(); t.after(c.close); const id = c.node.node.id;
  savePolicy(c.db, id, trafficPolicy, c.now(), 0, 1);
  const report = c.report(); report.imported_config = { interfaces: ['ens3'], month_start_day: 15, month_start_time: '12:30', timezone: 'UTC' };
  const result = await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${c.node.token}` }, payload: report });
  assert.equal(result.statusCode, 200); assert.equal(getPolicy(c.db, id)!.version, 2);
  assert.equal(result.json().config.month_start_day, 15);
});

function seedDays(c: Awaited<ReturnType<typeof monitorSetup>>, zone: string, omit = 0, zero = false) {
  const id = c.node.node.id, cfg = { ...JSON.parse(findNode(c.db, id).config), timezone: zone };
  c.db.prepare('UPDATE nodes SET config=? WHERE id=?').run(JSON.stringify(cfg), id);
  const today = DateTime.fromSeconds(c.now(), { zone }).startOf('day'), durations: number[] = [];
  c.db.transaction(() => {
    for (let day = 3; day >= 1; day--) {
      const from = today.minus({ days: day }), to = from.plus({ days: 1 }); durations.push(to.toSeconds() - from.toSeconds());
      for (let time = from.toSeconds() + omit * 60; time < to.toSeconds(); time += 60) {
        // RX/TX direction switches across days; max is applied to aggregates.
        c.db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)').run(id, 'ens3', time, time, zero ? 0 : day === 3 ? 120 : 60, zero ? 0 : day === 3 ? 60 : 180);
      }
    }
  })(); return durations;
}

test('forecast requires three valid complete local days, weights actual DST duration and projects each max direction independently', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const target = DateTime.fromISO('2026-11-02T12:00:00', { zone: 'America/New_York' }).toSeconds(); c.advance(target - c.now()); c.sample(10);
  const durations = seedDays(c, 'America/New_York'); assert.ok(durations.includes(25 * 3600));
  const policy = savePolicy(c.db, c.node.node.id, { ...trafficPolicy, direction: 'max', quota_bytes: '10000000' }, c.now(), 0, 1);
  const view = quotaView(c.db, findNode(c.db, c.node.node.id), policy, c.now());
  assert.equal(view.forecast.available, true); assert.equal(view.forecast.days, 3); assert.equal(view.forecast.coverage, 1);
  const seconds = durations.reduce((s, v) => s + v, 0);
  const rx = BigInt(durations[0] / 60 * 120 + (durations[1] + durations[2]) / 60 * 60);
  const tx = BigInt(durations[0] / 60 * 60 + (durations[1] + durations[2]) / 60 * 180);
  const remaining = BigInt(Math.floor(view.remaining_seconds));
  assert.equal(view.forecast.projected_bytes, String(billed('max', BigInt(view.rx_bytes) + rx * remaining / BigInt(seconds), BigInt(view.tx_bytes) + tx * remaining / BigInt(seconds))));
  assert.ok(view.forecast.exhaustion_at! > c.now());
});

test('forecast hides incomplete days and stale samples, distinguishes zero rates and exceeded quotas', async t => {
  const c = await monitorSetup(); t.after(c.close); c.sample(10);
  const policy = savePolicy(c.db, c.node.node.id, trafficPolicy, c.now(), 0, 1);
  seedDays(c, 'Asia/Shanghai', 100);
  assert.equal(quotaView(c.db, findNode(c.db, c.node.node.id), policy, c.now()).forecast.available, false);
  c.db.prepare('DELETE FROM traffic_minutes').run(); seedDays(c, 'Asia/Shanghai', 0, true);
  const zero = quotaView(c.db, findNode(c.db, c.node.node.id), policy, c.now()); assert.equal(zero.forecast.available, true); assert.equal(zero.forecast.exhaustion_at, null); assert.match(zero.forecast.reason, /速率为零/);
  c.db.prepare('INSERT INTO traffic_minutes VALUES(?,?,?,?,?,?)').run(c.node.node.id, 'ens3', Math.floor(c.now() / 60) * 60, 1, 0, 1001);
  assert.equal(quotaView(c.db, findNode(c.db, c.node.node.id), policy, c.now()).forecast.reason, '已超额');
  c.advance(16); assert.equal(quotaView(c.db, findNode(c.db, c.node.node.id), policy, c.now()).forecast.available, false);
});
