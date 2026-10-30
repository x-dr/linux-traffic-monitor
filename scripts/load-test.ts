import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { buildApp } from '../apps/api/src/app.js';
import { openDatabase, pruneResources } from '../apps/api/src/database.js';
import { createNode, listNodes } from '../apps/api/src/nodes.js';
import { initializeAdmin } from '../apps/api/src/auth.js';
import { EventHub } from '../apps/api/src/events.js';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { AgentReport } from '../packages/contracts/src/index.js';

const root = mkdtempSync(join(tmpdir(), 'traffic-load-'));
const db = openDatabase(join(root, 'control.db'));
const app = await buildApp({ db });
initializeAdmin(db, 'load-test', 'local-load-test-password');
const fixture = JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/report.json', import.meta.url), 'utf8')) as AgentReport;
const duration = Number(process.env.LOAD_SECONDS || 60);
const nodes = Array.from({ length: 50 }, (_, i) => ({ ...createNode(db, { name: `load-${i + 1}` }, Date.now() / 1000), source: randomUUID() }));
const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'load-test', password: 'local-load-test-password' } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const delays: number[] = []; let reports = 0, events = 0;
const session = db.prepare('SELECT token_hash,expires_at FROM sessions').get() as { token_hash: string; expires_at: number };
class Sink extends EventEmitter { write() { events++; return true; } end() { this.emit('close'); } }
const sink = new Sink(), hub = new EventHub(db, () => Date.now() / 1000);
hub.add(sink as unknown as ServerResponse, session.token_hash, session.expires_at);
try {
  const started = performance.now(); let cycle = 0;
  while (performance.now() - started < duration * 1000) {
    const target = started + cycle * 5000;
    if (performance.now() < target) await setTimeout(target - performance.now());
    const now = Date.now() / 1000, minute = Math.floor(now / 60) * 60;
    for (const node of nodes) {
      const value = structuredClone(fixture); value.source_id = node.source; value.snapshot.observed_at = now; value.snapshot.revision = cycle * 3 + 3;
      for (const point of value.traffic) { point.minute_ts = minute; point.revision = cycle * 3 + 1; point.rx_bytes = String((cycle + 1) * 1048576); }
      for (const point of value.resources) { point.minute_ts = minute; point.revision = cycle * 3 + 2; }
      for (const point of value.totals) { point.revision = cycle * 3 + 3; point.rx_bytes = String((cycle + 1) * 1048576); }
      const before = performance.now();
      const response = await app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${node.token}` }, payload: value });
      assert.equal(response.statusCode, 200); delays.push(performance.now() - before); reports++;
    }
    hub.broadcast();
    const overview = await app.inject({ url: '/api/v1/overview', headers: { cookie } });
    assert.equal(overview.json().online, 50);
    const history = await app.inject({ url: `/api/v1/nodes/${nodes[0].id}/history?minutes=43200`, headers: { cookie } });
    assert.equal(history.statusCode, 200); pruneResources(db);
    cycle++;
  }
  const sorted = delays.toSorted((a, b) => a - b);
  assert.equal(listNodes(db).length, 50);
  console.log(JSON.stringify({ agents: 50, interval_seconds: 5, elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(2)), reports, sse_frames: events, mean_ms: Number((delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(2)), p95_ms: Number(sorted[Math.floor(sorted.length * .95)].toFixed(2)), max_ms: Number(sorted.at(-1)!.toFixed(2)) }, null, 2));
} finally { hub.close(); await app.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
