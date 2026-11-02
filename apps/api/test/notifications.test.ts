import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { monitorSetup } from './monitoring-support.js';
import { setup } from './support.js';
import { NotificationWorker } from '../src/notification-worker.js';
import { allowedAddress, decryptSecret, encryptSecret, parseTarget, resolveTarget, webhookSender } from '../src/webhook-security.js';
import { pruneMonitoring } from '../src/background.js';

test('webhook retry schedule, Retry-After cap, fatal errors and maximum attempts are persistent', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  const statuses = [503, 429, 408, 503, 500]; let count = 0;
  const worker = new NotificationWorker(c.db, c.key, async () => ({ status: statuses[count++], retryAfter: '999999' }), c.now); t.after(() => worker.close());
  for (const delay of [30, 1800, 600, 1800]) {
    await worker.tick(); const row = c.db.prepare('SELECT * FROM notification_outbox').get() as any;
    assert.equal(row.status, 'pending'); assert.equal(row.next_attempt_at - c.now(), delay);
    await worker.tick(); assert.equal(count, row.attempts); c.advance(delay);
  }
  await worker.tick(); assert.equal((c.db.prepare('SELECT status FROM notification_outbox').get() as any).status, 'failed'); assert.equal(count, 5);
  assert.equal((c.db.prepare('SELECT COUNT(*) n FROM notification_attempts').get() as any).n, 5);
  const id = (c.db.prepare('SELECT id FROM notification_outbox').get() as any).id;
  assert.equal((await c.app.inject({ method: 'POST', url: `/api/v1/notification-deliveries/${id}/retry`, headers: c.headers })).statusCode, 200);
});

test('network errors retry; 400 and redirects fail immediately without exposing response text', async t => {
  for (const status of [400, 302, null]) {
    const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
    const worker = new NotificationWorker(c.db, c.key, async () => { if (status === null) throw new Error('https://secret.test/token'); return { status }; }, c.now); t.after(() => worker.close());
    await worker.tick(); const row = c.db.prepare('SELECT status,last_error FROM notification_outbox').get() as any;
    assert.equal(row.status, status === null ? 'pending' : 'failed'); assert.doesNotMatch(row.last_error, /secret|token/);
  }
});

test('outbox merges unsent trigger and recovery; delivered triggers precede recovery', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, recovery_seconds: 0, channel_ids: [c.channel] });
  const phases: string[] = [];
  const worker = new NotificationWorker(c.db, c.key, async (_s, payload) => { phases.push(JSON.parse(payload).phase); return { status: 204 }; }, c.now); t.after(() => worker.close());
  c.sample(); c.tick(); c.advance(5); c.sample(50); c.tick(); await worker.tick(); assert.deepEqual(phases, ['summary']);
  c.advance(5); c.sample(); c.tick(); await worker.tick(); assert.deepEqual(phases, ['summary', 'trigger']);
  c.advance(5); c.sample(50); c.tick(); await worker.tick(); assert.deepEqual(phases, ['summary', 'trigger', 'recovery']);
});

test('recovery after a terminal trigger failure sends a resolved summary and retains active-event delivery evidence', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, recovery_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  const phases: string[] = [];
  const worker = new NotificationWorker(c.db, c.key, async (_s, payload) => { phases.push(JSON.parse(payload).phase); return { status: phases.length === 1 ? 400 : 200 }; }, c.now); t.after(() => worker.close());
  await worker.tick(); pruneMonitoring(c.db, c.now() + 31 * 86400);
  assert.equal((c.db.prepare('SELECT COUNT(*) n FROM notification_outbox').get() as any).n, 1);
  c.advance(5); c.sample(50); c.tick(); await worker.tick(); assert.deepEqual(phases, ['trigger', 'summary']);
});

test('recovery while a trigger request fails in flight merges its retry and cancels the redundant recovery', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, recovery_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  let finish!: (value: { status: number }) => void; const phases: string[] = [], keys: string[] = [];
  const worker = new NotificationWorker(c.db, c.key, async (_s, payload, key) => {
    phases.push(JSON.parse(payload).phase); keys.push(key); if (phases.length === 1) return new Promise(resolve => { finish = resolve; }); return { status: 200 };
  }, c.now); t.after(() => worker.close());
  const running = worker.tick(); c.advance(5); c.sample(50); c.tick(); finish({ status: 503 }); await running;
  c.advance(30); await worker.tick(); await worker.tick(); assert.deepEqual(phases, ['trigger', 'summary']);
  assert.notEqual(keys[0], keys[1], 'resolved summary must survive remote deduplication of the earlier trigger');
  assert.equal((c.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='sent'").get() as any).n, 1);
  assert.equal((c.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE phase='recovery' AND status='cancelled'").get() as any).n, 1);
});

test('maintenance and finite silence suppress delivery, recovered events are not sent after the window', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, recovery_seconds: 0, channel_ids: [c.channel] });
  const window = await c.app.inject({ method: 'POST', url: '/api/v1/maintenance-windows', headers: c.headers,
    payload: { name: '维护', scope: { kind: 'all', node_ids: [], value: '' }, start_at: c.now(), end_at: c.now() + 60 } });
  assert.equal(window.statusCode, 200); let sent = 0;
  const worker = new NotificationWorker(c.db, c.key, async () => { sent++; return { status: 200 }; }, c.now); t.after(() => worker.close());
  c.sample(); c.tick(); await worker.tick(); assert.equal(sent, 0);
  c.advance(5); c.sample(50); c.tick(); await worker.tick(); c.advance(60); await worker.tick(); assert.equal(sent, 0);
  c.sample(); c.tick(); const active = c.events().find(e => e.state === 'firing')!;
  await c.app.inject({ method: 'POST', url: `/api/v1/alerts/${active.id}/silence`, headers: c.headers, payload: { until: c.now() + 60 } });
  await worker.tick(); assert.equal(sent, 0); c.advance(61); await worker.tick(); assert.equal(sent, 1);
  assert.equal((c.db.prepare("SELECT phase FROM notification_outbox WHERE status='sent'").get() as any).phase, 'summary');
});

test('remote acceptance followed by local bookkeeping failure retries the same stable idempotency key', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  const keys: string[] = [];
  const send = async (_s: unknown, _p: string, key: string) => { keys.push(key); return { status: 200 }; };
  const first = new NotificationWorker(c.db, c.key, send, c.now);
  c.db.exec("CREATE TRIGGER fail_sent BEFORE UPDATE ON notification_outbox WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'simulated crash'); END");
  await assert.rejects(first.tick()); await first.close();
  c.db.exec('DROP TRIGGER fail_sent');
  const restarted = new NotificationWorker(c.db, c.key, send, c.now); t.after(() => restarted.close()); restarted.restart(); await restarted.tick();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal((c.db.prepare('SELECT attempts FROM notification_outbox').get() as any).attempts, 2);
});

test('worker limits concurrency to two, prevents overlapping runs and cancels disabled targets', async t => {
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  for (let i = 0; i < 3; i++) await c.app.inject({ method: 'POST', url: `/api/v1/notification-channels/${c.channel}/test`, headers: c.headers });
  let inFlight = 0, maximum = 0, sent = 0;
  const worker = new NotificationWorker(c.db, c.key, async () => { maximum = Math.max(maximum, ++inFlight); await setTimeout(20); inFlight--; sent++; return { status: 200 }; }, c.now); t.after(() => worker.close());
  await Promise.all([worker.tick(), worker.tick(), worker.tick()]); assert.equal(sent, 2); assert.equal(maximum, 2);
  await c.app.inject({ method: 'DELETE', url: `/api/v1/notification-channels/${c.channel}`, headers: c.headers });
  await worker.tick(); assert.equal(sent, 2);
});

test('channel configuration is encrypted, masked, key-gated, CSRF-protected and test requests rate limited', async t => {
  const c = await monitorSetup(); t.after(c.close);
  const created = await c.app.inject({ method: 'POST', url: '/api/v1/notification-channels', headers: c.headers,
    payload: { name: 'API 渠道', enabled: true, url: 'https://8.8.8.8/path-sensitive?key=redact', authorization: 'Bearer test-only-auth' } });
  assert.equal(created.statusCode, 201); assert.doesNotMatch(created.body, /sensitive|redact|test-only-auth/);
  const stored = c.db.prepare('SELECT secret FROM notification_channels WHERE id=?').get(created.json().id) as { secret: string };
  assert.doesNotMatch(stored.secret, /sensitive|test-only-auth/);
  assert.match(decryptSecret(c.key, stored.secret).url, /path-sensitive/);
  assert.throws(() => decryptSecret(Buffer.alloc(32), stored.secret), /解密/);
  const noCsrf = await c.app.inject({ method: 'POST', url: `/api/v1/notification-channels/${c.channel}/test`, headers: { cookie: c.cookie } }); assert.equal(noCsrf.statusCode, 403);
  // The preceding rejected request also consumes the route's per-IP rate limit.
  for (let i = 0; i < 2; i++) assert.equal((await c.app.inject({ method: 'POST', url: `/api/v1/notification-channels/${c.channel}/test`, headers: c.headers })).statusCode, 200);
  assert.equal((await c.app.inject({ method: 'POST', url: `/api/v1/notification-channels/${c.channel}/test`, headers: c.headers })).statusCode, 429);
  const noKey = await setup(); t.after(noKey.close);
  assert.equal((await noKey.app.inject({ method: 'POST', url: '/api/v1/notification-channels', headers: noKey.headers, payload: { name: '无密钥', enabled: true, url: 'https://8.8.8.8/' } })).statusCode, 503);
  assert.equal((await noKey.app.inject({ url: '/health' })).statusCode, 200);
});

test('URL and resolved IP policy reject metadata, credentials and private destinations unless explicitly allowed', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1']) assert.equal(allowedAddress(ip, 'hooks.test', {}), false);
  assert.equal(allowedAddress('10.0.0.1', 'hooks.test', { allowedHosts: ['hooks.test'] }), true);
  assert.equal(allowedAddress('10.0.0.1', 'hooks.test', { allowedCidrs: ['10.0.0.0/24'] }), true);
  for (const ip of ['169.254.169.254', '100.100.100.200', 'fe80::1', 'fd00:ec2::254']) assert.equal(allowedAddress(ip, 'hooks.test', { allowedHosts: ['hooks.test'] }), false);
  assert.throws(() => parseTarget('https://user:password@8.8.8.8/', {}));
  assert.throws(() => parseTarget('http://8.8.8.8/', {}));
  await assert.rejects(resolveTarget('https://127.0.0.1/', {}), /允许范围/);
});

test('actual isolated HTTP transport pins an allowed address, sends idempotency header and never follows redirects', async t => {
  let received = 0, header = '';
  const server = createServer((req, res) => { received++; header = String(req.headers['idempotency-key']); req.resume(); res.writeHead(302, { Location: 'http://169.254.169.254/' }); res.end('secret response not retained'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const sender = webhookSender({ allowHttp: true, allowedCidrs: ['127.0.0.1/32'] });
  const result = await sender({ url: `http://127.0.0.1:${port}/hook`, authorization: '' }, '{}', 'stable-key', new AbortController().signal);
  assert.equal(result.status, 302); assert.equal(received, 1); assert.equal(header, 'stable-key');
  const ciphertext = encryptSecret(Buffer.alloc(32, 1), { url: 'https://8.8.8.8/', authorization: '' }); assert.ok(ciphertext);
});

test('HTTP transport aborts a hanging local target and worker shutdown does not wait for an unreachable service', async t => {
  const server = createServer(req => { req.resume(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const sender = webhookSender({ allowHttp: true, allowedCidrs: ['127.0.0.1/32'] });
  await assert.rejects(sender({ url: `http://127.0.0.1:${port}/`, authorization: '' }, '{}', 'timeout-test', AbortSignal.timeout(40)), /请求失败/);
  const c = await monitorSetup(); t.after(c.close); c.rule({ duration_seconds: 0, channel_ids: [c.channel] }); c.sample(); c.tick();
  const worker = new NotificationWorker(c.db, c.key, (_s, _p, _k, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }); }), c.now);
  const running = worker.tick(); await worker.close(); await running;
  assert.equal((c.db.prepare('SELECT status FROM notification_outbox').get() as any).status, 'pending');
});

test('HTTPS transport rejects an untrusted local certificate and does not disable TLS verification', async t => {
  const root = mkdtempSync(join(tmpdir(), 'webhook-tls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cert = join(root, 'cert.pem'), key = join(root, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let requests = 0;
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => { requests++; req.resume(); res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  await assert.rejects(webhookSender({ allowedCidrs: ['127.0.0.1/32'] })({ url: `https://127.0.0.1:${port}/`, authorization: '' }, '{}', 'tls-test', AbortSignal.timeout(2000)), /请求失败/);
  assert.equal(requests, 0);
});
