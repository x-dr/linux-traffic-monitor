package monitor

import (
	"database/sql"
	"encoding/json"
	"time"
)

func migrateProbeStore(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS probe_results(sample_id TEXT PRIMARY KEY,revision INTEGER NOT NULL UNIQUE,scheduled_at REAL NOT NULL,result TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS probe_sync ON probe_results(revision);
 CREATE INDEX IF NOT EXISTS probe_retention ON probe_results(scheduled_at);
 INSERT OR IGNORE INTO sync_state VALUES('probes',0);
 INSERT OR IGNORE INTO meta VALUES('probe_drops','{"count":0,"oldest_at":null,"newest_at":null}');
 INSERT OR IGNORE INTO meta VALUES('server_probes_supported','0');
 PRAGMA user_version=3;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) SaveProbe(result ProbeResult) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result.Revision, err = nextRevision(tx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(result)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO probe_results VALUES(?,?,?,?)", result.SampleID, result.Revision, result.ScheduledAt, string(body)); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) probeBatch() ([]ProbeResult, error) {
	rows, err := s.DB.Query("SELECT result FROM probe_results WHERE revision>(SELECT cursor FROM sync_state WHERE name='probes') ORDER BY revision LIMIT 256")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []ProbeResult{}
	for rows.Next() {
		var body string
		var result ProbeResult
		if err = rows.Scan(&body); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &result); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}
func (s *Store) PruneProbes(now time.Time) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var raw string
	var drops ProbeDrops
	if err = tx.QueryRow("SELECT v FROM meta WHERE k='probe_drops'").Scan(&raw); err != nil {
		return err
	}
	if err = json.Unmarshal([]byte(raw), &drops); err != nil {
		return err
	}
	var count int64
	var oldest, newest sql.NullFloat64
	cutoff := float64(now.Add(-7 * 24 * time.Hour).Unix())
	if err = tx.QueryRow("SELECT COUNT(*),MIN(scheduled_at),MAX(scheduled_at) FROM probe_results WHERE scheduled_at<? AND revision>(SELECT cursor FROM sync_state WHERE name='probes')", cutoff).Scan(&count, &oldest, &newest); err != nil {
		return err
	}
	if count > 0 {
		drops.Count += count
		if drops.Oldest == nil || oldest.Float64 < *drops.Oldest {
			drops.Oldest = number(oldest.Float64)
		}
		if drops.Newest == nil || newest.Float64 > *drops.Newest {
			drops.Newest = number(newest.Float64)
		}
		body, _ := json.Marshal(drops)
		if _, err = tx.Exec("UPDATE meta SET v=? WHERE k='probe_drops'", string(body)); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("DELETE FROM probe_results WHERE scheduled_at<?", cutoff); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) ProbeDropSummary() (*ProbeDrops, error) {
	var body string
	var drops ProbeDrops
	if err := s.DB.QueryRow("SELECT v FROM meta WHERE k='probe_drops'").Scan(&body); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(body), &drops); err != nil {
		return nil, err
	}
	return &drops, nil
}
