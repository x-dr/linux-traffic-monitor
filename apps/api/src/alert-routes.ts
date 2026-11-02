import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AlertRuleSchema, MaintenanceSchema, ScopeSchema, type AlertRuleInput, type Maintenance, type AlertScope } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import type { NodeRow } from './nodes.js';
import { httpError } from './auth.js';
import { closeEvents, eventById, matches, nodeEvent, validateRule, validateScope } from './alert-store.js';

export const idParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const paging = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })) };
export function installAlertRoutes(app: FastifyInstance, db: DB, now: () => number) {
  const rules = () => {
    const nodes = db.prepare('SELECT * FROM nodes WHERE enabled=1 AND archived=0').all() as NodeRow[];
    return (db.prepare('SELECT id,config FROM alert_rules WHERE archived=0').all() as { id: string; config: string }[]).map(row => {
      const rule = JSON.parse(row.config) as AlertRuleInput;
      return { ...rule, id: row.id, matched_nodes: nodes.filter(node => matches(rule.scope, node)).map(n => ({ id: n.id, name: n.name })) };
    });
  };
  app.get('/api/v1/alert-rules', async () => ({ rules: rules() }));
  app.post<{ Body: AlertScope }>('/api/v1/alert-rules/preview', { schema: { body: ScopeSchema } }, async req => {
    validateScope(req.body);
    return { nodes: (db.prepare('SELECT * FROM nodes WHERE enabled=1 AND archived=0').all() as NodeRow[]).filter(n => matches(req.body, n)).map(n => ({ id: n.id, name: n.name })) };
  });
  app.post<{ Body: AlertRuleInput }>('/api/v1/alert-rules', { schema: { body: AlertRuleSchema } }, async (req, reply) => {
    validateRule(db, req.body);
    if ((db.prepare('SELECT COUNT(*) count FROM alert_rules WHERE archived=0').get() as { count: number }).count >= 100) throw httpError(400, '最多保存 100 条规则');
    const id = randomUUID(); db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(id, JSON.stringify(req.body));
    return reply.code(201).send(rules().find(r => r.id === id));
  });
  app.patch<{ Params: { id: string }; Body: AlertRuleInput }>('/api/v1/alert-rules/:id', { schema: { params: idParams, body: AlertRuleSchema } }, async req => {
    validateRule(db, req.body);
    if (!rules().some(r => r.id === req.params.id)) throw httpError(404, '规则不存在');
    db.transaction(() => {
      closeEvents(db, now(), '配置关闭：规则变更', req.params.id);
      db.prepare('UPDATE alert_rules SET config=? WHERE id=?').run(JSON.stringify(req.body), req.params.id);
    })();
    return rules().find(r => r.id === req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/alert-rules/:id', { schema: { params: idParams } }, async req => {
    db.transaction(() => {
      closeEvents(db, now(), '配置关闭：规则归档', req.params.id);
      db.prepare('UPDATE alert_rules SET archived=1 WHERE id=?').run(req.params.id);
    })(); return { ok: true };
  });
  app.get<{ Querystring: { limit?: number; offset?: number; node_id?: string; severity?: string; state?: string; start?: number; end?: number } }>('/api/v1/alerts', { schema: { querystring: Type.Object({
    ...paging, node_id: Type.Optional(Type.String({ format: 'uuid' })), severity: Type.Optional(Type.Union([Type.Literal('warning'), Type.Literal('critical')])),
    state: Type.Optional(Type.Union(['active', 'resolved', 'closed', 'all'].map(v => Type.Literal(v)))), start: Type.Optional(Type.Number({ minimum: 0 })), end: Type.Optional(Type.Number({ minimum: 0 })),
  }, { additionalProperties: false }) } }, async req => {
    const q = req.query, start = q.start ?? now() - 180 * 86400, end = q.end ?? now() + 1;
    if (end <= start || end - start > 181 * 86400) throw httpError(400, '查询时间范围须在 180 天以内');
    const filters = `e.fired_at>=? AND e.fired_at<? AND (? IS NULL OR e.node_id=?) AND (? IS NULL OR e.severity=?)
      AND (?='all' OR (?='active' AND e.state IN ('firing','recovering')) OR e.state=?)`;
    const values = [start, end, q.node_id ?? null, q.node_id ?? null, q.severity ?? null, q.severity ?? null, q.state ?? 'active', q.state ?? 'active', q.state ?? 'active'];
    return { events: db.prepare(`SELECT e.*,n.name node_name FROM alert_events e JOIN nodes n ON n.id=e.node_id WHERE ${filters} ORDER BY e.fired_at DESC,e.id LIMIT ? OFFSET ?`).all(...values, q.limit ?? 50, q.offset ?? 0),
      total: (db.prepare(`SELECT COUNT(*) count FROM alert_events e WHERE ${filters}`).get(...values) as { count: number }).count };
  });
  app.get<{ Params: { id: string } }>('/api/v1/alerts/:id', { schema: { params: idParams } }, async req => ({ event: eventById(db, req.params.id),
    deliveries: db.prepare('SELECT id,phase,status,attempts,next_attempt_at,last_error,sent_at FROM notification_outbox WHERE event_id=? ORDER BY created_at DESC').all(req.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/alerts/:id/acknowledge', { schema: { params: idParams } }, async req => {
    const event = eventById(db, req.params.id);
    db.transaction(() => {
      db.prepare('UPDATE alert_events SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?').run(now(), event.id);
      nodeEvent(db, event.node_id, 'alert_acknowledged', now(), event.title);
    })(); return eventById(db, event.id);
  });
  app.post<{ Params: { id: string }; Body: { until: number } }>('/api/v1/alerts/:id/silence', { schema: { params: idParams, body: Type.Object({ until: Type.Number({ minimum: 0 }) }, { additionalProperties: false }) } }, async req => {
    const event = eventById(db, req.params.id);
    if (req.body.until <= now() || req.body.until > now() + 30 * 86400) throw httpError(400, '静默时间须在未来 30 天内');
    db.transaction(() => {
      db.prepare('UPDATE alert_events SET silenced_until=? WHERE id=?').run(req.body.until, event.id);
      nodeEvent(db, event.node_id, 'alert_silenced', now(), `${event.title}；静默至 ${new Date(req.body.until * 1000).toISOString()}`);
    })(); return eventById(db, event.id);
  });
  app.get('/api/v1/maintenance-windows', async () => ({ windows: (db.prepare('SELECT id,config FROM maintenance_windows ORDER BY start_at DESC LIMIT 100').all() as { id: string; config: string }[]).map(r => ({ ...JSON.parse(r.config), id: r.id })) }));
  const saveWindow = (body: Omit<Maintenance, 'id'>, id: string) => {
    validateScope(body.scope);
    if (body.end_at <= body.start_at || body.end_at - body.start_at > 30 * 86400 || body.end_at <= now()) throw httpError(400, '维护窗口应在未来结束且不超过 30 天');
    db.prepare('INSERT INTO maintenance_windows VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,start_at=excluded.start_at,end_at=excluded.end_at')
      .run(id, JSON.stringify(body), body.start_at, body.end_at); return { ...body, id };
  };
  app.post<{ Body: Omit<Maintenance, 'id'> }>('/api/v1/maintenance-windows', { schema: { body: MaintenanceSchema } }, async req => saveWindow(req.body, randomUUID()));
  app.patch<{ Params: { id: string }; Body: Omit<Maintenance, 'id'> }>('/api/v1/maintenance-windows/:id', { schema: { params: idParams, body: MaintenanceSchema } }, async req => {
    if (!db.prepare('SELECT 1 FROM maintenance_windows WHERE id=?').get(req.params.id)) throw httpError(404, '维护窗口不存在');
    return saveWindow(req.body, req.params.id);
  });
  app.delete<{ Params: { id: string } }>('/api/v1/maintenance-windows/:id', { schema: { params: idParams } }, async req => {
    db.prepare('DELETE FROM maintenance_windows WHERE id=?').run(req.params.id); return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>('/api/v1/nodes/:id/events', { schema: { params: idParams, querystring: Type.Object(paging, { additionalProperties: false }) } }, async req => ({
    events: db.prepare('SELECT * FROM node_events WHERE node_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(req.params.id, req.query.limit ?? 50, req.query.offset ?? 0),
  }));
}
