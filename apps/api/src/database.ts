import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='baselines'").get()) {
    db.close();
    throw new Error('中心服务需要独立数据库，不能使用旧版或 Agent 的 traffic.db');
  }
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 2) throw new Error('数据库版本高于当前程序，请使用对应版本');
  if (version === 0) db.transaction(() => {
    db.exec(`
      CREATE TABLE admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at REAL NOT NULL);
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
        token_hash TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, archived INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL, last_received_at REAL, last_sample_received_at REAL, source_id TEXT,
        config TEXT NOT NULL, config_version INTEGER NOT NULL DEFAULT 1,
        applied_config_version INTEGER NOT NULL DEFAULT 0, config_error TEXT,
        snapshot TEXT, snapshot_revision INTEGER NOT NULL DEFAULT -1
      );
      CREATE TABLE traffic_minutes (
        node_id TEXT NOT NULL REFERENCES nodes(id), interface TEXT NOT NULL, minute_ts INTEGER NOT NULL,
        revision INTEGER NOT NULL, rx_bytes INTEGER NOT NULL, tx_bytes INTEGER NOT NULL,
        PRIMARY KEY(node_id, interface, minute_ts)
      );
      CREATE INDEX traffic_range ON traffic_minutes(node_id, minute_ts);
      CREATE TABLE traffic_totals (
        node_id TEXT NOT NULL REFERENCES nodes(id), interface TEXT NOT NULL, revision INTEGER NOT NULL,
        rx_bytes INTEGER NOT NULL, tx_bytes INTEGER NOT NULL, PRIMARY KEY(node_id, interface)
      );
      CREATE TABLE resource_minutes (
        node_id TEXT NOT NULL REFERENCES nodes(id), minute_ts INTEGER NOT NULL, revision INTEGER NOT NULL,
        metrics TEXT NOT NULL, PRIMARY KEY(node_id, minute_ts)
      );
      CREATE INDEX resource_retention ON resource_minutes(minute_ts);
      PRAGMA user_version = 1;
    `);
  })();
  if (version < 2) db.transaction(() => {
    db.exec(`CREATE TABLE disk_minutes (
      node_id TEXT NOT NULL REFERENCES nodes(id), device TEXT NOT NULL, minute_ts INTEGER NOT NULL,
      revision INTEGER NOT NULL, read_bytes INTEGER NOT NULL, write_bytes INTEGER NOT NULL,
      observed_seconds REAL NOT NULL, PRIMARY KEY(node_id,device,minute_ts)
    );
    CREATE INDEX disk_range ON disk_minutes(node_id,minute_ts);
    CREATE INDEX disk_retention ON disk_minutes(minute_ts);
    PRAGMA user_version = 2;`);
  })();
  return db;
}

export function pruneResources(db: DB, now = Date.now() / 1000) {
  const result = db.prepare('DELETE FROM resource_minutes WHERE minute_ts < ?').run(Math.floor(now - 30 * 86400));
  db.prepare('DELETE FROM disk_minutes WHERE minute_ts < ?').run(Math.floor(now - 30 * 86400));
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return result.changes;
}
