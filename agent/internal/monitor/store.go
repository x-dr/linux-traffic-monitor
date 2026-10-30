package monitor

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	DB           *sql.DB
	SourceID     string
	mu           sync.Mutex
	active       map[string]bool
	readable     map[string]bool
	lastTick     time.Time
	diskReadable map[string]bool
}

func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version > 2 {
		db.Close()
		return nil, errors.New("Agent 数据库版本不可用，请使用对应版本程序")
	}
	if _, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
	 CREATE TABLE IF NOT EXISTS baselines(interface TEXT PRIMARY KEY,rx_counter INTEGER NOT NULL,tx_counter INTEGER NOT NULL,boot_id TEXT NOT NULL,observed_at REAL NOT NULL);
	 CREATE TABLE IF NOT EXISTS totals(interface TEXT PRIMARY KEY,rx_bytes INTEGER NOT NULL DEFAULT 0,tx_bytes INTEGER NOT NULL DEFAULT 0);
	 CREATE TABLE IF NOT EXISTS minutes(minute_ts INTEGER NOT NULL,interface TEXT NOT NULL,rx_bytes INTEGER NOT NULL DEFAULT 0,tx_bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(minute_ts,interface));
	 CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
	 CREATE TABLE IF NOT EXISTS traffic_versions(interface TEXT NOT NULL,minute_ts INTEGER NOT NULL,revision INTEGER NOT NULL UNIQUE,PRIMARY KEY(interface,minute_ts));
	 CREATE INDEX IF NOT EXISTS traffic_sync ON traffic_versions(revision);
	 CREATE TABLE IF NOT EXISTS total_versions(interface TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE);
	 CREATE TABLE IF NOT EXISTS resource_minutes(minute_ts INTEGER PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,metrics TEXT NOT NULL);
	 CREATE INDEX IF NOT EXISTS resource_sync ON resource_minutes(revision);
	 CREATE TABLE IF NOT EXISTS sync_state(name TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0);
	 INSERT OR IGNORE INTO meta VALUES('sequence','0');
	 INSERT OR IGNORE INTO meta VALUES('source_id','');
	 INSERT OR IGNORE INTO sync_state VALUES('traffic',0),('resources',0),('totals',0);
	 `); err != nil {
		db.Close()
		return nil, err
	}
	if err = migrateDiskStore(db); err != nil {
		db.Close()
		return nil, err
	}
	s := &Store{DB: db}
	err = db.QueryRow("SELECT v FROM meta WHERE k='source_id'").Scan(&s.SourceID)
	if err == nil && s.SourceID == "" {
		var bytes [16]byte
		if _, err = rand.Read(bytes[:]); err != nil {
			db.Close()
			return nil, err
		}
		bytes[6] = bytes[6]&0x0f | 0x40
		bytes[8] = bytes[8]&0x3f | 0x80
		hexID := hex.EncodeToString(bytes[:])
		s.SourceID = fmt.Sprintf("%s-%s-%s-%s-%s", hexID[:8], hexID[8:12], hexID[12:16], hexID[16:20], hexID[20:])
		_, err = db.Exec("UPDATE meta SET v=? WHERE k='source_id'", s.SourceID)
	}
	if err == nil {
		err = s.seedLegacyVersions()
	}
	if err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func nextRevision(tx *sql.Tx) (int64, error) {
	var seq int64
	if err := tx.QueryRow("UPDATE meta SET v=CAST(v AS INTEGER)+1 WHERE k='sequence' RETURNING CAST(v AS INTEGER)").Scan(&seq); err != nil {
		return 0, err
	}
	return seq, nil
}

func (s *Store) seedLegacyVersions() error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var seq int64
	if err = tx.QueryRow("SELECT CAST(v AS INTEGER) FROM meta WHERE k='sequence'").Scan(&seq); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO traffic_versions(interface,minute_ts,revision)
	 SELECT m.interface,m.minute_ts,?+ROW_NUMBER() OVER(ORDER BY m.minute_ts,m.interface) FROM minutes m
	 WHERE NOT EXISTS(SELECT 1 FROM traffic_versions v WHERE v.interface=m.interface AND v.minute_ts=m.minute_ts)`, seq); err != nil {
		return err
	}
	if err = tx.QueryRow("SELECT MAX(?,COALESCE(MAX(revision),0)) FROM traffic_versions", seq).Scan(&seq); err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO total_versions(interface,revision) SELECT t.interface,?+ROW_NUMBER() OVER(ORDER BY t.interface) FROM totals t
	 WHERE NOT EXISTS(SELECT 1 FROM total_versions v WHERE v.interface=t.interface)`, seq); err != nil {
		return err
	}
	if err = tx.QueryRow("SELECT MAX(?,COALESCE(MAX(revision),0)) FROM total_versions", seq).Scan(&seq); err != nil {
		return err
	}
	if _, err = tx.Exec("UPDATE meta SET v=? WHERE k='sequence'", strconv.FormatInt(seq, 10)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SaveResource(now time.Time, values map[string]*float64) (int64, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	minute := now.Unix() / 60 * 60
	stats := map[string]Stats{}
	var existing string
	err = tx.QueryRow("SELECT metrics FROM resource_minutes WHERE minute_ts=?", minute).Scan(&existing)
	if err == nil {
		if err = json.Unmarshal([]byte(existing), &stats); err != nil {
			return 0, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	for _, key := range MetricKeys {
		v := stats[key]
		if n := values[key]; n != nil {
			previous := 0.0
			if v.Avg != nil {
				previous = *v.Avg * float64(v.Count)
			}
			v.Count++
			v.Avg = number((previous + *n) / float64(v.Count))
			if v.Max == nil || *n > *v.Max {
				v.Max = number(*n)
			}
		}
		stats[key] = v
	}
	body, err := json.Marshal(stats)
	if err != nil {
		return 0, err
	}
	seq, err := nextRevision(tx)
	if err != nil {
		return 0, err
	}
	if _, err = tx.Exec(`INSERT INTO resource_minutes VALUES(?,?,?) ON CONFLICT(minute_ts) DO UPDATE SET revision=excluded.revision,metrics=excluded.metrics`, minute, seq, string(body)); err != nil {
		return 0, err
	}
	if _, err = tx.Exec("DELETE FROM resource_minutes WHERE minute_ts<?", now.Add(-30*24*time.Hour).Unix()); err != nil {
		return 0, err
	}
	return seq, tx.Commit()
}

func (s *Store) Batch() (Report, error) {
	report := Report{ProtocolVersion: 1, SourceID: s.SourceID, Traffic: []TrafficMinute{}, Resources: []ResourceMinute{}, Totals: []Total{}}
	rows, err := s.DB.Query(`SELECT m.interface,m.minute_ts,v.revision,CAST(m.rx_bytes AS TEXT),CAST(m.tx_bytes AS TEXT)
	 FROM traffic_versions v JOIN minutes m USING(interface,minute_ts) WHERE v.revision>(SELECT cursor FROM sync_state WHERE name='traffic') ORDER BY v.revision LIMIT 256`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var p TrafficMinute
		if err = rows.Scan(&p.Interface, &p.Minute, &p.Revision, &p.RX, &p.TX); err != nil {
			rows.Close()
			return report, err
		}
		report.Traffic = append(report.Traffic, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	rows, err = s.DB.Query("SELECT minute_ts,revision,metrics FROM resource_minutes WHERE revision>(SELECT cursor FROM sync_state WHERE name='resources') ORDER BY revision LIMIT 256")
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var p ResourceMinute
		var body string
		if err = rows.Scan(&p.Minute, &p.Revision, &body); err != nil {
			rows.Close()
			return report, err
		}
		if err = json.Unmarshal([]byte(body), &p.Values); err != nil {
			rows.Close()
			return report, err
		}
		report.Resources = append(report.Resources, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return report, err
	}
	rows, err = s.DB.Query(`SELECT t.interface,v.revision,CAST(t.rx_bytes AS TEXT),CAST(t.tx_bytes AS TEXT) FROM totals t JOIN total_versions v USING(interface)
	 WHERE v.revision>(SELECT cursor FROM sync_state WHERE name='totals') ORDER BY v.revision LIMIT 256`)
	if err != nil {
		return report, err
	}
	for rows.Next() {
		var p Total
		if err = rows.Scan(&p.Interface, &p.Revision, &p.RX, &p.TX); err != nil {
			rows.Close()
			return report, err
		}
		report.Totals = append(report.Totals, p)
	}
	err = rows.Err()
	rows.Close()
	if err == nil {
		report.DiskIO, err = s.diskBatch()
	}
	return report, err
}

func (s *Store) Acknowledge(ack Ack, report Report) error {
	maximum := Ack{}
	for _, row := range report.Traffic {
		maximum.Traffic = max(maximum.Traffic, row.Revision)
	}
	for _, row := range report.Resources {
		maximum.Resources = max(maximum.Resources, row.Revision)
	}
	for _, row := range report.Totals {
		maximum.Totals = max(maximum.Totals, row.Revision)
	}
	for _, row := range report.DiskIO {
		maximum.DiskIO = max(maximum.DiskIO, row.Revision)
	}
	if ack != maximum {
		return errors.New("中心确认与发送批次不一致，保留待同步记录")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for name, cursor := range map[string]int64{"traffic": ack.Traffic, "resources": ack.Resources, "totals": ack.Totals, "disk_io": ack.DiskIO} {
		if _, err = tx.Exec("UPDATE sync_state SET cursor=MAX(cursor,?) WHERE name=?", cursor, name); err != nil {
			return err
		}
	}
	return tx.Commit()
}
