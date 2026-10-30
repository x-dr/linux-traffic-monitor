// Run inside the built image, with /data and /tmp mounted as disposable tmpfs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const password = randomBytes(24).toString('hex');
const initialized = spawnSync(process.execPath, ['apps/api/dist/apps/api/src/admin.js', '--username', 'docker-qa'], {
  input: password + '\n', encoding: 'utf8', env: process.env,
});
assert.equal(initialized.status, 0, 'compiled admin initialization failed');
const child = spawn(process.execPath, ['apps/api/dist/apps/api/src/main.js'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString(); });
const origin = 'http://127.0.0.1:8766';
try {
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { healthy = (await fetch(origin + '/health')).ok; } catch { /* wait for startup */ }
    if (healthy) break;
    await setTimeout(100);
  }
  assert.equal(healthy, true, `center startup failed: ${stderr}`);
  const index = await fetch(origin + '/'); assert.equal(index.status, 200);
  const html = await index.text(); assert.match(html, /VPS Observatory/);
  const asset = html.match(/src="([^"]+\.js)"/)[1]; assert.equal((await fetch(origin + asset)).status, 200);
  assert.equal((await fetch(origin + '/nodes/11111111-1111-4111-8111-111111111111')).status, 200);
  assert.equal((await fetch(origin + '/api/v1/nodes')).status, 401);
  const login = await fetch(origin + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username: 'docker-qa', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0], session = await login.json();
  const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': session.csrf };
  const created = await fetch(origin + '/api/v1/nodes', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Docker smoke test' }) });
  assert.equal(created.status, 201);
  const listing = await fetch(origin + '/api/v1/nodes', { headers }); assert.equal((await listing.json()).nodes.length, 1);
  const controller = new AbortController();
  const events = await fetch(origin + '/api/v1/events', { headers, signal: controller.signal });
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = events.body.getReader(); let frame = '';
  while (!frame.includes('event: snapshot')) frame += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel(); controller.abort();
  assert.equal((await fetch(origin + '/api/v1/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(origin + '/api/v1/nodes', { headers })).status, 401);
  console.log('Docker smoke passed: non-root + read-only root, compiled admin/entrypoint, SQLite, static assets, deep links, auth, SSE and logout.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), setTimeout(3000).then(() => child.kill('SIGKILL'))]);
}
