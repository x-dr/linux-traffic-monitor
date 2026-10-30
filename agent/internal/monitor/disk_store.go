package monitor

import (
	"database/sql"
	"errors"
	"math/big"
	"sort"
	"strconv"
	"time"
)

func migrateDiskStore(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`CREATE TABLE IF NOT EXISTS disk_baselines (
  device TEXT PRIMARY KEY, read_counter INTEGER NOT NULL, write_counter INTEGER NOT NULL,
  boot_id TEXT NOT NULL, identity TEXT NOT NULL, observed_ms INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS disk_minutes (
  device TEXT NOT NULL, minute_ts INTEGER NOT NULL, revision INTEGER NOT NULL UNIQUE,
  read_bytes INTEGER NOT NULL, write_bytes INTEGER NOT NULL, observed_seconds REAL NOT NULL,
  PRIMARY KEY(device,minute_ts)
 );
 CREATE INDEX IF NOT EXISTS disk_sync ON disk_minutes(revision);
 CREATE INDEX IF NOT EXISTS disk_retention ON disk_minutes(minute_ts);
 INSERT OR IGNORE INTO sync_state VALUES('disk_io',0);
 PRAGMA user_version=2;`)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) SampleDisks(now time.Time, boot string, readings map[string]DiskCounters) ([]DiskIOSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	names := make([]string, 0, len(readings))
	for name := range readings {
		names = append(names, name)
	}
	sort.Strings(names)
	result := []DiskIOSnapshot{}
	readable := map[string]bool{}
	currentMS := now.UnixMilli()
	for _, name := range names {
		current := readings[name]
		if !devicePattern.MatchString(name) || current.Read < 0 || current.Write < 0 {
			return nil, errors.New("磁盘读写计数器无效")
		}
		var oldRead, oldWrite, oldMS int64
		var oldBoot, identity string
		err = tx.QueryRow("SELECT read_counter,write_counter,boot_id,identity,observed_ms FROM disk_baselines WHERE device=?", name).
			Scan(&oldRead, &oldWrite, &oldBoot, &identity, &oldMS)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		elapsed := currentMS - oldMS
		point := DiskIOSnapshot{Device: name}
		continuous := s.diskReadable == nil || s.diskReadable[name]
		if exists && continuous && oldBoot == boot && identity == current.Identity && elapsed > 0 && elapsed <= 15000 && current.Read >= oldRead && current.Write >= oldWrite {
			read, write := current.Read-oldRead, current.Write-oldWrite
			point.ReadBPS = number(float64(read) * 1000 / float64(elapsed))
			point.WriteBPS = number(float64(write) * 1000 / float64(elapsed))
			if err = saveDiskInterval(tx, name, oldMS, currentMS, read, write); err != nil {
				return nil, err
			}
		}
		_, err = tx.Exec(`INSERT INTO disk_baselines VALUES(?,?,?,?,?,?) ON CONFLICT(device) DO UPDATE SET
   read_counter=excluded.read_counter,write_counter=excluded.write_counter,boot_id=excluded.boot_id,
   identity=excluded.identity,observed_ms=excluded.observed_ms`, name, current.Read, current.Write, boot, current.Identity, currentMS)
		if err != nil {
			return nil, err
		}
		result = append(result, point)
		readable[name] = true
	}
	if _, err = tx.Exec("DELETE FROM disk_minutes WHERE minute_ts<?", now.Add(-30*24*time.Hour).Unix()); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	s.diskReadable = readable
	return result, nil
}

// Prefix allocation keeps the sum exact even for counters above float64 precision.
func diskByteShare(value, elapsed, total int64) int64 {
	var product big.Int
	product.Mul(big.NewInt(value), big.NewInt(elapsed))
	product.Quo(&product, big.NewInt(total))
	return product.Int64()
}

func saveDiskInterval(tx *sql.Tx, device string, start, end, read, write int64) error {
	var assignedRead, assignedWrite int64
	for cursor := start; cursor < end; {
		minute := cursor / 60000 * 60
		stop := min(end, (minute+60)*1000)
		nextRead := diskByteShare(read, stop-start, end-start)
		nextWrite := diskByteShare(write, stop-start, end-start)
		deltaRead, deltaWrite := nextRead-assignedRead, nextWrite-assignedWrite
		var storedRead, storedWrite int64
		var seconds float64
		err := tx.QueryRow("SELECT read_bytes,write_bytes,observed_seconds FROM disk_minutes WHERE device=? AND minute_ts=?", device, minute).
			Scan(&storedRead, &storedWrite, &seconds)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if storedRead, err = checkedAdd(storedRead, deltaRead); err != nil {
			return err
		}
		if storedWrite, err = checkedAdd(storedWrite, deltaWrite); err != nil {
			return err
		}
		seconds += float64(stop-cursor) / 1000
		// A clock correction must not create an overlapping, invalid minute report.
		if seconds > 60.000001 {
			return errors.New("磁盘采样时间重叠，请检查系统时钟")
		}
		seconds = min(seconds, 60)
		revision, err := nextRevision(tx)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO disk_minutes VALUES(?,?,?,?,?,?) ON CONFLICT(device,minute_ts) DO UPDATE SET
   revision=excluded.revision,read_bytes=excluded.read_bytes,write_bytes=excluded.write_bytes,
   observed_seconds=excluded.observed_seconds`, device, minute, revision, storedRead, storedWrite, seconds)
		if err != nil {
			return err
		}
		cursor = stop
		assignedRead = nextRead
		assignedWrite = nextWrite
	}
	return nil
}

func (s *Store) diskBatch() ([]DiskMinute, error) {
	rows, err := s.DB.Query(`SELECT device,minute_ts,revision,read_bytes,write_bytes,observed_seconds FROM disk_minutes
  WHERE revision>(SELECT cursor FROM sync_state WHERE name='disk_io') ORDER BY revision LIMIT 256`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []DiskMinute{}
	for rows.Next() {
		var point DiskMinute
		var read, write int64
		if err = rows.Scan(&point.Device, &point.Minute, &point.Revision, &read, &write, &point.ObservedSeconds); err != nil {
			return nil, err
		}
		point.ReadBytes = strconv.FormatInt(read, 10)
		point.WriteBytes = strconv.FormatInt(write, 10)
		result = append(result, point)
	}
	return result, rows.Err()
}
