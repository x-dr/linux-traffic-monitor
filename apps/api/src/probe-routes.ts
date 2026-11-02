import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { ProbeTaskSchema, type ProbePair, type ProbeResult, type ProbeTaskInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { httpError } from './auth.js';
import { findNode } from './nodes.js';
import { closeProbeEvents, extensionsView, saveProbeTask, taskById } from './probe-store.js';
import { probeHistory } from './probe-history.js';
import { reportTiming } from './reporting.js';

export function installProbeRoutes(app: FastifyInstance, db: DB, now: () => number) {
  const params = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
  app.get('/api/v1/probe-tasks', async () => {
    const tasks = (db.prepare('SELECT id FROM probe_tasks ORDER BY rowid DESC LIMIT 200').all() as { id: string }[]).map(row => taskById(db, row.id));
    const pairs: ProbePair[] = [];
    for (const task of tasks) for (const id of task.node_ids) {
      const node = findNode(db, id);
      const last = db.prepare('SELECT result FROM probe_results WHERE task_id=? AND node_id=? AND task_version=? ORDER BY scheduled_at DESC LIMIT 1').get(task.id, id, task.version) as { result: string } | undefined;
      const latest: ProbeResult | null = last ? JSON.parse(last.result) : null;
      pairs.push({ task, node_id: id, node_name: node.name, node_active: !!node.enabled && !node.archived,
        extensions: extensionsView(db, id), latest, fresh: !!latest && latest.completed_at <= now() + 5 && now() - latest.completed_at <= task.interval_seconds * 3 && node.last_received_at !== null && now() - node.last_received_at <= reportTiming(db, id).staleSeconds });
    }
    return { tasks, pairs };
  });
  app.post<{ Body: ProbeTaskInput }>('/api/v1/probe-tasks', { schema: { body: ProbeTaskSchema } }, async (req, reply) => {
    const count = db.prepare('SELECT COUNT(*) n FROM probe_tasks').get() as { n: number };
    if (count.n >= 200) throw httpError(400, '当前最多保存 200 项探测任务');
    return reply.code(201).send(saveProbeTask(db, req.body, now()));
  });
  app.patch<{ Params: { id: string }; Body: ProbeTaskInput }>('/api/v1/probe-tasks/:id', { schema: { params, body: ProbeTaskSchema } }, async req => {
    taskById(db, req.params.id);
    return saveProbeTask(db, req.body, now(), req.params.id, Number(req.headers['if-match']));
  });
  app.delete<{ Params: { id: string } }>('/api/v1/probe-tasks/:id', { schema: { params } }, async req => {
    const task = taskById(db, req.params.id);
    if (!task.archived) db.transaction(() => {
      saveProbeTask(db, { ...task, enabled: false }, now(), task.id, task.version);
      db.prepare('UPDATE probe_tasks SET archived=1 WHERE id=?').run(task.id);
      closeProbeEvents(db, task.id, now(), '探测任务已归档');
    })();
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { task_id: string; minutes?: number; offset?: number } }>('/api/v1/nodes/:id/probe-history', { schema: { params,
    querystring: Type.Object({ task_id: Type.String({ format: 'uuid' }), minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10080 })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })) }, { additionalProperties: false }) } }, async req => {
    findNode(db, req.params.id);
    return probeHistory(db, req.params.id, req.query.task_id, now(), req.query.minutes ?? 60, req.query.offset ?? 0);
  });
}
