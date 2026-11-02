import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentReport } from '../packages/contracts/src/index.js';
import type { DB } from '../apps/api/src/database.js';
import { createNode } from '../apps/api/src/nodes.js';
import { ingest } from '../apps/api/src/ingest.js';

/** Isolated browser harness only; no test control routes are installed in production. */
export async function qaMonitoring(db: DB, fixture: AgentReport, port: number) {
  const node = createNode(db, { name: '告警联调 · 模拟节点', group: '隔离浏览器测试', tags: ['synthetic'] }, Date.now() / 1000);
  const report = structuredClone(fixture); report.source_id = randomUUID(); report.snapshot.hostname = 'synthetic-alert-fixture';
  report.traffic = []; report.totals = []; report.resources = []; report.disk_io = [];
  let revision = 1, cpu = 95;
  const sample = () => {
    const now = Date.now() / 1000; report.snapshot.observed_at = now; report.snapshot.revision = revision++; report.snapshot.cpu_percent = cpu;
    ingest(db, `Bearer ${node.token}`, report, now);
  };
  sample(); const timer = setInterval(sample, 5000); timer.unref();
  const deliveries: { phase: string; event_id: string; key: string }[] = [];
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/records') { res.end(JSON.stringify({ deliveries })); return; }
    if (req.method !== 'POST' || !['/hook', '/control'].includes(req.url ?? '')) { res.writeHead(404); res.end('{}'); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16384) req.destroy(); });
    req.on('end', () => {
      try {
        const value = JSON.parse(body);
        if (req.url === '/control') {
          if (typeof value.cpu !== 'number' || value.cpu < 0 || value.cpu > 100) throw new Error('invalid CPU');
          cpu = value.cpu; sample();
        } else deliveries.push({ phase: value.phase, event_id: value.event_id, key: String(req.headers['idempotency-key']) });
        res.end('{"ok":true}');
      } catch { res.writeHead(400); res.end('{}'); }
    });
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  return { key: randomBytes(32), policy: { allowHttp: true, allowedCidrs: ['127.0.0.1/32'] },
    close: async () => { clearInterval(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
