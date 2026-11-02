import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProbeResult } from '../packages/contracts/src/index.js';
import type { DB } from '../apps/api/src/database.js';
import { extensionsConfig, saveProbeTask } from '../apps/api/src/probe-store.js';
import type { NodeRow } from '../apps/api/src/nodes.js';

export async function qaProbes(db: DB, port: number) {
  let status = 204, hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/control' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => { status = Number(JSON.parse(body).status ?? 204); res.end('{}'); }); return;
    }
    if (req.url === '/records') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ hits })); return; }
    hits++; res.statusCode = status; res.end();
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const nodes = db.prepare("SELECT * FROM nodes WHERE name IN ('东京 · 核心节点','法兰克福 · 网关') ORDER BY name").all() as NodeRow[];
  const now = Date.now() / 1000;
  const task = saveProbeTask(db, { name: '应用可用性 · 模拟结果', kind: 'http', target: 'https://example.com/health', port: 0, family: 'ipv4',
    interval_seconds: 60, timeout_seconds: 3, enabled: true, node_ids: nodes.map(n => n.id), channel_ids: [] }, now - 3600);
  for (const node of nodes) {
    const assignment = extensionsConfig(db, node.id).probes[0], results: ProbeResult[] = [];
    for (let at = assignment.start_at, index = 0; at < now - 60; at += 60, index++) {
      if (index > 20 && index < 26) continue;
      results.push({ sample_id: randomUUID(), task_id: task.id, task_version: 1, revision: 1000 + index, scheduled_at: at, started_at: at,
        completed_at: at + 0.04, status: index === 40 ? 'http' : 'success', attempts: 1, latency_ms: index === 40 ? null : 40 + index % 7 * 3,
        http_status: index === 40 ? 503 : 204, certificate_expires_at: now + 60 * 86400 });
    }
    for (const r of results) db.prepare('INSERT INTO probe_results VALUES(?,?,?,?,?,?,?,?)').run(node.id, node.source_id, r.sample_id, task.id, 1, r.revision, r.scheduled_at, JSON.stringify(r));
    db.prepare("UPDATE agent_extensions SET capabilities=?,applied_version=config_version WHERE node_id=?").run('{"probes":1}', node.id);
  }
  return { close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
