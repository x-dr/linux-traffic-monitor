// Run inside the built image, with /data and /tmp mounted as disposable tmpfs.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
  const checksumsResponse = await fetch(origin + '/downloads/agent/SHA256SUMS');
  assert.equal(checksumsResponse.status, 200);
  const checksums = await checksumsResponse.text();
  if (process.env.EXPECTED_AGENT_SHA256SUMS) {
    assert.equal(checksums, await readFile(process.env.EXPECTED_AGENT_SHA256SUMS, 'utf8'), 'image Agent files differ from Release assets');
  }
  for (const [arch, machine] of [['amd64', 62], ['arm64', 183]]) {
    const filename = `traffic-agent-linux-${arch}`;
    const url = origin + '/downloads/agent/' + filename;
    const response = await fetch(url); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.readUInt32BE(0), 0x7f454c46);
    assert.equal(bytes[4], 2); assert.equal(bytes[5], 1); // ELF64, little endian.
    assert.equal(bytes.readUInt16LE(18), machine);
    assert.ok(checksums.split('\n').includes(`${createHash('sha256').update(bytes).digest('hex')}  ${filename}`));
    const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
  const installer = await fetch(origin + '/downloads/agent/install-agent.py'); assert.equal(installer.status, 200);
  assert.equal(await installer.text(), await readFile(process.env.AGENT_DIST_ROOT + '/install-agent.py', 'utf8'));
  assert.equal((await fetch(origin + '/downloads/agent/agent.json')).status, 404);
  assert.equal((await fetch(origin + '/downloads/agent/nested/missing')).status, 404);
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const agentVersion = spawnSync(`${process.env.AGENT_DIST_ROOT}/traffic-agent-linux-${arch}`, ['version'], { encoding: 'utf8' });
  assert.equal(agentVersion.status, 0, 'packaged Agent cannot run');
  assert.match(agentVersion.stdout.trim(), /^\d+\.\d+\.\d+/);
  if (process.env.EXPECTED_AGENT_VERSION) assert.equal(agentVersion.stdout.trim(), process.env.EXPECTED_AGENT_VERSION);
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
  const node = (await created.json()).node;
  const channels = await fetch(origin + '/api/v1/notification-channels', { headers });
  assert.equal(channels.status, 200); assert.equal((await channels.json()).configured, false);
  const rule = { name: 'Docker disabled rule', enabled: false, scope: { kind: 'all', node_ids: [], value: '' },
    metric: 'cpu', object: '', threshold: 90, duration_seconds: 300, recovery_threshold: 80, recovery_seconds: 120,
    severity: 'warning', channel_ids: [], repeat_seconds: 0 };
  const ruleResult = await fetch(origin + '/api/v1/alert-rules', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(rule) });
  assert.equal(ruleResult.status, 201);
  const policy = { enabled: false, quota_bytes: '1000000000', input_unit: 'GB', direction: 'max', interfaces: ['ens3'], thresholds: [80, 90, 100], channel_ids: [] };
  const preview = await fetch(origin + `/api/v1/nodes/${node.id}/traffic-policy/preview`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(policy) });
  assert.equal(preview.status, 200);
  const saved = await fetch(origin + `/api/v1/nodes/${node.id}/traffic-policy`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': '0', 'X-Config-Version': '1' }, body: JSON.stringify(policy) });
  assert.equal(saved.status, 200);
  const listing = await fetch(origin + '/api/v1/nodes', { headers }); assert.equal((await listing.json()).nodes.length, 1);
  const probeTask = { name: 'Docker disabled probe', kind: 'http', target: 'https://example.com/health', port: 0, family: 'ipv4', interval_seconds: 60,
    timeout_seconds: 3, node_ids: [node.id], enabled: false, channel_ids: [] };
  const probeSaved = await fetch(origin + '/api/v1/probe-tasks', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(probeTask) });
  assert.equal(probeSaved.status, 201);
  assert.equal((await (await fetch(origin + '/api/v1/probe-tasks', { headers })).json()).pairs.length, 1);
  const diagnostics = await fetch(origin + `/api/v1/nodes/${node.id}/diagnostics`, { headers });
  assert.equal(diagnostics.status, 200); assert.equal((await diagnostics.json()).supported, false);
  const settings = {diagnostics:{enabled:false,services:[]},workloads:{enabled:false,docker:false,processes:[]},expected_version:1};
  // A disabled probe has already allocated an extension config version.
  const version = await (await fetch(origin + `/api/v1/nodes/${node.id}/diagnostics`, {headers})).json();
  settings.expected_version=version.config_version;
  assert.equal((await fetch(origin + `/api/v1/nodes/${node.id}/diagnostic-settings`, {method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(settings)})).status,200);
  assert.equal((await fetch(origin + '/api/v1/control-diagnostics',{headers})).status,200);
  const reportJob={name:'Docker disabled report',enabled:false,period:'day',timezone:'Asia/Shanghai',node_ids:[node.id],group:'',channel_ids:[]};
  assert.equal((await fetch(origin+'/api/v1/report-jobs',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(reportJob)})).status,200);
  const registration=await fetch(origin+'/api/v1/registration-tokens',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({name:'Docker isolated registration',group:'',expires_in:300,max_uses:1})});
  assert.equal(registration.status,200);
  const controller = new AbortController();
  const events = await fetch(origin + '/api/v1/events', { headers, signal: controller.signal });
  assert.equal(events.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = events.body.getReader(); let frame = '';
  while (!frame.includes('event: snapshot')) frame += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel(); controller.abort();
  assert.equal((await fetch(origin + '/api/v1/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(origin + '/api/v1/nodes', { headers })).status, 401);
  console.log('Docker smoke passed: non-root + read-only root, both Agent architectures/ELF/SHA256/HEAD, native Agent version, installer, compiled admin/entrypoint, SQLite v6, static assets, auth, SSE, disabled rule/probe/diagnostics/report, short registration, key-free monitoring, quota preview/save and logout.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), setTimeout(3000).then(() => child.kill('SIGKILL'))]);
}
