import type { DB } from './database.js';

export function migrateProbes(db: DB) {
  db.exec(`
    CREATE TABLE probe_tasks(id TEXT PRIMARY KEY,version INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,config TEXT NOT NULL);
    CREATE TABLE agent_extensions(node_id TEXT PRIMARY KEY REFERENCES nodes(id),capabilities TEXT NOT NULL DEFAULT '{}',
      config_version INTEGER NOT NULL DEFAULT 1,applied_version INTEGER NOT NULL DEFAULT 0,error TEXT,
      drops TEXT NOT NULL DEFAULT '{"count":0,"oldest_at":null,"newest_at":null}');
    CREATE TABLE probe_assignments(task_id TEXT NOT NULL REFERENCES probe_tasks(id),node_id TEXT NOT NULL REFERENCES nodes(id),
      version INTEGER NOT NULL,start_at REAL NOT NULL,end_at REAL,config TEXT NOT NULL,PRIMARY KEY(task_id,node_id,version));
    CREATE INDEX probe_assignment_node ON probe_assignments(node_id,end_at);
    CREATE TABLE probe_results(node_id TEXT NOT NULL REFERENCES nodes(id),source_id TEXT NOT NULL,sample_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES probe_tasks(id),task_version INTEGER NOT NULL,revision INTEGER NOT NULL,scheduled_at REAL NOT NULL,
      result TEXT NOT NULL,PRIMARY KEY(node_id,source_id,sample_id),UNIQUE(node_id,source_id,revision),
      UNIQUE(node_id,source_id,task_id,task_version,scheduled_at));
    CREATE INDEX probe_history ON probe_results(node_id,task_id,scheduled_at);
    CREATE INDEX probe_latest ON probe_results(task_id,node_id,task_version,scheduled_at);
    CREATE INDEX probe_retention ON probe_results(scheduled_at);
    CREATE TABLE probe_states(task_id TEXT NOT NULL,node_id TEXT NOT NULL,version INTEGER NOT NULL,last_at REAL NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,successes INTEGER NOT NULL DEFAULT 0,event_id TEXT,first_failure_at REAL NOT NULL DEFAULT 0,PRIMARY KEY(task_id,node_id));
    CREATE TABLE probe_certificate_events(task_id TEXT NOT NULL,node_id TEXT NOT NULL,version INTEGER NOT NULL,expires_at REAL NOT NULL,
      threshold INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(task_id,node_id,version,expires_at,threshold));
  `);
}
