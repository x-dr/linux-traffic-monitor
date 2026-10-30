package monitor

import (
	"bufio"
	"database/sql"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Counters struct{ RX, TX int64 }
type NetworkSample struct {
	RX, TX             float64
	Selected, Readable []string
	Revision           int64
	Error              *string
}

func AvailableInterfaces() []string {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, entry := range entries {
		if entry.Name() != "lo" && ifacePattern.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names
}
func ResolveInterfaces(cfg Settings) []string {
	names, auto := cfg.InterfaceNames()
	if !auto {
		return names
	}
	file, err := os.Open("/proc/net/route")
	best := ""
	metric := int64(math.MaxInt64)
	if err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			parts := strings.Fields(scanner.Text())
			if len(parts) < 8 || parts[1] != "00000000" || parts[0] == "lo" {
				continue
			}
			flags, e1 := strconv.ParseInt(parts[3], 16, 64)
			value, e2 := strconv.ParseInt(parts[6], 10, 64)
			if e1 == nil && e2 == nil && flags&1 != 0 && value < metric {
				best = parts[0]
				metric = value
			}
		}
	}
	if best != "" {
		return []string{best}
	}
	names = AvailableInterfaces()
	for _, name := range names {
		if !strings.HasPrefix(name, "veth") && !strings.HasPrefix(name, "docker") && !strings.HasPrefix(name, "br-") && !strings.HasPrefix(name, "virbr") {
			return []string{name}
		}
	}
	if len(names) > 0 {
		return names[:1]
	}
	return []string{}
}
func ReadCounters(name string) (Counters, error) {
	var result Counters
	if !ifacePattern.MatchString(name) {
		return result, errors.New("网卡名称无效")
	}
	read := func(field string) (int64, error) {
		body, err := os.ReadFile(filepath.Join("/sys/class/net", name, "statistics", field))
		if err != nil {
			return 0, err
		}
		return strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	}
	var err error
	if result.RX, err = read("rx_bytes"); err != nil {
		return result, err
	}
	result.TX, err = read("tx_bytes")
	return result, err
}
func BootID() string {
	body, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(body))
}

func checkedAdd(a, b int64) (int64, error) {
	if a < 0 || b < 0 || a > math.MaxInt64-b {
		return 0, errors.New("流量累计超出 64 位整数范围")
	}
	return a + b, nil
}

func (s *Store) SampleNetwork(now time.Time, boot string, selected []string, readings map[string]Counters) (NetworkSample, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := NetworkSample{Selected: append([]string{}, selected...), Readable: []string{}}
	tx, err := s.DB.Begin()
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	elapsed := now.Sub(s.lastTick).Seconds()
	validElapsed := !s.lastTick.IsZero() && elapsed > 0
	missing := []string{}
	for _, name := range selected {
		current, present := readings[name]
		if !present {
			missing = append(missing, name)
			continue
		}
		result.Readable = append(result.Readable, name)
		if current.RX < 0 || current.TX < 0 {
			return result, errors.New("内核计数器不可为负")
		}
		var oldRX, oldTX int64
		var oldBoot string
		err = tx.QueryRow("SELECT rx_counter,tx_counter,boot_id FROM baselines WHERE interface=?", name).Scan(&oldRX, &oldTX, &oldBoot)
		exists := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		newlySelected := s.active != nil && !s.active[name]
		drx, dtx := int64(0), int64(0)
		if exists && !newlySelected {
			if oldBoot != boot {
				drx, dtx = current.RX, current.TX
			} else {
				if current.RX >= oldRX {
					drx = current.RX - oldRX
				} else {
					drx = current.RX
				}
				if current.TX >= oldTX {
					dtx = current.TX - oldTX
				} else {
					dtx = current.TX
				}
			}
		}
		if _, err = tx.Exec(`INSERT INTO baselines VALUES(?,?,?,?,?) ON CONFLICT(interface) DO UPDATE SET rx_counter=excluded.rx_counter,tx_counter=excluded.tx_counter,boot_id=excluded.boot_id,observed_at=excluded.observed_at`, name, current.RX, current.TX, boot, float64(now.UnixMilli())/1000); err != nil {
			return result, err
		}
		var totalRX, totalTX int64
		err = tx.QueryRow("SELECT rx_bytes,tx_bytes FROM totals WHERE interface=?", name).Scan(&totalRX, &totalTX)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		if totalRX, err = checkedAdd(totalRX, drx); err != nil {
			return result, err
		}
		if totalTX, err = checkedAdd(totalTX, dtx); err != nil {
			return result, err
		}
		if _, err = tx.Exec(`INSERT INTO totals VALUES(?,?,?) ON CONFLICT(interface) DO UPDATE SET rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes`, name, totalRX, totalTX); err != nil {
			return result, err
		}
		seq, err := nextRevision(tx)
		if err != nil {
			return result, err
		}
		if _, err = tx.Exec(`INSERT INTO total_versions VALUES(?,?) ON CONFLICT(interface) DO UPDATE SET revision=excluded.revision`, name, seq); err != nil {
			return result, err
		}
		minute := now.Unix() / 60 * 60
		var minuteRX, minuteTX int64
		err = tx.QueryRow("SELECT rx_bytes,tx_bytes FROM minutes WHERE minute_ts=? AND interface=?", minute, name).Scan(&minuteRX, &minuteTX)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		if minuteRX, err = checkedAdd(minuteRX, drx); err != nil {
			return result, err
		}
		if minuteTX, err = checkedAdd(minuteTX, dtx); err != nil {
			return result, err
		}
		if _, err = tx.Exec(`INSERT INTO minutes VALUES(?,?,?,?) ON CONFLICT(minute_ts,interface) DO UPDATE SET rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes`, minute, name, minuteRX, minuteTX); err != nil {
			return result, err
		}
		seq, err = nextRevision(tx)
		if err != nil {
			return result, err
		}
		if _, err = tx.Exec(`INSERT INTO traffic_versions VALUES(?,?,?) ON CONFLICT(interface,minute_ts) DO UPDATE SET revision=excluded.revision`, name, minute, seq); err != nil {
			return result, err
		}
		result.Revision = seq
		if validElapsed && exists && oldBoot == boot && !newlySelected && s.readable[name] {
			if current.RX >= oldRX {
				result.RX += float64(drx) / elapsed
			}
			if current.TX >= oldTX {
				result.TX += float64(dtx) / elapsed
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	s.lastTick = now
	s.active = map[string]bool{}
	s.readable = map[string]bool{}
	for _, name := range selected {
		s.active[name] = true
	}
	for _, name := range result.Readable {
		s.readable[name] = true
	}
	if len(missing) > 0 {
		message := "网卡不可读: " + strings.Join(missing, ", ")
		result.Error = &message
	} else if len(selected) == 0 {
		message := "未发现可监控网卡"
		result.Error = &message
	}
	return result, nil
}
