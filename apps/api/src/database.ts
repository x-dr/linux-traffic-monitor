import { processRollups } from './history-rollups.js';
import { migrateDatabase } from './migrations.js';
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
  try { migrateDatabase(db); } catch (error) { db.close(); throw error; }
  return db;
}

export function pruneResources(db: DB, now = Date.now() / 1000) {
  processRollups(db,1000);
  const safe=(domain:string)=>`NOT EXISTS(SELECT 1 FROM rollup_dirty d WHERE d.node_id=outer.node_id AND d.domain='${domain}' AND d.bucket=outer.minute_ts/3600*3600)`;
  const result = db.prepare(`DELETE FROM resource_minutes AS outer WHERE minute_ts < ? AND ${safe('resource')}`).run(Math.floor((now-30*86400)/3600)*3600);
  db.prepare(`DELETE FROM disk_minutes AS outer WHERE minute_ts < ? AND ${safe('disk')}`).run(Math.floor((now-30*86400)/3600)*3600);
  db.prepare(`DELETE FROM telemetry_minutes AS outer WHERE minute_ts<? AND NOT EXISTS(SELECT 1 FROM rollup_dirty d WHERE d.node_id=outer.node_id AND d.domain=outer.stream AND d.bucket=outer.minute_ts/3600*3600)`).run(Math.floor((now-30*86400)/3600)*3600);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  return result.changes;
}
