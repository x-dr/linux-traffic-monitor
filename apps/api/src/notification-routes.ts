import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ChannelSchema, type ChannelInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { httpError } from './auth.js';
import { idParams, paging } from './alert-routes.js';
import { decryptSecret, encryptSecret, resolveTarget, type WebhookPolicy } from './webhook-security.js';

type Channel = { id: string; name: string; enabled: number; secret: string };
export function installNotificationRoutes(app: FastifyInstance, db: DB, now: () => number, key: Buffer | undefined, policy: WebhookPolicy) {
  const channel = (id: string) => {
    const row = db.prepare('SELECT * FROM notification_channels WHERE id=?').get(id) as Channel | undefined;
    if (!row) throw httpError(404, '通知渠道不存在'); return row;
  };
  const view = (row: Channel) => {
    let target = '密钥不可用', has_authorization = false;
    try { const secret = decryptSecret(key, row.secret); const url = new URL(secret.url); target = `${url.protocol}//${url.host}/•••`; has_authorization = !!secret.authorization; } catch { /* Never include ciphertext or a secret in a response. */ }
    return { id: row.id, name: row.name, enabled: !!row.enabled, target, has_authorization };
  };
  app.get('/api/v1/notification-channels', async () => ({ configured: !!key, channels: (db.prepare('SELECT * FROM notification_channels ORDER BY name LIMIT 100').all() as Channel[]).map(view) }));
  const save = async (body: ChannelInput, id: string, old?: Channel) => {
    if (!key) throw httpError(503, '请先配置中心 NOTIFICATION_KEY_FILE，监控服务仍可正常运行');
    const previous = old ? decryptSecret(key, old.secret) : null;
    const secret = { url: body.url ?? previous?.url ?? '', authorization: body.authorization ?? previous?.authorization ?? '' };
    if (!body.name.trim() || /[\r\n]/.test(secret.authorization)) throw httpError(400, '名称或鉴权头无效');
    await resolveTarget(secret.url, policy);
    db.transaction(() => {
      db.prepare('INSERT INTO notification_channels VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,secret=excluded.secret')
        .run(id, body.name.trim(), Number(body.enabled), encryptSecret(key, secret));
      if (!body.enabled) db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE channel_id=? AND status IN ('pending','suppressed','sending')").run(id);
    })(); return view(channel(id));
  };
  app.post<{ Body: ChannelInput }>('/api/v1/notification-channels', { schema: { body: ChannelSchema } }, async (req, reply) => {
    if ((db.prepare('SELECT COUNT(*) count FROM notification_channels').get() as { count: number }).count >= 100) throw httpError(400, '最多保存 100 个通知渠道');
    return reply.code(201).send(await save(req.body, randomUUID()));
  });
  app.patch<{ Params: { id: string }; Body: ChannelInput }>('/api/v1/notification-channels/:id', { schema: { params: idParams, body: ChannelSchema } }, async req => save(req.body, req.params.id, channel(req.params.id)));
  app.delete<{ Params: { id: string } }>('/api/v1/notification-channels/:id', { schema: { params: idParams } }, async req => {
    channel(req.params.id);
    db.transaction(() => {
      db.prepare('UPDATE notification_channels SET enabled=0 WHERE id=?').run(req.params.id);
      db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE channel_id=? AND status IN ('pending','suppressed','sending')").run(req.params.id);
    })(); return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/v1/notification-channels/:id/test', { schema: { params: idParams }, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async req => {
    const row = channel(req.params.id); decryptSecret(key, row.secret);
    if (!row.enabled) throw httpError(400, '请先启用渠道');
    const id = randomUUID();
    db.prepare(`INSERT INTO notification_outbox(id,channel_id,phase,idempotency_key,next_attempt_at,created_at,payload) VALUES(?,?,'test',?,?,?,?)`)
      .run(id, row.id, `test:${id}`, now(), now(), JSON.stringify({ event_id: id, phase: 'test', rule_name: '测试通知', detail: '来自 Observatory 的管理员测试通知' }));
    return { id, queued: true };
  });
  app.get<{ Querystring: { limit?: number; offset?: number; event_id?: string } }>('/api/v1/notification-deliveries', { schema: { querystring: Type.Object({ ...paging, event_id: Type.Optional(Type.String({ format: 'uuid' })) }, { additionalProperties: false }) } }, async req => ({
    deliveries: db.prepare(`SELECT o.id,o.event_id,o.channel_id,c.name channel_name,o.phase,o.status,o.attempts,o.next_attempt_at,o.last_error,o.created_at,o.sent_at,o.idempotency_key
      FROM notification_outbox o JOIN notification_channels c ON c.id=o.channel_id WHERE (? IS NULL OR o.event_id=?) ORDER BY o.created_at DESC,o.rowid DESC LIMIT ? OFFSET ?`)
      .all(req.query.event_id ?? null, req.query.event_id ?? null, req.query.limit ?? 50, req.query.offset ?? 0),
  }));
  app.post<{ Params: { id: string } }>('/api/v1/notification-deliveries/:id/retry', { schema: { params: idParams }, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async req => {
    const result = db.prepare("UPDATE notification_outbox SET status='pending',attempts=0,next_attempt_at=?,last_error=NULL WHERE id=? AND status='failed'").run(now(), req.params.id);
    if (!result.changes) throw httpError(400, '仅能重试失败消息'); return { ok: true };
  });
}
