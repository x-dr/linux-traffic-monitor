import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './support.js';

test('Agent downloads are public, binary-safe, support HEAD and match the checksum manifest', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-downloads-'));
  const binaries = new Map(['amd64', 'arm64'].map(arch => [
    `traffic-agent-linux-${arch}`, Buffer.from(`\x7fELF\0${arch}\xff`, 'latin1'),
  ]));
  const manifest = [...binaries].map(([name, body]) => `${createHash('sha256').update(body).digest('hex')}  ${name}\n`).join('');
  for (const [name, body] of binaries) writeFileSync(join(root, name), body);
  writeFileSync(join(root, 'SHA256SUMS'), manifest);
  writeFileSync(join(root, 'install-agent.py'), '#!/usr/bin/env python3\n');
  const s = await setup({ agentDistRoot: root });
  t.after(async () => { await s.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [filename, body] of binaries) {
    const response = await s.app.inject(`/downloads/agent/${filename}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, body);
    assert.equal(response.headers['content-type'], 'application/octet-stream');
    assert.equal(response.headers['content-disposition'], `attachment; filename="${filename}"`);
    assert.equal(response.headers['content-length'], String(body.length));
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['set-cookie'], undefined);
    const head = await s.app.inject({ method: 'HEAD', url: `/downloads/agent/${filename}` });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-length'], String(body.length));
  }
  assert.equal((await s.app.inject('/downloads/agent/SHA256SUMS')).body, manifest);
  assert.match((await s.app.inject('/downloads/agent/install-agent.py')).body, /python3/);
  assert.equal((await s.app.inject('/api/v1/nodes')).statusCode, 401);
});

test('Only distribution filenames are exposed; missing files and invalid paths never return the SPA', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-downloads-'));
  const webRoot = join(root, 'web'); mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<h1>SPA sentinel</h1>');
  writeFileSync(join(root, 'agent.json'), 'private sentinel');
  const s = await setup({ agentDistRoot: root, webRoot });
  t.after(async () => { await s.close(); rmSync(root, { recursive: true, force: true }); });
  for (const path of ['agent.json', 'package.json', 'constructor', '__proto__', 'nested/file', '%2e%2e%2fagent.json', '']) {
    const response = await s.app.inject(`/downloads/agent/${path}`);
    assert.equal(response.statusCode, 404, path);
    assert.doesNotMatch(response.body, /SPA sentinel|private sentinel/);
  }
  for (const filename of ['traffic-agent-linux-amd64', 'traffic-agent-linux-arm64', 'SHA256SUMS', 'install-agent.py']) {
    const response = await s.app.inject(`/downloads/agent/${filename}`);
    assert.equal(response.statusCode, 503);
    assert.doesNotMatch(response.body, /SPA sentinel/);
  }
  assert.equal((await s.app.inject({ method: 'POST', url: '/downloads/agent/SHA256SUMS' })).statusCode, 404);
  assert.match((await s.app.inject('/connect')).body, /SPA sentinel/);
});
