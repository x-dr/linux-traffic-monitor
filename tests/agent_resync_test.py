from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('agent_resync', Path(__file__).parents[1] / 'scripts' / 'agent-resync.py')
resync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resync)


class ResyncTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix='agent-resync-')
        self.addCleanup(self.root.cleanup)
        self.path = Path(self.root.name) / 'traffic.db'
        db = sqlite3.connect(self.path)
        db.executescript('''
            PRAGMA journal_mode=WAL; PRAGMA user_version=2;
            CREATE TABLE baselines(interface TEXT PRIMARY KEY,rx_counter INTEGER,tx_counter INTEGER,boot_id TEXT,observed_at REAL);
            INSERT INTO baselines VALUES('ens3',111,222,'stable-boot',180);
            CREATE TABLE totals(interface TEXT PRIMARY KEY,rx_bytes INTEGER,tx_bytes INTEGER);
            INSERT INTO totals VALUES('ens3',111,222);
            CREATE TABLE minutes(minute_ts INTEGER,interface TEXT,rx_bytes INTEGER,tx_bytes INTEGER,PRIMARY KEY(minute_ts,interface));
            INSERT INTO minutes VALUES(60,'ens3',11,22),(120,'ens3',33,44);
            CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); INSERT INTO meta VALUES('source_id','stable-source'),('sequence','10');
            CREATE TABLE sync_state(name TEXT PRIMARY KEY,cursor INTEGER); INSERT INTO sync_state VALUES('traffic',10),('resources',10),('disk_io',10),('totals',10);
            CREATE TABLE traffic_versions(interface TEXT,minute_ts INTEGER,revision INTEGER UNIQUE,PRIMARY KEY(interface,minute_ts));
            INSERT INTO traffic_versions VALUES('ens3',60,1),('ens3',120,2);
            CREATE TABLE total_versions(interface TEXT PRIMARY KEY,revision INTEGER UNIQUE); INSERT INTO total_versions VALUES('ens3',3);
            CREATE TABLE resource_minutes(minute_ts INTEGER PRIMARY KEY,revision INTEGER UNIQUE,metrics TEXT); INSERT INTO resource_minutes VALUES(120,4,'{}');
            CREATE TABLE disk_minutes(device TEXT,minute_ts INTEGER,revision INTEGER UNIQUE,read_bytes INTEGER,write_bytes INTEGER,observed_seconds REAL,PRIMARY KEY(device,minute_ts));
            INSERT INTO disk_minutes VALUES('vda',120,5,100,200,60);
        ''')
        db.commit()
        db.close()

    def read(self, sql):
        with closing(sqlite3.connect(self.path)) as db:
            return db.execute(sql).fetchall()

    def test_preview_is_read_only_and_apply_requires_stopped_and_backup(self):
        before = self.path.read_bytes()
        result = resync.maintain(self.path, 120, 180)
        self.assertFalse(result['applied'])
        self.assertEqual(result['rows'], dict(traffic=1, resources=1, disk_io=1, totals=1))
        self.assertEqual(self.path.read_bytes(), before)
        with self.assertRaises(ValueError):
            resync.maintain(self.path, 120, 180, apply=True)

    def test_apply_keeps_source_baselines_counters_and_cursors_and_allocates_above_high_water(self):
        stable = {table: self.read(f'SELECT * FROM {table}') for table in ['baselines', 'totals', 'minutes', 'sync_state']}
        backup = Path(self.root.name) / 'before.db'
        result = resync.maintain(self.path, 120, 180, True, True, backup, 100)
        self.assertTrue(result['applied'])
        for table, rows in stable.items():
            self.assertEqual(self.read(f'SELECT * FROM {table}'), rows)
        self.assertEqual(self.read("SELECT v FROM meta WHERE k='source_id'"), [('stable-source',)])
        self.assertEqual(self.read("SELECT v FROM meta WHERE k='sequence'"), [('104',)])
        self.assertEqual(self.read('SELECT revision FROM traffic_versions ORDER BY minute_ts'), [(1,), (101,)])
        self.assertEqual(self.read('SELECT revision FROM resource_minutes'), [(102,)])
        self.assertEqual(self.read('SELECT revision FROM disk_minutes'), [(103,)])
        self.assertEqual(self.read('SELECT revision FROM total_versions'), [(104,)])
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(db.execute('SELECT revision FROM total_versions').fetchone()[0], 3)
        with self.assertRaises(ValueError):
            resync.maintain(self.path, 120, 180, True, True, backup)

    def test_next_replay_is_above_previous_sequence_and_overflow_or_wrong_database_is_rejected(self):
        resync.maintain(self.path, 120, 180, True, True, Path(self.root.name) / 'first.db')
        result = resync.maintain(self.path, 120, 180, True, True, Path(self.root.name) / 'second.db')
        self.assertEqual(result['high_water'], 14)
        with self.assertRaises(ValueError):
            resync.maintain(self.path, 120, 180, revision_floor=2**63 - 2)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('PRAGMA user_version=4')
            db.commit()
        with self.assertRaises(ValueError):
            resync.maintain(self.path, 120, 180)

    def test_range_requires_timezone_and_minute_boundaries(self):
        self.assertEqual(resync.timestamp('1970-01-01T08:02:00+08:00'), 120)
        for value in ['2026-11-02T10:00:00', '2026-11-02T10:00:01Z']:
            with self.assertRaises(ValueError):
                resync.timestamp(value)

    def test_v3_probe_revisions_update_payload_without_replacing_sample_identity(self):
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('''PRAGMA user_version=3;
                CREATE TABLE probe_results(sample_id TEXT PRIMARY KEY,revision INTEGER UNIQUE,scheduled_at REAL,result TEXT);
                INSERT INTO sync_state VALUES('probes',10);''')
            db.execute('INSERT INTO probe_results VALUES(?,?,?,?)', ('stable-sample', 6, 125.5, json.dumps(dict(sample_id='stable-sample', revision=6))))
            db.commit()
        result = resync.maintain(self.path, 120, 180, True, True, Path(self.root.name) / 'v3.db', 100)
        self.assertEqual(result['rows']['probes'], 1)
        sample, revision, raw = self.read('SELECT sample_id,revision,result FROM probe_results')[0]
        self.assertEqual(sample, 'stable-sample')
        self.assertEqual(revision, 105)
        self.assertEqual(json.loads(raw)['revision'], 105)
        self.assertEqual(self.read("SELECT cursor FROM sync_state WHERE name='probes'"), [(10,)])


if __name__ == '__main__':
    unittest.main()
