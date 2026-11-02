import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { openDatabase } from '../apps/api/src/database.js';
import { buildApp } from '../apps/api/src/app.js';
import { initializeAdmin } from '../apps/api/src/auth.js';
import { createNode, findNode } from '../apps/api/src/nodes.js';
import { ingest } from '../apps/api/src/ingest.js';
import { defaultConfig, type AgentReport } from '../packages/contracts/src/index.js';
import { qaMonitoring } from './qa-monitoring.js';
import { qaProbes } from './qa-probes.js';
import { qaDiagnostics } from './qa-diagnostics.js';

const root = mkdtempSync(join(tmpdir(), 'traffic-browser-'));
const db = openDatabase(join(root, 'control.db'));
const port = Number(process.env.QA_PORT || 18766), origin = `http://127.0.0.1:${port}`;
initializeAdmin(db, 'qa-admin', 'local-browser-test-password');
const fixture = JSON.parse(readFileSync(new URL('../packages/contracts/fixtures/report.json', import.meta.url), 'utf8')) as AgentReport;
const names = ['东京 · 核心节点', '法兰克福 · 网关', '洛杉矶 · 备用'];
for (let index = 0; index < 3; index++) {
  const node = createNode(db, { name: names[index], group: ['亚太', '欧洲', '北美'][index], tags: ['浏览器测试', index ? 'gateway' : 'production'] }, Date.now() / 1000 - 86400);
  const source = randomUUID(); const now = Math.floor(Date.now() / 60000) * 60;
  for (let i = 59; i >= 0; i--) {
    const report = structuredClone(fixture), revision = (60 - i) * 3;
    report.source_id = source; report.snapshot.hostname = ['tokyo-core-01', 'frankfurt-gw-01', 'los-angeles-02'][index];
    report.snapshot.observed_at = now - i * 60; report.snapshot.revision = revision;
    report.snapshot.cpu_percent = 20 + index * 14 + Math.sin(i / 7) * 12; report.snapshot.memory_percent = 38 + index * 13;
    report.snapshot.rx_bps = 2 ** 20 * (1.3 + Math.sin(i / 4) * .5 + index); report.snapshot.tx_bps = report.snapshot.rx_bps * .37;
    report.snapshot.os = index ? 'Ubuntu 24.04' : 'Debian 12'; report.snapshot.uptime_seconds = (12 + index * 31) * 86400;
    report.traffic[0] = { interface: 'ens3', minute_ts: now - i * 60, revision: revision - 2, rx_bytes: String(Math.floor(report.snapshot.rx_bps * 60)), tx_bytes: String(Math.floor(report.snapshot.tx_bps * 60)) };
    report.traffic.push({ interface: 'eth1', minute_ts: now - i * 60, revision: revision - 2,
      rx_bytes: '6291456', tx_bytes: '3145728' });
    report.snapshot.interfaces = ['ens3', 'eth1']; report.snapshot.selected_interfaces = ['ens3', 'eth1'];
    if (index < 2) {
      const read = Math.floor(2 ** 20 * (3 + Math.sin(i / 3) * 1.8)), write = Math.floor(read * .4);
      report.snapshot.agent_version = '1.1.0';
      report.snapshot.disk_io = [{ device: 'vda', read_bps: read, write_bps: write }, { device: 'vdb', read_bps: read / 2, write_bps: write / 2 }];
      report.disk_io = report.snapshot.disk_io.map(value => ({ device: value.device, minute_ts: now - i * 60, revision,
        read_bytes: String(Math.floor(value.read_bps! * 60)), write_bytes: String(Math.floor(value.write_bps! * 60)), observed_seconds: 60 }));
    }
    const point = report.resources[0]; point.minute_ts = now - i * 60; point.revision = revision - 1;
    point.values.cpu_percent = { avg: report.snapshot.cpu_percent, max: report.snapshot.cpu_percent + 4, count: 12 };
    point.values.memory_percent = { avg: report.snapshot.memory_percent, max: report.snapshot.memory_percent + 1, count: 12 };
    point.values.rx_bps = { avg: report.snapshot.rx_bps, max: report.snapshot.rx_bps * 1.2, count: 12 };
    point.values.tx_bps = { avg: report.snapshot.tx_bps, max: report.snapshot.tx_bps * 1.2, count: 12 };
    point.values.load1 = { avg: (report.snapshot.cpu_percent || 0) / 40, max: 1.5, count: 12 };
    report.totals[0] = { interface: 'ens3', revision, rx_bytes: String(BigInt(80 + index * 53) * 1024n ** 3n), tx_bytes: String(BigInt(40 + index * 21) * 1024n ** 3n) };
    report.applied_config_version = 1;
    ingest(db, `Bearer ${node.token}`, report, now - i * 60);
  }
  const last = Date.now() / 1000 - (index === 2 ? 120 : 0);
  db.prepare('UPDATE nodes SET last_received_at=?,last_sample_received_at=? WHERE id=?').run(last, last, node.id);
}
qaDiagnostics(db,fixture);
const monitoring = await qaMonitoring(db, fixture, port + 1);
const probeQA = await qaProbes(db, port + 2);
const app = await buildApp({ db, publicUrl: origin, webRoot: resolve('apps/web/dist'), notificationKey: monitoring.key, webhookPolicy: monitoring.policy });
await app.listen({ host: '127.0.0.1', port });
const children: ChildProcess[] = [];
const binary = resolve(process.env.QA_AGENT_BINARY || 'agent/bin/traffic-agent-linux-amd64');
if (!existsSync(binary)) throw new Error('请先构建 amd64 Go Agent');
const liveNodes = [];
for (const name of ['本机采集 · A', '本机采集 · B']) {
  const node = createNode(db, { name, group: '真实本机 Agent', tags: ['集成验收'] }, Date.now() / 1000);
  liveNodes.push(node.id);
  if(name.endsWith('A'))db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(node.id,JSON.stringify({diagnostics:{enabled:true,services:[]},workloads:{enabled:false,docker:false,processes:[]}}));
  const directory = join(root, node.id); mkdirSync(directory, { mode: 0o700 });
  const cfg = join(directory, 'agent.json');
  writeFileSync(cfg, JSON.stringify({ server_url: origin, token: node.token, data_dir: directory, settings: defaultConfig, applied_config_version: 0, probe_allow_cidrs: ['127.0.0.1/32','::1/128'] }), { mode: 0o600 });
  const child = spawn(binary, ['run', '--config', cfg], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', chunk => process.stderr.write(chunk)); children.push(child);
}
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => new Promise<void>(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); const timeout = globalThis.setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); timeout.unref(); })));
  await app.close(); await monitoring.close(); await probeQA.close(); db.close(); rmSync(root, { recursive: true, force: true }); process.exit(0);
}
process.on('SIGTERM', () => { void stop(); }); process.on('SIGINT', () => { void stop(); });
for (let attempt = 0; attempt < 100; attempt++) {
  if (liveNodes.every(id => findNode(db, id).last_received_at !== null)) break;
  await setTimeout(100);
}
if (!liveNodes.every(id => findNode(db, id).last_received_at !== null)) { await stop(); throw new Error('两个真实 Agent 未能完成首次上报'); }
console.log(`QA server ready at ${origin}; two independent Go Agents connected; temporary data only.`);
