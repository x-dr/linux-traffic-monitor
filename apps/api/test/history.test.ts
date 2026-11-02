import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateDatabase } from '../src/migrations.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { ReportSchema } from '../../../packages/contracts/src/index.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, pruneResources } from '../src/database.js';
import { createNode } from '../src/nodes.js';
import { ingest } from '../src/ingest.js';
import { fixture, setup } from './support.js';
import type { AgentReport, DiskMinute, History } from '../../../packages/contracts/src/index.js';

const disk = (minute: number, device = 'vda', revision = 10, read = '600', write = '300', seconds = 60): DiskMinute =>
  ({ device, minute_ts: minute, revision, read_bytes: read, write_bytes: write, observed_seconds: seconds });

test('shared disk report fixture conforms to the optional v1 extension', () => {
  const report = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/disk-report.json', import.meta.url), 'utf8'));
  assert.equal(Value.Check(ReportSchema, report), true);
});

async function historySetup(t: { after: (fn: () => Promise<void>) => void }) {
  const ctx = await setup(); t.after(ctx.close);
  const node = await ctx.create(), report = ctx.report();
  const send = (value: AgentReport = report) => ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report',
    headers: { authorization: `Bearer ${node.token}` }, payload: value });
  const read = async (query = ''): Promise<History> => {
    const response = await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}/history?minutes=60${query}`, headers: ctx.headers });
    assert.equal(response.statusCode, 200); return response.json();
  };
  return { ...ctx, node, report, send, read };
}

test('network filtering includes retired interfaces and preserves exact totals independently of resource speeds', async t => {
  const ctx = await historySetup(t), minute = ctx.report.traffic[0].minute_ts;
  ctx.report.traffic[0].rx_bytes = '9007199254740993';
  ctx.report.traffic.push({ interface: 'eth1', minute_ts: minute, revision: 8, rx_bytes: '123', tx_bytes: '456' });
  assert.equal((await ctx.send()).statusCode, 200);
  const single = await ctx.read('&interface=eth1');
  assert.deepEqual(single.network.interfaces, ['ens3', 'eth1']);
  assert.deepEqual(single.network.total, { rx_bytes: '123', tx_bytes: '456', total_bytes: '579' });
  const points = single.points.filter(p => p.rx_bytes !== null);
  assert.equal(points.length, 1); assert.equal(points[0].rx_bytes, '123');
  const all = await ctx.read();
  assert.equal(all.network.total.rx_bytes, '9007199254741116');
  const missing = await ctx.read('&interface=retired0');
  assert.equal(missing.network.total.total_bytes, '0');
  assert.equal(missing.points.every(point => point.rx_bytes === null), true);
});

test('disk history remains idempotent under retries and older revisions; large integers stay exact', async t => {
  const ctx = await historySetup(t), minute = ctx.report.traffic[0].minute_ts;
  ctx.report.disk_io = [disk(minute, 'vda', 10, '9007199254740993', '123')];
  ctx.report.snapshot.disk_io = [{ device: 'vda', read_bps: null, write_bps: 0 }];
  for (let i = 0; i < 2; i++) {
    const response = await ctx.send(); assert.equal(response.statusCode, 200); assert.equal(response.json().ack.disk_io, 10);
  }
  const older = structuredClone(ctx.report); older.disk_io![0] = disk(minute, 'vda', 9, '1', '1');
  assert.equal((await ctx.send(older)).statusCode, 200);
  assert.equal((await ctx.read()).disk_io.total.read_bytes, '9007199254740993');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM disk_minutes').get() as { n: number }).n, 1);
  ctx.report.disk_io[0] = disk(minute, 'vda', 11, '9007199254740994', '321');
  await ctx.send();
  const result = await ctx.read('&device=vda');
  assert.equal(result.disk_io.total.read_bytes, '9007199254740994');
  assert.equal(result.disk_io.total.write_bytes, '321');
  const absent = await ctx.read('&device=unplugged');
  assert.deepEqual(absent.disk_io.total, { read_bytes: null, write_bytes: null });
  assert.equal(absent.points.every(p => p.disk_io === null), true);
});

test('hour and UTC day aggregation weight observation time per disk and keep the requested range', async t => {
  const ctx = await historySetup(t);
  const hour = Math.floor(ctx.now() / 3600) * 3600;
  ctx.report.disk_io = [disk(hour, 'vda', 10, '600', '300', 60), disk(hour + 60, 'vda', 11, '600', '300', 30),
    disk(hour + 60, 'vdb', 12, '200', '100', 10)];
  // All minute rows are <= now; future timestamps accepted by ingestion must not leak into history.
  ctx.report.disk_io.push(disk(ctx.report.traffic[0].minute_ts + 60, 'vda', 13, '9999', '9999', 60));
  await ctx.send();
  const result = await ctx.read('&granularity=hour');
  assert.equal(result.step, 3600);
  const point = result.points.find(p => p.ts === hour)!;
  assert.equal(point.disk_io!.read_bytes, '1400');
  assert.equal(point.disk_io!.read_bps, 1200 / 90 + 200 / 10);
  assert.equal(result.disk_io.total.read_bytes, '1400');
  const selected = await ctx.read('&granularity=day&device=vda');
  assert.equal(selected.step, 86400); assert.equal(selected.disk_io.total.read_bytes, '1200');
  assert.equal(selected.start, result.start);
  assert.equal(selected.points.find(p => p.disk_io)!.ts % 86400, 0);
});

test('known zero disk I/O stays zero while missing samples and legacy agents remain unavailable', async t => {
  const ctx = await historySetup(t);
  const oldReply = await ctx.send();
  assert.equal(oldReply.statusCode, 200); assert.equal(oldReply.json().ack.disk_io, undefined);
  assert.deepEqual((await ctx.read()).disk_io.total, { read_bytes: null, write_bytes: null });
  ctx.report.disk_io = [disk(ctx.report.traffic[0].minute_ts, 'vda', 10, '0', '0', 5)];
  await ctx.send();
  const result = await ctx.read();
  assert.deepEqual(result.disk_io.total, { read_bytes: '0', write_bytes: '0' });
  assert.equal(result.points.filter(p => p.disk_io !== null).length, 1);
  assert.equal(result.points.find(p => p.disk_io)!.disk_io!.read_bps, 0);
});

test('disk validation and database failures roll back the entire report', async t => {
  const ctx = await historySetup(t), minute = ctx.report.traffic[0].minute_ts;
  for (const invalid of [disk(minute, 'vda', 10, '9223372036854775808'), disk(minute + 1), disk(minute, 'vda', 10, '1', '1', 0),
    disk(minute, 'vda', 10, '1', '1', 61), disk(minute, '../vda')]) {
    ctx.report.disk_io = [invalid]; assert.equal((await ctx.send()).statusCode, 400);
  }
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 0);
  ctx.report.disk_io = [disk(minute)];
  ctx.db.exec("CREATE TRIGGER fail_disk BEFORE INSERT ON disk_minutes BEGIN SELECT RAISE(ABORT, 'disk failure'); END;");
  assert.equal((await ctx.send()).statusCode, 500);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 0);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM resource_minutes').get() as { n: number }).n, 0);
});

test('disk retention rejects expired backfill and pruning preserves all network history', async t => {
  const ctx = await historySetup(t), minute = ctx.report.traffic[0].minute_ts;
  ctx.report.disk_io = [disk(minute - 31 * 86400), disk(minute, 'vda', 11)];
  await ctx.send();
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM disk_minutes').get() as { n: number }).n, 1);
  pruneResources(ctx.db, ctx.now() + 31 * 86400);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM disk_minutes').get() as { n: number }).n, 0);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 1);
});

test('v1 database upgrades add disk tables and preserve nodes, sessions and old traffic', () => {
  const root = mkdtempSync(join(tmpdir(), 'traffic-v1-upgrade-'));
  try {
    const path = join(root, 'control.db'), old = new Database(path);
    migrateDatabase(old, 2);
    const node = createNode(old, { name: 'existing node' }, fixture.snapshot.observed_at);
    old.exec("CREATE TABLE rollup_dirty(node_id TEXT,domain TEXT,bucket INTEGER,PRIMARY KEY(node_id,domain,bucket))");
    ingest(old, `Bearer ${node.token}`, structuredClone(fixture), fixture.snapshot.observed_at);
    old.exec("DROP TABLE rollup_dirty");
    old.prepare('INSERT INTO sessions VALUES(?,?,?)').run('test-session-hash', 'test-csrf', 9999999999);
    old.exec('DROP TABLE disk_minutes; PRAGMA user_version=1;'); old.close();
    const upgraded = openDatabase(path);
    try {
      assert.equal(upgraded.pragma('user_version', { simple: true }), 6);
      assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n, 1);
      assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM nodes').get() as { n: number }).n, 1);
      assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 1);
      assert.equal((upgraded.prepare('SELECT COUNT(*) n FROM disk_minutes').get() as { n: number }).n, 0);
    } finally { upgraded.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
