import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerResponse } from 'node:http';
import { openDatabase } from '../src/database.js';
import { buildApp } from '../src/app.js';
import { initializeAdmin } from '../src/auth.js';
import { createNode } from '../src/nodes.js';
import { EventHub } from '../src/events.js';
import { ingest } from '../src/ingest.js';
import { fixture, setup, TEST_PASSWORD } from './support.js';

test('center restart preserves sessions, source binding and idempotent history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'traffic-restart-'));
  try {
    const path = join(root, 'control.db'), first = openDatabase(path);
    initializeAdmin(first, 'admin', TEST_PASSWORD);
    const node = createNode(first, { name: 'restart' }, fixture.snapshot.observed_at);
    const before = await buildApp({ db: first, now: () => fixture.snapshot.observed_at });
    const login = await before.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: TEST_PASSWORD } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    ingest(first, `Bearer ${node.token}`, structuredClone(fixture), fixture.snapshot.observed_at);
    await before.close(); first.close();
    const restored = openDatabase(path), after = await buildApp({ db: restored, now: () => fixture.snapshot.observed_at });
    try {
      ingest(restored, `Bearer ${node.token}`, structuredClone(fixture), fixture.snapshot.observed_at);
      const view = await after.inject({ url: `/api/v1/nodes/${node.id}`, headers: { cookie } });
      assert.equal(view.statusCode, 200); assert.equal(view.json().traffic.total.rx_bytes, fixture.totals[0].rx_bytes);
      assert.equal((restored.prepare('SELECT COUNT(*) n FROM traffic_minutes').get() as { n: number }).n, 1);
    } finally { await after.close(); restored.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('SSE snapshots reach multiple clients and session revocation closes streams', async t => {
  const ctx = await setup(); t.after(ctx.close);
  const session = ctx.db.prepare('SELECT * FROM sessions').get() as { token_hash: string; expires_at: number };
  class Sink extends EventEmitter {
    frames: string[] = []; ended = false;
    write(value: string) { this.frames.push(value); return true; }
    end() { this.ended = true; this.emit('close'); }
  }
  const a = new Sink(), b = new Sink(), hub = new EventHub(ctx.db, ctx.now);
  for (const sink of [a, b]) hub.add(sink as unknown as ServerResponse, session.token_hash, session.expires_at);
  await ctx.create(); hub.broadcast();
  for (const sink of [a, b]) { const last = sink.frames.at(-1)!; assert.match(last, /event: snapshot/); assert.match(last, /测试节点/); }
  ctx.db.prepare('DELETE FROM sessions').run(); hub.broadcast();
  assert.equal(a.ended, true); assert.equal(b.ended, true); hub.close();
});

test('hourly history uses weighted averages, maxima and exact byte totals', async t => {
  const ctx = await setup(); t.after(ctx.close); const node = await ctx.create(), value = ctx.report();
  const hour = Math.floor(ctx.now() / 3600) * 3600;
  value.resources[0].minute_ts = hour; value.resources[0].values.cpu_percent = { avg: 10, max: 15, count: 1 };
  const next = structuredClone(value.resources[0]); next.minute_ts += 60; next.revision = 5; next.values.cpu_percent = { avg: 30, max: 35, count: 3 };
  value.resources.push(next); value.traffic[0].minute_ts = hour;
  await ctx.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
  const result = await ctx.app.inject({ url: `/api/v1/nodes/${node.node.id}/history?minutes=10080`, headers: ctx.headers });
  const point = result.json().points.find((p: { ts: number }) => p.ts === hour);
  assert.equal(result.json().step, 3600); assert.equal(point.values.cpu_percent.avg, 25); assert.equal(point.values.cpu_percent.max, 35); assert.equal(point.values.cpu_percent.count, 4);
  assert.equal(point.rx_bytes, value.traffic[0].rx_bytes);
});
