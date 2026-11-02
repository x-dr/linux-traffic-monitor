import type { DB } from './database.js';
export function migrateDiagnostics(db: DB) {
  db.exec(`
    CREATE TABLE diagnostic_settings(node_id TEXT PRIMARY KEY REFERENCES nodes(id),config TEXT NOT NULL);
    CREATE TABLE telemetry_minutes(node_id TEXT NOT NULL REFERENCES nodes(id),source_id TEXT NOT NULL,stream TEXT NOT NULL,
      minute_ts INTEGER NOT NULL,revision INTEGER NOT NULL,config_version INTEGER NOT NULL,data TEXT NOT NULL,
      PRIMARY KEY(node_id,stream,minute_ts));
    CREATE INDEX telemetry_range ON telemetry_minutes(node_id,stream,minute_ts);
    CREATE INDEX telemetry_retention ON telemetry_minutes(minute_ts);
    CREATE TABLE agent_sync_health(node_id TEXT PRIMARY KEY REFERENCES nodes(id),received_at REAL NOT NULL,data TEXT NOT NULL);
    CREATE TABLE node_assets(node_id TEXT PRIMARY KEY REFERENCES nodes(id),version INTEGER NOT NULL,config TEXT NOT NULL);
    CREATE TABLE asset_threshold_events(node_id TEXT NOT NULL REFERENCES nodes(id),version INTEGER NOT NULL,threshold INTEGER NOT NULL,event_id TEXT NOT NULL,
      PRIMARY KEY(node_id,version,threshold));
    CREATE TABLE registration_tokens(id TEXT PRIMARY KEY,name TEXT NOT NULL,group_name TEXT NOT NULL,token_hash TEXT NOT NULL,
      expires_at REAL NOT NULL,max_uses INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE registration_claims(registration_id TEXT NOT NULL REFERENCES registration_tokens(id),request_id TEXT NOT NULL,
      node_id TEXT NOT NULL REFERENCES nodes(id),PRIMARY KEY(registration_id,request_id));
    CREATE TABLE history_rollups(node_id TEXT NOT NULL REFERENCES nodes(id),domain TEXT NOT NULL,object TEXT NOT NULL,
      step INTEGER NOT NULL,bucket INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(node_id,domain,object,step,bucket));
    CREATE INDEX rollup_range ON history_rollups(node_id,domain,step,bucket);
    CREATE TABLE rollup_dirty(node_id TEXT NOT NULL,domain TEXT NOT NULL,bucket INTEGER NOT NULL,PRIMARY KEY(node_id,domain,bucket));
    INSERT OR IGNORE INTO rollup_dirty SELECT node_id,'resource',minute_ts/3600*3600 FROM resource_minutes GROUP BY node_id,minute_ts/3600;
    INSERT OR IGNORE INTO rollup_dirty SELECT node_id,'disk',minute_ts/3600*3600 FROM disk_minutes GROUP BY node_id,minute_ts/3600;
    CREATE TABLE report_jobs(id TEXT PRIMARY KEY,version INTEGER NOT NULL,config TEXT NOT NULL,created_at REAL NOT NULL);
    CREATE TABLE report_runs(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES report_jobs(id),version INTEGER NOT NULL,period_key TEXT NOT NULL,
      created_at REAL NOT NULL,late INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(job_id,version,period_key));
    CREATE TABLE control_diagnostics(id INTEGER PRIMARY KEY CHECK(id=1),report_ms REAL NOT NULL DEFAULT 0,
      report_max_ms REAL NOT NULL DEFAULT 0,reports INTEGER NOT NULL DEFAULT 0,scheduler_lag_ms REAL NOT NULL DEFAULT 0,last_tick_at REAL);
    INSERT INTO control_diagnostics(id) VALUES(1);
  `);
}
