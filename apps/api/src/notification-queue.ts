import { randomUUID } from 'node:crypto';
import type { AlertEvent } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';

export function notificationPayload(event: AlertEvent, phase: string, publicUrl?: string) {
  return { event_id: event.id, phase, node_id: event.node_id, node_name: event.node_name, rule_name: event.title,
    severity: event.severity, fired_at: event.fired_at, resolved_at: event.resolved_at, value: event.value,
    threshold: event.threshold, detail: event.detail,
    url: publicUrl ? `${new URL(publicUrl).origin}/alerts?event=${event.id}` : `/alerts?event=${event.id}` };
}
export function enqueue(db: DB, event: AlertEvent, channels: string[], phase: string, now: number, sequence = 0, publicUrl?: string) {
  for (const channel of channels) {
    const key = `${event.id}:${phase}:${channel}:${sequence}`;
    db.prepare(`INSERT OR IGNORE INTO notification_outbox(id,event_id,node_id,channel_id,phase,idempotency_key,next_attempt_at,created_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), event.id, event.node_id, channel, phase, key, now, now, JSON.stringify(notificationPayload(event, phase, publicUrl)));
  }
}
export function enqueueRecovery(db: DB, event: AlertEvent, channels: string[], now: number, publicUrl?: string) {
  for (const channel of channels) {
    const summaryKey = `${event.id}:summary:${channel}:0`;
    const unsent = db.prepare("SELECT id FROM notification_outbox WHERE event_id=? AND channel_id=? AND phase IN ('trigger','summary') AND status IN ('pending','suppressed') AND idempotency_key<>? ORDER BY created_at LIMIT 1").get(event.id, channel, summaryKey) as { id: string } | undefined;
    if (unsent) {
      // A prior request may have reached the receiver despite a failed local
      // attempt. Give the resolved summary its own stable phase key, so remote
      // deduplication cannot discard recovery as an old trigger retry.
      db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE id=?").run(unsent.id);
      enqueue(db, event, [channel], 'summary', now, 0, publicUrl);
      db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE event_id=? AND channel_id=? AND phase='recovery' AND status IN ('pending','suppressed')").run(event.id, channel);
    } else {
      const delivered = db.prepare("SELECT 1 FROM notification_outbox WHERE event_id=? AND channel_id=? AND phase IN ('trigger','summary') AND status IN ('sent','sending')").get(event.id, channel);
      enqueue(db, event, [channel], delivered ? 'recovery' : 'summary', now, 0, publicUrl);
    }
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE event_id=? AND channel_id=? AND phase='reminder' AND status IN ('pending','suppressed')").run(event.id, channel);
  }
}
