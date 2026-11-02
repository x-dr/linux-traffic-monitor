import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support.js';
import { ingest } from '../src/ingest.js';
import { findNode, nodeView } from '../src/nodes.js';
import { diagnosticSettings } from '../src/telemetry-store.js';
import { reportTiming, reportingView } from '../src/reporting.js';
import { AlertEngine, resourceFresh } from '../src/alert-engine.js';
import { cpuRule } from './monitoring-support.js';
import { randomUUID } from 'node:crypto';

test('source conflicts block reporting capabilities and log only the reason; the original source can resume', async () => {
  const c = await setup();
  const warnings = mock.method(c.app.log, 'warn', () => {});
  try {
    const n = await c.create(), original = c.report();
    ingest(c.db, `Bearer ${n.token}`, original, c.now());
    const changed = structuredClone(original);
    changed.source_id = randomUUID();
    changed.capabilities = { reporting: 1 };
    const rejected = await c.app.inject({ method: 'POST', url: '/api/v1/agent/report',
      headers: { authorization: `Bearer ${n.token}` }, payload: changed });
    assert.equal(rejected.statusCode, 409, rejected.body);
    const reason = '采集源发生变化，请创建新节点以保留原历史';
    assert.equal(rejected.json().error, reason);
    assert.equal(reportingView(c.db, n.node.id).supported, false);
    assert.equal(findNode(c.db, n.node.id).source_id, original.source_id);
    assert.equal(warnings.mock.calls.length, 1);
    assert.deepEqual(warnings.mock.calls[0].arguments, [{ statusCode: 409, reason }, 'Agent 上报冲突']);
    assert.equal(JSON.stringify(warnings.mock.calls[0].arguments).includes(n.token), false);
    original.capabilities = { reporting: 1 };
    const resumed = await c.app.inject({ method: 'POST', url: '/api/v1/agent/report',
      headers: { authorization: `Bearer ${n.token}` }, payload: original });
    assert.equal(resumed.statusCode, 200, resumed.body);
    assert.equal(reportingView(c.db, n.node.id).supported, true);
  } finally { warnings.mock.restore(); await c.close(); }
});

test('reporting settings validate all five options, require auth and CSRF, preserve settings and reject races', async () => {
  const c = await setup();
  try {
    const n = await c.create(), url = `/api/v1/nodes/${n.node.id}/reporting`;
    assert.equal((await c.app.inject({ url })).statusCode, 401);
    assert.equal(reportingView(c.db, n.node.id).interval_seconds, 5);
    const payload = { interval_seconds: 1, expected_version: 1 };
    assert.equal((await c.app.inject({ method: 'PUT', url, payload })).statusCode, 401);
    assert.equal((await c.app.inject({ method: 'PUT', url, headers: { cookie: c.cookie, origin: 'http://localhost' }, payload })).statusCode, 403);
    for (const interval of [0, 2, 4, 16, -1, 1.5, null]) {
      const result = await c.app.inject({ method: 'PUT', url, headers: c.headers, payload: { ...payload, interval_seconds: interval } });
      assert.equal(result.statusCode, 400, result.body);
    }
    for (const [index, interval] of [1, 3, 5, 10, 15].entries()) {
      const result = await c.app.inject({ method: 'PUT', url, headers: c.headers, payload: { interval_seconds: interval, expected_version: index + 1 } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal(result.json().interval_seconds, interval);
      assert.equal(result.json().config_version, index + 2);
      assert.equal(result.json().supported, false);
    }
    assert.equal((await c.app.inject({ method: 'PUT', url, headers: c.headers, payload })).statusCode, 409);
    const settings = { diagnostics: { enabled: true, services: [] }, workloads: { enabled: false, docker: false, processes: [] } };
    const response = await c.app.inject({ method: 'PUT', url: `/api/v1/nodes/${n.node.id}/diagnostic-settings`, headers: c.headers, payload: { ...settings, expected_version: 6 } });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(diagnosticSettings(c.db, n.node.id), { ...settings, report_interval_seconds: 15 });
    assert.equal((await c.app.inject({ method: 'PUT', url, headers: c.headers, payload: { interval_seconds: 3, expected_version: 7 } })).statusCode, 200);
    assert.deepEqual(diagnosticSettings(c.db, n.node.id), { ...settings, report_interval_seconds: 3 });
  } finally { await c.close(); }
});

test('reporting capability gates config and acknowledgement; long and pending intervals keep valid samples fresh', async () => {
  const c = await setup();
  try {
    const n = await c.create(), id = n.node.id, report = c.report(), url = `/api/v1/nodes/${id}/reporting`;
    await c.app.inject({ method: 'PUT', url, headers: c.headers, payload: { interval_seconds: 15, expected_version: 1 } });
    let reply = ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.equal(reply.server_capabilities?.reporting, 1);
    assert.equal(reply.extensions_config, undefined);
    report.capabilities = { diagnostics: 1 };
    reply = ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.equal(reply.extensions_config?.report_interval_seconds, undefined);
    assert.equal(reportingView(c.db, id).supported, false);
    report.capabilities = { reporting: 1 };
    const response = await c.app.inject({ method: 'POST', url: '/api/v1/agent/report', headers: { authorization: `Bearer ${n.token}` }, payload: report });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().extensions_config.report_interval_seconds, 15);
    report.applied_extensions_config_version = 2;
    ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.deepEqual(reportTiming(c.db, id), { staleSeconds: 45, offlineSeconds: 135 });
    c.advance(16);
    assert.equal(nodeView(c.db, findNode(c.db, id), c.now()).status, 'online');
    assert.equal(resourceFresh(findNode(c.db, id), c.now(), reportTiming(c.db, id).staleSeconds), true);
    await c.app.inject({ method: 'PUT', url, headers: c.headers, payload: { interval_seconds: 1, expected_version: 2 } });
    assert.equal(nodeView(c.db, findNode(c.db, id), c.now()).status, 'online');
    c.advance(30);
    assert.equal(nodeView(c.db, findNode(c.db, id), c.now()).status, 'stale');
    c.advance(90);
    assert.equal(nodeView(c.db, findNode(c.db, id), c.now()).status, 'offline');
    report.applied_extensions_config_version = 3;
    report.snapshot.revision++; report.snapshot.observed_at = c.now();
    ingest(c.db, `Bearer ${n.token}`, report, c.now());
    assert.deepEqual(reportTiming(c.db, id), { staleSeconds: 15, offlineSeconds: 45 });
  } finally { await c.close(); }
});

test('resource alerts retain continuity across 15 second reports and treat gaps as unknown', async () => {
  const c = await setup();
  try {
    const n = await c.create(), id = n.node.id, report = c.report(), rule = randomUUID();
    c.db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(id, JSON.stringify({ report_interval_seconds: 15 }));
    c.db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(rule, JSON.stringify({ ...cpuRule, duration_seconds: 30 }));
    report.capabilities = { reporting: 1 }; report.applied_extensions_config_version = 1;
    const engine = new AlertEngine(c.db);
    for (let i = 0; i < 3; i++) {
      report.snapshot.revision++; report.snapshot.observed_at = c.now(); report.snapshot.cpu_percent = 99;
      ingest(c.db, `Bearer ${n.token}`, report, c.now()); engine.tick(c.now());
      if (i < 2) { c.advance(10); engine.tick(c.now()); c.advance(6); }
    }
    const event = c.db.prepare('SELECT state,validity FROM alert_events WHERE rule_id=?').get(rule);
    assert.deepEqual({ ...event as object }, { state: 'firing', validity: 'fresh' });
    c.advance(46); engine.tick(c.now());
    assert.equal((c.db.prepare('SELECT validity FROM alert_events WHERE rule_id=?').get(rule) as { validity: string }).validity, 'unknown');
  } finally { await c.close(); }
});
