import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/database.js';
import { createNode } from '../src/nodes.js';
import { ingest } from '../src/ingest.js';
import { fixture } from './support.js';

test('restore a consistent center backup and replay intact v2 Agent records using the standalone maintenance tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'center-restore-drill-'));
  try {
    const current = openDatabase(join(root, 'current.db')), node = createNode(current, { name: 'restore drill' }, fixture.snapshot.observed_at);
    const first = structuredClone(fixture), minute = first.traffic[0].minute_ts, now = first.snapshot.observed_at;
    first.traffic[0].rx_bytes = '100'; first.totals[0].rx_bytes = '100'; first.snapshot.revision = 5;
    ingest(current, `Bearer ${node.token}`, first, now);
    const backup = join(root, 'center-backup.db'); await current.backup(backup);
    const newer = structuredClone(first); newer.traffic[0].rx_bytes = '500'; newer.traffic[0].revision = 20;
    newer.totals[0].rx_bytes = '500'; newer.totals[0].revision = 20; newer.snapshot.revision = 20;
    ingest(current, `Bearer ${node.token}`, newer, now); current.close();
    const agentPath = join(root, 'agent-v2.db'), agent = new Database(agentPath);
    agent.exec(`PRAGMA user_version=2;
      CREATE TABLE baselines(interface TEXT PRIMARY KEY,rx_counter INTEGER,tx_counter INTEGER,boot_id TEXT,observed_at REAL);
      CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); INSERT INTO meta VALUES('sequence','20');
      CREATE TABLE sync_state(name TEXT PRIMARY KEY,cursor INTEGER); INSERT INTO sync_state VALUES('traffic',20),('resources',20),('disk_io',20),('totals',20);
      CREATE TABLE minutes(minute_ts INTEGER,interface TEXT,rx_bytes INTEGER,tx_bytes INTEGER,PRIMARY KEY(minute_ts,interface));
      CREATE TABLE traffic_versions(interface TEXT,minute_ts INTEGER,revision INTEGER UNIQUE,PRIMARY KEY(interface,minute_ts));
      CREATE TABLE total_versions(interface TEXT PRIMARY KEY,revision INTEGER UNIQUE);
      CREATE TABLE totals(interface TEXT PRIMARY KEY,rx_bytes INTEGER,tx_bytes INTEGER);
      CREATE TABLE resource_minutes(minute_ts INTEGER PRIMARY KEY,revision INTEGER UNIQUE,metrics TEXT);
      CREATE TABLE disk_minutes(device TEXT,minute_ts INTEGER,revision INTEGER UNIQUE,read_bytes INTEGER,write_bytes INTEGER,observed_seconds REAL,PRIMARY KEY(device,minute_ts));`);
    agent.prepare("INSERT INTO meta VALUES('source_id',?)").run(first.source_id);
    agent.prepare('INSERT INTO minutes VALUES(?,?,500,0)').run(minute, first.traffic[0].interface);
    agent.prepare('INSERT INTO traffic_versions VALUES(?,?,20)').run(first.traffic[0].interface, minute);
    agent.prepare('INSERT INTO totals VALUES(?,500,0)').run(first.totals[0].interface);
    agent.prepare('INSERT INTO total_versions VALUES(?,20)').run(first.totals[0].interface); agent.close();
    const result = JSON.parse(execFileSync('python3', ['scripts/agent-resync.py', '--db', agentPath,
      '--from', new Date(minute * 1000).toISOString(), '--to', new Date((minute + 60) * 1000).toISOString(),
      '--apply', '--agent-stopped', '--backup', join(root, 'agent-consistent-backup.db')], { encoding: 'utf8' }));
    assert.equal(result.applied, true); assert.equal(result.high_water, 20);
    const readAgent = new Database(agentPath, { readonly: true });
    newer.traffic[0].revision = (readAgent.prepare('SELECT revision FROM traffic_versions').get() as any).revision;
    newer.totals[0].revision = (readAgent.prepare('SELECT revision FROM total_versions').get() as any).revision;
    newer.snapshot.revision = result.next_sequence + 1;
    assert.equal((readAgent.prepare("SELECT v FROM meta WHERE k='source_id'").get() as any).v, first.source_id); readAgent.close();
    const restored = openDatabase(backup);
    try {
      assert.equal((restored.prepare('SELECT rx_bytes FROM traffic_minutes').get() as any).rx_bytes, 100);
      ingest(restored, `Bearer ${node.token}`, newer, now); ingest(restored, `Bearer ${node.token}`, newer, now);
      assert.equal((restored.prepare('SELECT rx_bytes FROM traffic_minutes').get() as any).rx_bytes, 500);
      assert.equal((restored.prepare('SELECT rx_bytes FROM traffic_totals').get() as any).rx_bytes, 500);
    } finally { restored.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
