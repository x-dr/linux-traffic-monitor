import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { ConfigSchema, DeviceSchema, InterfaceSchema, NodeCreateSchema, NodePatchSchema, ReportSchema, type AgentReport, type HistoryFilters, type MonitorConfig } from '../../../packages/contracts/src/index.js';
import { openDatabase, pruneResources, type DB } from './database.js';
import { installAuth, httpError } from './auth.js';
import { createNode, findNode, listNodes, nodeView, overview } from './nodes.js';
import { ingest } from './ingest.js';
import { history } from './history.js';
import { validateTimezone } from './periods.js';
import { EventHub } from './events.js';

export type AppOptions = {
  db?: DB; dbPath?: string; publicUrl?: string; secureCookies?: boolean; now?: () => number;
  webRoot?: string; logger?: boolean; eventsInterval?: number;
};
export async function buildApp(options: AppOptions = {}) {
  const db = options.db || openDatabase(options.dbPath || './data/control.db');
  const now = options.now || (() => Date.now() / 1000);
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 2 * 1024 * 1024, trustProxy: ['127.0.0.1', '::1'],
    ajv: { customOptions: { removeAdditional: false } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  installAuth(app, db, { publicUrl: options.publicUrl, secureCookies: options.secureCookies, now });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((err, _req, reply) => {
    const error = err as Error & { statusCode?: number; validation?: unknown };
    const code = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (code >= 500) app.log.error({ message: error.message }, '请求处理失败');
    reply.code(code).send({ error: code >= 500 && code !== 503 ? '服务器内部错误，请查看服务日志' : error.message });
  });
  const hub = new EventHub(db, now);
  const interval = setInterval(() => hub.broadcast(), options.eventsInterval || 5000); interval.unref();
  const cleanup = setInterval(() => pruneResources(db, now()), 3600000); cleanup.unref();
  pruneResources(db, now());
  app.addHook('preClose', async () => { clearInterval(interval); clearInterval(cleanup); hub.close(); });
  app.addHook('onClose', async () => { if (!options.db) db.close(); });
  app.get('/health', async () => ({ ok: true }));
  app.get('/api/v1/nodes', async () => ({ nodes: listNodes(db, now()) }));
  app.post<{ Body: Static<typeof NodeCreateSchema> }>('/api/v1/nodes', { schema: { body: NodeCreateSchema } }, async (req, reply) => {
    const created = createNode(db, req.body, now());
    return reply.code(201).send({ node: nodeView(db, findNode(db, created.id), now()), token: created.token });
  });
  const params = Type.Object({ id: Type.String({ format: 'uuid' }) });
  app.get<{ Params: { id: string } }>('/api/v1/nodes/:id', { schema: { params } }, async req => nodeView(db, findNode(db, req.params.id), now()));
  app.patch<{ Params: { id: string }; Body: Static<typeof NodePatchSchema> }>('/api/v1/nodes/:id', { schema: { params, body: NodePatchSchema } }, async req => {
    const old = findNode(db, req.params.id), body = req.body;
    if (body.name !== undefined && !body.name.trim()) throw httpError(400, '名称不能为空');
    db.prepare('UPDATE nodes SET name=?,group_name=?,tags=?,enabled=?,archived=? WHERE id=?')
      .run(body.name?.trim() ?? old.name, body.group ?? old.group_name, body.tags ? JSON.stringify(body.tags) : old.tags,
        body.enabled === undefined ? old.enabled : Number(body.enabled), body.archived === undefined ? old.archived : Number(body.archived), old.id);
    return nodeView(db, findNode(db, old.id), now());
  });
  app.put<{ Params: { id: string }; Body: MonitorConfig }>('/api/v1/nodes/:id/config', { schema: { params, body: ConfigSchema } }, async req => {
    findNode(db, req.params.id); validateTimezone(req.body);
    db.prepare('UPDATE nodes SET config=?,config_version=config_version+1,config_error=NULL WHERE id=?').run(JSON.stringify(req.body), req.params.id);
    return nodeView(db, findNode(db, req.params.id), now());
  });
  app.get<{ Params: { id: string }; Querystring: HistoryFilters & { minutes?: number } }>('/api/v1/nodes/:id/history', { schema: {
    params, querystring: Type.Object({
      minutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 43200 })),
      interface: Type.Optional(InterfaceSchema), device: Type.Optional(DeviceSchema),
      granularity: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('hour'), Type.Literal('day')])),
    }, { additionalProperties: false }),
  } }, async req => { findNode(db, req.params.id); return history(db, req.params.id, req.query.minutes || 60, now(), req.query); });
  app.get('/api/v1/overview', async () => overview(listNodes(db, now())));
  app.post<{ Body: AgentReport }>('/api/v1/agent/report', { schema: { body: ReportSchema } }, async req => ingest(db, req.headers.authorization, req.body, now()));
  app.get('/api/v1/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    hub.add(reply.raw, req.session!.token_hash, req.session!.expires_at);
  });
  const root = resolve(options.webRoot || './apps/web/dist');
  if (existsSync(resolve(root, 'index.html'))) {
    await app.register(staticFiles, { root, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html', { cacheControl: false });
      return reply.code(404).send({ error: '接口或资源不存在' });
    });
  }
  return app;
}
