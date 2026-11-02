import { randomUUID } from 'node:crypto';
import type { AlertRuleInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { eventById, isSuppressed, matches } from './alert-store.js';
import { enqueueRecovery, notificationPayload } from './notification-queue.js';
import { decryptSecret, type WebhookSender } from './webhook-security.js';
import { taskById } from './probe-store.js';

type Message = { id: string; event_id: string | null; node_id: string | null; channel_id: string; phase: string;
  idempotency_key: string; status: string; attempts: number; payload: string; secret: string; enabled: number };
export class NotificationWorker {
  private running: Promise<void> | undefined;
  private controllers = new Set<AbortController>();
  private stopped = false;
  constructor(private db: DB, private key: Buffer | undefined, private sender: WebhookSender, private clock: () => number, private publicUrl?: string) {}
  restart() { this.db.prepare("UPDATE notification_outbox SET status='pending' WHERE status='sending'").run(); }
  tick() {
    if (this.stopped || this.running) return this.running ?? Promise.resolve();
    this.running = this.run().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async run() {
    const now = this.clock();
    const messages = this.db.prepare(`SELECT o.*,c.secret,c.enabled FROM notification_outbox o JOIN notification_channels c ON c.id=o.channel_id
      WHERE o.status IN ('pending','suppressed') AND o.next_attempt_at<=? ORDER BY o.created_at,o.rowid LIMIT 100`).all(now) as Message[];
    const ready: Message[] = [];
    for (const message of messages) {
      if (this.prepare(message, now)) ready.push(message);
      if (ready.length === 2) break;
    }
    await Promise.all(ready.map(message => this.send(message)));
  }
  private prepare(message: Message, now: number) {
    const current = this.db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(message.id) as { status: string };
    if (!['pending', 'suppressed'].includes(current.status)) return false;
    const cancel = () => { this.db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE id=?").run(message.id); return false; };
    if (!message.enabled) return cancel();
    if (message.node_id) {
      const node = findNode(this.db, message.node_id);
      if (!node.enabled || node.archived) return cancel();
      const event = message.event_id ? eventById(this.db, message.event_id) : null;
      if (event?.state === 'closed') return cancel();
      if (event && ['probe_failure', 'certificate_expiry'].includes(event.kind)) {
        const task = taskById(this.db, event.object);
        if (!task.enabled || task.archived || !task.node_ids.includes(node.id) || !task.channel_ids.includes(message.channel_id)) return cancel();
      }
      if (event?.state === 'resolved' && message.phase === 'trigger') {
        // A trigger may have been in flight when recovery was recorded, then
        // failed. Merge the retry and cancel the now-redundant recovery row.
        this.db.transaction(() => enqueueRecovery(this.db, event, [message.channel_id], now, this.publicUrl))();
        return false;
      }
      if (event?.rule_id) {
        const row = this.db.prepare('SELECT config,archived FROM alert_rules WHERE id=?').get(event.rule_id) as { config: string; archived: number } | undefined;
        const rule = row ? JSON.parse(row.config) as AlertRuleInput : null;
        if (!rule?.enabled || row?.archived || !rule.channel_ids.includes(message.channel_id) || !matches(rule.scope, node)) return cancel();
      }
      if (isSuppressed(this.db, node, event, now)) {
        this.db.prepare("UPDATE notification_outbox SET status='suppressed',next_attempt_at=? WHERE id=?").run(now + 5, message.id); return false;
      }
      if (message.status === 'suppressed') {
        if (!event || event.state === 'resolved') return cancel();
        message.phase = 'summary'; message.payload = JSON.stringify(notificationPayload(event, 'summary', this.publicUrl));
        this.db.prepare("UPDATE notification_outbox SET phase='summary',payload=? WHERE id=?").run(message.payload, message.id);
      }
      if (event && ['recovery', 'summary'].includes(message.phase) && this.db.prepare(`SELECT 1 FROM notification_outbox WHERE event_id=? AND channel_id=?
        AND id<>? AND phase='trigger' AND status IN ('pending','sending','suppressed')`).get(event.id, message.channel_id, message.id)) return false;
    }
    if (message.attempts >= 5) { this.db.prepare("UPDATE notification_outbox SET status='failed',last_error='已达到 5 次尝试上限' WHERE id=?").run(message.id); return false; }
    return true;
  }
  private async send(message: Message) {
    const claimed = this.db.prepare("UPDATE notification_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status IN ('pending','suppressed')").run(message.id);
    if (!claimed.changes) return;
    const now = this.clock(), controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000); timeout.unref();
    let status: number | null = null, error: string | null = null, retryAfter: string | undefined;
    try {
      const result = await this.sender(decryptSecret(this.key, message.secret), message.payload, message.idempotency_key, controller.signal);
      status = result.status; retryAfter = result.retryAfter;
      if (status < 200 || status >= 300) error = `Webhook HTTP ${status}`;
    } catch { error = 'Webhook 网络、TLS 或密钥不可用'; }
    finally { clearTimeout(timeout); this.controllers.delete(controller); }
    const retryable = status === null || status === 408 || status === 429 || status >= 500;
    const attempts = message.attempts + 1, retry = !!error && retryable && attempts < 5;
    let delay = [30, 120, 600, 1800][attempts - 1] ?? 1800;
    if (status === 429 && retryAfter) {
      const parsed = /^\d+$/.test(retryAfter) ? Number(retryAfter) : Date.parse(retryAfter) / 1000 - now;
      if (Number.isFinite(parsed)) delay = Math.min(1800, Math.max(delay, parsed));
    }
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO notification_attempts VALUES(?,?,?,?,?)').run(randomUUID(), message.id, this.clock(), status, error);
      // Configuration can cancel a message while its HTTP request is in flight.
      this.db.prepare(`UPDATE notification_outbox SET status=?,last_error=?,next_attempt_at=?,sent_at=? WHERE id=? AND status='sending'`)
        .run(!error ? 'sent' : retry ? 'pending' : 'failed', error, this.clock() + delay, !error ? this.clock() : null, message.id);
    })();
  }
  async close() { this.stopped = true; for (const controller of this.controllers) controller.abort(); await this.running; }
}
