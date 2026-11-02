import type { DB } from './database.js';
import { AlertEngine } from './alert-engine.js';
import { evaluateQuotas } from './traffic-policy.js';
import { NotificationWorker } from './notification-worker.js';
import { webhookSender, type WebhookPolicy, type WebhookSender } from './webhook-security.js';
import { refreshProbeValidity } from './probe-alerts.js';

export function monitoringTasks(db: DB, options: { now: () => number; publicUrl?: string; key?: Buffer; policy: WebhookPolicy; sender?: WebhookSender; enabled?: boolean; onError: () => void }) {
  const engine = new AlertEngine(db, options.publicUrl);
  const worker = new NotificationWorker(db, options.key, options.sender ?? webhookSender(options.policy), options.now, options.publicUrl);
  engine.restart(); worker.restart();
  db.prepare('UPDATE probe_states SET failures=0,successes=0').run();
  const timers: ReturnType<typeof setInterval>[] = [];
  if (options.enabled !== false) {
    const evaluate = setInterval(() => { try { engine.tick(options.now()); evaluateQuotas(db, options.now(), options.publicUrl); refreshProbeValidity(db, options.now()); } catch { options.onError(); } }, 5000);
    const notify = setInterval(() => { void worker.tick().catch(options.onError); }, 1000);
    evaluate.unref(); notify.unref(); timers.push(evaluate, notify);
  }
  return { close: async () => { for (const timer of timers) clearInterval(timer); await worker.close(); } };
}

export function pruneMonitoring(db: DB, now: number) {
  db.transaction(() => {
    db.prepare('DELETE FROM probe_results WHERE scheduled_at<?').run(now - 7 * 86400);
    db.prepare(`DELETE FROM probe_certificate_events WHERE event_id IN (SELECT id FROM alert_events WHERE state IN ('resolved','closed') AND resolved_at<?)`).run(now - 180 * 86400);
    db.prepare('DELETE FROM notification_attempts WHERE created_at<?').run(now - 30 * 86400);
    db.prepare(`DELETE FROM notification_outbox WHERE status IN ('sent','failed','cancelled') AND created_at<?
      AND (event_id IS NULL OR event_id NOT IN (SELECT id FROM alert_events WHERE state IN ('firing','recovering')))
      AND id NOT IN (SELECT delivery_id FROM notification_attempts)`).run(now - 30 * 86400);
    db.prepare('DELETE FROM traffic_threshold_events WHERE cycle_start<?').run(now - 180 * 86400);
    db.prepare(`DELETE FROM alert_events WHERE state IN ('resolved','closed') AND resolved_at<?
      AND id NOT IN (SELECT event_id FROM notification_outbox WHERE event_id IS NOT NULL)
      AND id NOT IN (SELECT event_id FROM traffic_threshold_events)`).run(now - 180 * 86400);
    db.prepare('DELETE FROM node_events WHERE created_at<?').run(now - 180 * 86400);
    db.prepare('DELETE FROM maintenance_windows WHERE end_at<?').run(now - 180 * 86400);
  })();
}
