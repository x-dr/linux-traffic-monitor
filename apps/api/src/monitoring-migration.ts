import type { DB } from './database.js';

export function migrateMonitoring(db: DB) {
  db.exec(`
    ALTER TABLE nodes ADD COLUMN enabled_at REAL;
    CREATE TABLE alert_rules(id TEXT PRIMARY KEY, config TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE alert_events(
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id), rule_id TEXT REFERENCES alert_rules(id),
      kind TEXT NOT NULL, title TEXT NOT NULL, severity TEXT NOT NULL, object TEXT NOT NULL,
      state TEXT NOT NULL, validity TEXT NOT NULL, first_anomaly_at REAL NOT NULL, fired_at REAL NOT NULL,
      last_anomaly_at REAL NOT NULL, resolved_at REAL, close_reason TEXT, value REAL, threshold REAL NOT NULL,
      acknowledged_at REAL, silenced_until REAL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX alert_node_time ON alert_events(node_id,fired_at);
    CREATE INDEX alert_active ON alert_events(state,fired_at);
    CREATE TABLE alert_states(
      rule_id TEXT NOT NULL REFERENCES alert_rules(id), node_id TEXT NOT NULL REFERENCES nodes(id),
      object TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(rule_id,node_id,object)
    );
    CREATE TABLE notification_channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,secret TEXT NOT NULL);
    CREATE TABLE notification_outbox(
      id TEXT PRIMARY KEY, event_id TEXT REFERENCES alert_events(id), node_id TEXT REFERENCES nodes(id),
      channel_id TEXT NOT NULL REFERENCES notification_channels(id), phase TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at REAL NOT NULL, last_error TEXT, created_at REAL NOT NULL, sent_at REAL, payload TEXT NOT NULL
    );
    CREATE INDEX outbox_due ON notification_outbox(status,next_attempt_at);
    CREATE TABLE notification_attempts(
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES notification_outbox(id), created_at REAL NOT NULL,
      status_code INTEGER, error TEXT
    );
    CREATE INDEX attempt_delivery ON notification_attempts(delivery_id,created_at);
    CREATE TABLE maintenance_windows(id TEXT PRIMARY KEY, config TEXT NOT NULL, start_at REAL NOT NULL,end_at REAL NOT NULL);
    CREATE TABLE node_events(id TEXT PRIMARY KEY,node_id TEXT NOT NULL REFERENCES nodes(id),kind TEXT NOT NULL,created_at REAL NOT NULL,detail TEXT NOT NULL);
    CREATE INDEX node_event_time ON node_events(node_id,created_at);
    CREATE TABLE traffic_policies(node_id TEXT PRIMARY KEY REFERENCES nodes(id),config TEXT NOT NULL,version INTEGER NOT NULL,cycle_config TEXT NOT NULL,recalculated INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE traffic_threshold_events(
      node_id TEXT NOT NULL REFERENCES nodes(id),cycle_start REAL NOT NULL,policy_version INTEGER NOT NULL,threshold INTEGER NOT NULL,
      event_id TEXT NOT NULL REFERENCES alert_events(id), PRIMARY KEY(node_id,cycle_start,policy_version,threshold)
    );
  `);
}
