import type { FastifyInstance } from 'fastify';
import { ConfigSchema, TrafficPolicySchema, type MonitorConfig, type TrafficPolicyInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { idParams } from './alert-routes.js';
import { validateChannels } from './alert-store.js';
import { evaluateQuotas, getPolicy, quotaView, savePolicy } from './traffic-policy.js';
import { validateTimezone } from './periods.js';

export function installTrafficRoutes(app: FastifyInstance, db: DB, now: () => number, publicUrl?: string) {
  app.post<{ Params: { id: string }; Body: MonitorConfig }>('/api/v1/nodes/:id/config/preview', { schema: { params: idParams, body: ConfigSchema } }, async req => {
    const node = findNode(db, req.params.id), policy = getPolicy(db, node.id); validateTimezone(req.body);
    return { before: policy ? quotaView(db, node, policy, now(), false) : null,
      after: policy ? quotaView(db, { ...node, config: JSON.stringify(req.body) }, policy, now(), false) : null };
  });
  app.get<{ Params: { id: string } }>('/api/v1/nodes/:id/traffic-policy', { schema: { params: idParams } }, async req => {
    const node = findNode(db, req.params.id); return { policy: getPolicy(db, node.id), config_version: node.config_version };
  });
  app.post<{ Params: { id: string }; Body: TrafficPolicyInput }>('/api/v1/nodes/:id/traffic-policy/preview', { schema: { params: idParams, body: TrafficPolicySchema } }, async req => {
    const node = findNode(db, req.params.id), previous = getPolicy(db, node.id);
    validateChannels(db, req.body.channel_ids);
    return { quota: quotaView(db, node, { ...req.body, version: (previous?.version ?? 0) + 1 }, now()), policy_version: previous?.version ?? 0, config_version: node.config_version };
  });
  app.put<{ Params: { id: string }; Body: TrafficPolicyInput }>('/api/v1/nodes/:id/traffic-policy', { schema: { params: idParams, body: TrafficPolicySchema } }, async req => {
    const policy = db.transaction(() => {
      const result = savePolicy(db, req.params.id, req.body, now(), Number(req.headers['if-match']), Number(req.headers['x-config-version']));
      evaluateQuotas(db, now(), publicUrl); return result;
    })(); return { policy };
  });
  app.get<{ Params: { id: string } }>('/api/v1/nodes/:id/quota', { schema: { params: idParams } }, async req => {
    const node = findNode(db, req.params.id), policy = getPolicy(db, node.id);
    return { quota: policy ? quotaView(db, node, policy, now()) : null };
  });
}
