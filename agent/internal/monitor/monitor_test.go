package monitor

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "traffic.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.DB.Close() })
	return store
}
func total(t *testing.T, s *Store, iface string) (int64, int64) {
	t.Helper()
	var rx, tx int64
	if err := s.DB.QueryRow("SELECT rx_bytes,tx_bytes FROM totals WHERE interface=?", iface).Scan(&rx, &tx); err != nil {
		t.Fatal(err)
	}
	return rx, tx
}
func sample(t *testing.T, s *Store, ts int64, boot string, names []string, readings map[string]Counters) NetworkSample {
	t.Helper()
	value, err := s.SampleNetwork(time.Unix(ts, 0), boot, names, readings)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestMonthBounds(t *testing.T) {
	cases := []struct {
		now               string
		day               int
		clock, start, end string
	}{
		{"2026-10-30T00:00:00Z", 1, "00:00", "2026-10-01T00:00:00+08:00", "2026-11-01T00:00:00+08:00"},
		{"2026-10-15T00:29:00Z", 15, "08:30", "2026-09-15T08:30:00+08:00", "2026-10-15T08:30:00+08:00"},
		{"2026-10-15T00:30:00Z", 15, "08:30", "2026-10-15T08:30:00+08:00", "2026-11-15T08:30:00+08:00"},
		{"2027-03-01T00:00:00Z", 31, "09:00", "2027-02-28T09:00:00+08:00", "2027-03-31T09:00:00+08:00"},
		{"2028-03-01T00:00:00Z", 31, "09:00", "2028-02-29T09:00:00+08:00", "2028-03-31T09:00:00+08:00"},
		{"2026-12-31T16:00:00Z", 1, "00:00", "2027-01-01T00:00:00+08:00", "2027-02-01T00:00:00+08:00"},
	}
	for _, c := range cases {
		t.Run(c.now, func(t *testing.T) {
			now, _ := time.Parse(time.RFC3339, c.now)
			cfg := DefaultSettings()
			cfg.MonthStartDay = c.day
			cfg.MonthStartTime = c.clock
			_, start, end := MonthBounds(now, cfg)
			if start.Format(time.RFC3339) != c.start || end.Format(time.RFC3339) != c.end {
				t.Fatalf("unexpected bounds %s %s", start, end)
			}
		})
	}
}
func TestSettingsValidation(t *testing.T) {
	for _, modify := range []func(*Settings){func(s *Settings) { s.MonthStartDay = 0 }, func(s *Settings) { s.MonthStartTime = "24:00" }, func(s *Settings) { s.Timezone = "invalid/zone" }, func(s *Settings) { s.Interfaces = []string{"ens3", "ens3"} }, func(s *Settings) { s.Interfaces = []string{"../../etc"} }, func(s *Settings) { s.Interfaces = []string{} }} {
		cfg := DefaultSettings()
		modify(&cfg)
		if cfg.Validate() == nil {
			t.Fatal("invalid config accepted")
		}
	}
}

func TestDSTAnchorsMatchLegacyInstants(t *testing.T) {
	for _, c := range []struct {
		now, clock, expected string
		day                  int
	}{
		{"2026-03-09T12:00:00Z", "02:30", "2026-03-08T07:30:00Z", 8},
		{"2026-11-02T12:00:00Z", "01:30", "2026-11-01T05:30:00Z", 1},
	} {
		cfg := DefaultSettings()
		cfg.Timezone = "America/New_York"
		cfg.MonthStartDay = c.day
		cfg.MonthStartTime = c.clock
		now, _ := time.Parse(time.RFC3339, c.now)
		_, start, _ := MonthBounds(now, cfg)
		if start.UTC().Format(time.RFC3339) != c.expected {
			t.Fatalf("DST anchor: %s", start)
		}
	}
}

func TestRestartRestoresSourceBaselinesAndCursors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	sample(t, store, 1793380020, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	sample(t, store, 1793380021, "a", []string{"ens3"}, map[string]Counters{"ens3": {400, 600}})
	batch, err := store.Batch()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Acknowledge(Ack{Traffic: batch.Traffic[0].Revision, Totals: batch.Totals[0].Revision}, batch); err != nil {
		t.Fatal(err)
	}
	source := store.SourceID
	store.DB.Close()
	restored, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.DB.Close()
	if restored.SourceID != source {
		t.Fatal("source identity changed")
	}
	pending, err := restored.Batch()
	if err != nil || len(pending.Traffic) != 0 {
		t.Fatal("cursor not restored")
	}
	value := sample(t, restored, 1793380080, "a", []string{"ens3"}, map[string]Counters{"ens3": {500, 900}})
	if value.RX != 0 || value.TX != 0 {
		t.Fatal("restart created a speed spike")
	}
	rx, tx := total(t, restored, "ens3")
	if rx != 400 || tx != 800 {
		t.Fatal("baseline not restored")
	}
}

func TestMissingInterfaceRecoveryDoesNotCreateSpeedSpike(t *testing.T) {
	store := testStore(t)
	names := []string{"ens3"}
	sample(t, store, 1793380020, "a", names, map[string]Counters{"ens3": {100, 100}})
	sample(t, store, 1793380021, "a", names, map[string]Counters{})
	recovered := sample(t, store, 1793380022, "a", names, map[string]Counters{"ens3": {500, 900}})
	if recovered.RX != 0 || recovered.TX != 0 {
		t.Fatal("unobserved traffic appeared as current speed")
	}
	rx, tx := total(t, store, "ens3")
	if rx != 400 || tx != 800 {
		t.Fatal("recovery lost traffic")
	}
}
func TestCounterPersistenceRebootAndReset(t *testing.T) {
	s := testStore(t)
	names := []string{"ens3"}
	start := int64(1793380000)
	first := sample(t, s, start, "boot-a", names, map[string]Counters{"ens3": {100, 100}})
	if first.RX != 0 {
		t.Fatal("first sample must not create speed")
	}
	second := sample(t, s, start+1, "boot-a", names, map[string]Counters{"ens3": {400, 600}})
	if second.RX != 300 || second.TX != 500 {
		t.Fatal("unexpected speed")
	}
	rx, tx := total(t, s, "ens3")
	if rx != 300 || tx != 500 {
		t.Fatalf("unexpected total %d/%d", rx, tx)
	}
	s.lastTick = time.Time{}
	s.active = nil // Process restart, same kernel boot.
	restored := sample(t, s, start+60, "boot-a", names, map[string]Counters{"ens3": {500, 900}})
	if restored.RX != 0 || restored.TX != 0 {
		t.Fatal("offline accumulation masqueraded as speed")
	}
	rx, tx = total(t, s, "ens3")
	if rx != 400 || tx != 800 {
		t.Fatalf("restart lost data %d/%d", rx, tx)
	}
	reboot := sample(t, s, start+61, "boot-b", names, map[string]Counters{"ens3": {20, 30}})
	if reboot.RX != 0 || reboot.TX != 0 {
		t.Fatal("reboot spike")
	}
	reset := sample(t, s, start+62, "boot-b", names, map[string]Counters{"ens3": {5, 8}})
	if reset.RX != 0 || reset.TX != 0 {
		t.Fatal("counter reset spike")
	}
	rx, tx = total(t, s, "ens3")
	if rx != 425 || tx != 838 {
		t.Fatalf("reset accounting %d/%d", rx, tx)
	}
}
func TestInterfaceSwitchPreservesHistory(t *testing.T) {
	s := testStore(t)
	start := int64(1793380000)
	sample(t, s, start, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	sample(t, s, start+1, "a", []string{"ens3"}, map[string]Counters{"ens3": {200, 300}})
	sample(t, s, start+2, "a", []string{"eth1"}, map[string]Counters{"eth1": {1000, 1000}})
	sample(t, s, start+3, "a", []string{"ens3"}, map[string]Counters{"ens3": {900, 900}})
	rx, tx := total(t, s, "ens3")
	if rx != 100 || tx != 200 {
		t.Fatal("switch counted traffic while unselected")
	}
	missing := sample(t, s, start+4, "a", []string{"ens3"}, map[string]Counters{})
	if missing.Error == nil {
		t.Fatal("missing interface not surfaced")
	}
}
func TestOverflowRollsBackBaseline(t *testing.T) {
	s := testStore(t)
	start := int64(1793380000)
	sample(t, s, start, "a", []string{"ens3"}, map[string]Counters{"ens3": {1, 1}})
	if _, err := s.DB.Exec("UPDATE totals SET rx_bytes=? WHERE interface='ens3'", int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SampleNetwork(time.Unix(start+1, 0), "a", []string{"ens3"}, map[string]Counters{"ens3": {2, 2}}); err == nil {
		t.Fatal("overflow accepted")
	}
	var counter int64
	s.DB.QueryRow("SELECT rx_counter FROM baselines WHERE interface='ens3'").Scan(&counter)
	if counter != 1 {
		t.Fatal("baseline not rolled back")
	}
}
func TestAcknowledgementIsDurableAndDoesNotLoseConcurrentUpdates(t *testing.T) {
	s := testStore(t)
	start := int64(1793380000)
	sample(t, s, start, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	batch, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	sample(t, s, start+1, "a", []string{"ens3"}, map[string]Counters{"ens3": {200, 300}})
	ack := Ack{Traffic: batch.Traffic[0].Revision, Totals: batch.Totals[0].Revision}
	if err = s.Acknowledge(ack, batch); err != nil {
		t.Fatal(err)
	}
	next, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Traffic) != 1 || next.Traffic[0].RX != "100" {
		t.Fatal("concurrent minute update was skipped")
	}
	bad := ack
	bad.Traffic += 100
	if s.Acknowledge(bad, batch) == nil {
		t.Fatal("unbounded ack accepted")
	}
	var cursor int64
	s.DB.QueryRow("SELECT cursor FROM sync_state WHERE name='traffic'").Scan(&cursor)
	if cursor != ack.Traffic {
		t.Fatal("ack not persisted")
	}
}
func TestResourceAggregationAndRetention(t *testing.T) {
	s := testStore(t)
	now := time.Unix(1793380020, 0)
	if _, err := s.SaveResource(now, map[string]*float64{"cpu_percent": number(10)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveResource(now.Add(5*time.Second), map[string]*float64{"cpu_percent": number(30)}); err != nil {
		t.Fatal(err)
	}
	batch, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	cpu := batch.Resources[0].Values["cpu_percent"]
	if cpu.Count != 2 || *cpu.Avg != 20 || *cpu.Max != 30 {
		t.Fatal("invalid aggregation")
	}
	if batch.Resources[0].Values["memory_percent"].Avg != nil {
		t.Fatal("missing metric became zero")
	}
	sample(t, s, now.Unix(), "a", []string{"ens3"}, map[string]Counters{"ens3": {0, 0}})
	if _, err = s.SaveResource(now.Add(31*24*time.Hour), map[string]*float64{}); err != nil {
		t.Fatal(err)
	}
	var resources, traffic int
	s.DB.QueryRow("SELECT COUNT(*) FROM resource_minutes").Scan(&resources)
	s.DB.QueryRow("SELECT COUNT(*) FROM minutes").Scan(&traffic)
	if resources != 1 || traffic != 1 {
		t.Fatal("retention deleted traffic or retained expired resources")
	}
}
func TestSharedProtocolFixture(t *testing.T) {
	body, err := os.ReadFile("../../../packages/contracts/fixtures/report.json")
	if err != nil {
		t.Fatal(err)
	}
	var report Report
	if err = json.Unmarshal(body, &report); err != nil {
		t.Fatal(err)
	}
	if report.ProtocolVersion != 1 || report.Snapshot.MemoryTotal != "2147483648" || len(report.Resources[0].Values) != len(MetricKeys) {
		t.Fatal("protocol mismatch")
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip Report
	if err = json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.Totals[0].RX != report.Totals[0].RX {
		t.Fatal("byte precision lost")
	}
}
func TestPersistentPartitionFiltering(t *testing.T) {
	if PersistentPartition("overlay", "/") || PersistentPartition("tmpfs", "/run") || PersistentPartition("ext4", "/var/lib/docker/overlay2/test") {
		t.Fatal("virtual mount accepted")
	}
	if !PersistentPartition("ext4", "/") || !PersistentPartition("xfs", "/data") {
		t.Fatal("persistent mount excluded")
	}
}
