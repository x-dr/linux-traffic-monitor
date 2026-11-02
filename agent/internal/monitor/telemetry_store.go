package monitor

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"
)

func migrateTelemetryStore(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS telemetry_minutes(stream TEXT NOT NULL,minute_ts INTEGER NOT NULL,revision INTEGER NOT NULL UNIQUE,data TEXT NOT NULL,PRIMARY KEY(stream,minute_ts));
 CREATE INDEX IF NOT EXISTS telemetry_sync ON telemetry_minutes(stream,revision);
 INSERT OR IGNORE INTO sync_state VALUES('diagnostics',0),('workloads',0);
 INSERT OR IGNORE INTO meta VALUES('diagnostics_drops','{"count":0,"oldest_at":null,"newest_at":null}'),('workloads_drops','{"count":0,"oldest_at":null,"newest_at":null}'),('last_ack_at','0');
 PRAGMA user_version=4;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) SaveTelemetry(stream string, now time.Time, version int64, objects []TelemetryObject) error {
	if stream != "diagnostics" && stream != "workloads" {
		return errors.New("unknown telemetry stream")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	minute := now.Unix() / 60 * 60
	var body string
	result := TelemetryMinute{Minute: minute, ConfigVersion: version, Objects: []TelemetryObject{}}
	err = tx.QueryRow("SELECT data FROM telemetry_minutes WHERE stream=? AND minute_ts=?", stream, minute).Scan(&body)
	if err == nil {
		if err = json.Unmarshal([]byte(body), &result); err != nil {
			return err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if result.ConfigVersion != version {
		result.Objects = []TelemetryObject{}
		result.ConfigVersion = version
	}
	merged := map[string]TelemetryObject{}
	for _, o := range result.Objects {
		merged[o.Object] = o
	}
	for _, o := range objects {
		previous, ok := merged[o.Object]
		if ok && previous.Identity == o.Identity && o.ObservedAt <= previous.ObservedAt {
			continue
		}
		if ok && previous.Identity == o.Identity && o.ObservedAt > previous.ObservedAt {
			for key, v := range o.Values {
				old := previous.Values[key]
				if v.Count == 0 && old.Count > 0 {
					last := v.Last
					v = old
					v.Last = last
				}
				if v.Count > 0 && old.Count > 0 {
					v.Avg = number((*old.Avg*float64(old.Count) + *v.Avg*float64(v.Count)) / float64(old.Count+v.Count))
					v.Max = number(max(*old.Max, *v.Max))
					v.Count += old.Count
					v.Seconds = min(60, old.Seconds+v.Seconds)
				}
				o.Values[key] = v
			}
		}
		merged[o.Object] = o
	}
	result.Objects = []TelemetryObject{}
	for _, o := range merged {
		result.Objects = append(result.Objects, o)
	}
	sort.Slice(result.Objects, func(i, j int) bool { return result.Objects[i].Object < result.Objects[j].Object })
	result.Revision, err = nextRevision(tx)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO telemetry_minutes VALUES(?,?,?,?) ON CONFLICT(stream,minute_ts) DO UPDATE SET revision=excluded.revision,data=excluded.data", stream, minute, result.Revision, string(raw)); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) telemetryBatch(stream string) ([]TelemetryMinute, error) {
	rows, err := s.DB.Query("SELECT data FROM telemetry_minutes WHERE stream=? AND revision>(SELECT cursor FROM sync_state WHERE name=?) ORDER BY revision LIMIT 256", stream, stream)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []TelemetryMinute{}
	for rows.Next() {
		var body string
		var r TelemetryMinute
		if err = rows.Scan(&body); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &r); err != nil {
			return nil, err
		}
		result = append(result, r)
	}
	return result, rows.Err()
}
func acknowledgeTelemetry(tx *sql.Tx, stream string, sent *[]TelemetryMinute, ack *int64) error {
	if sent == nil {
		if ack != nil && *ack != 0 {
			return errors.New("中心确认了未发送的扩展批次")
		}
		return nil
	}
	if ack == nil {
		return nil
	}
	var highest int64
	for _, r := range *sent {
		highest = max(highest, r.Revision)
	}
	if highest != *ack {
		return errors.New("扩展确认与发送批次不一致")
	}
	_, err := tx.Exec("UPDATE sync_state SET cursor=MAX(cursor,?) WHERE name=?", highest, stream)
	return err
}
func (s *Store) PruneTelemetry(now time.Time) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stream := range []string{"diagnostics", "workloads"} {
		var body string
		var d ProbeDrops
		if err = tx.QueryRow("SELECT v FROM meta WHERE k=?", stream+"_drops").Scan(&body); err != nil {
			return err
		}
		if err = json.Unmarshal([]byte(body), &d); err != nil {
			return err
		}
		var count int64
		var oldest, newest sql.NullFloat64
		cutoff := now.Add(-30 * 24 * time.Hour).Unix()
		if err = tx.QueryRow("SELECT COUNT(*),MIN(minute_ts),MAX(minute_ts) FROM telemetry_minutes WHERE stream=? AND minute_ts<? AND revision>(SELECT cursor FROM sync_state WHERE name=?)", stream, cutoff, stream).Scan(&count, &oldest, &newest); err != nil {
			return err
		}
		if count > 0 {
			d.Count += count
			if d.Oldest == nil || oldest.Float64 < *d.Oldest {
				d.Oldest = number(oldest.Float64)
			}
			if d.Newest == nil || newest.Float64 > *d.Newest {
				d.Newest = number(newest.Float64)
			}
			raw, _ := json.Marshal(d)
			if _, err = tx.Exec("UPDATE meta SET v=? WHERE k=?", string(raw), stream+"_drops"); err != nil {
				return err
			}
		}
		if _, err = tx.Exec("DELETE FROM telemetry_minutes WHERE stream=? AND minute_ts<?", stream, cutoff); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) SyncHealth() (*SyncHealth, error) {
	health := &SyncHealth{Streams: []StreamHealth{}}
	specs := []struct{ name, table, timeColumn, filter string }{
		{"traffic", "traffic_versions", "minute_ts", ""}, {"resources", "resource_minutes", "minute_ts", ""}, {"totals", "total_versions", "NULL", ""}, {"disk_io", "disk_minutes", "minute_ts", ""}, {"probes", "probe_results", "scheduled_at", ""}, {"diagnostics", "telemetry_minutes", "minute_ts", " AND stream='diagnostics'"}, {"workloads", "telemetry_minutes", "minute_ts", " AND stream='workloads'"},
	}
	for _, spec := range specs {
		var h StreamHealth
		h.Name = spec.name
		var oldest sql.NullFloat64
		if err := s.DB.QueryRow("SELECT cursor FROM sync_state WHERE name=?", spec.name).Scan(&h.Cursor); err != nil {
			return nil, err
		}
		if err := s.DB.QueryRow("SELECT COUNT(*),MIN("+spec.timeColumn+") FROM "+spec.table+" WHERE revision>?"+spec.filter, h.Cursor).Scan(&h.Pending, &oldest); err != nil {
			return nil, err
		}
		if oldest.Valid {
			h.Oldest = number(oldest.Float64)
		}
		if spec.name == "probes" || spec.name == "diagnostics" || spec.name == "workloads" {
			h.DropsTracked = true
			var body string
			var d ProbeDrops
			key := spec.name + "_drops"
			if spec.name == "probes" {
				key = "probe_drops"
			}
			if err := s.DB.QueryRow("SELECT v FROM meta WHERE k=?", key).Scan(&body); err != nil {
				return nil, err
			}
			if err := json.Unmarshal([]byte(body), &d); err != nil {
				return nil, err
			}
			h.Dropped = d.Count
			h.DroppedOldest = d.Oldest
			h.DroppedNewest = d.Newest
		}
		health.Streams = append(health.Streams, h)
	}
	var ack float64
	if err := s.DB.QueryRow("SELECT CAST(v AS REAL) FROM meta WHERE k='last_ack_at'").Scan(&ack); err != nil {
		return nil, err
	}
	if ack > 0 {
		health.LastAck = number(ack)
	}
	return health, nil
}
