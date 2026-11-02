package monitor

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func diskSample(t *testing.T, store *Store, when time.Time, boot string, readings map[string]DiskCounters) []DiskIOSnapshot {
	t.Helper()
	points, err := store.SampleDisks(when, boot, readings)
	if err != nil {
		t.Fatal(err)
	}
	return points
}
func diskReadings(read, write int64) map[string]DiskCounters {
	return map[string]DiskCounters{"vda": {Read: read, Write: write, Identity: "252:0"}}
}
func diskReport(t *testing.T, store *Store) Report {
	t.Helper()
	report, err := store.Batch()
	if err != nil {
		t.Fatal(err)
	}
	return report
}

func TestDiskFirstIdleAndNormalSamples(t *testing.T) {
	store := testStore(t)
	start := time.Unix(1793380025, 0)
	first := diskSample(t, store, start, "a", diskReadings(100, 200))
	if first[0].ReadBPS != nil || len(diskReport(t, store).DiskIO) != 0 {
		t.Fatal("first sample created history")
	}
	normal := diskSample(t, store, start.Add(5*time.Second), "a", diskReadings(200, 400))
	if *normal[0].ReadBPS != 20 || *normal[0].WriteBPS != 40 {
		t.Fatal("incorrect sample speed")
	}
	idle := diskSample(t, store, start.Add(10*time.Second), "a", diskReadings(200, 400))
	if idle[0].ReadBPS == nil || *idle[0].ReadBPS != 0 {
		t.Fatal("idle was marked unavailable")
	}
	point := diskReport(t, store).DiskIO[0]
	if point.ReadBytes != "100" || point.WriteBytes != "200" || point.ObservedSeconds != 10 {
		t.Fatalf("bad minute: %+v", point)
	}
}

func TestDiskCrossMinuteAllocationPreservesLargeIntegers(t *testing.T) {
	store := testStore(t)
	start := time.Unix(1793380077, 0)
	diskSample(t, store, start, "a", diskReadings(0, 0))
	diskSample(t, store, start.Add(5*time.Second), "a", diskReadings(9007199254740993, 29))
	points := diskReport(t, store).DiskIO
	if len(points) != 2 {
		t.Fatalf("expected two minute buckets, got %d", len(points))
	}
	if points[0].ReadBytes != "5404319552844595" || points[1].ReadBytes != "3602879701896398" || points[0].WriteBytes != "17" || points[1].WriteBytes != "12" {
		t.Fatalf("allocation lost bytes: %+v", points)
	}
	if points[0].ObservedSeconds != 3 || points[1].ObservedSeconds != 2 {
		t.Fatal("incorrect bucket duration")
	}
}

func TestDiskDiscontinuitiesRebaselineWithoutSpikes(t *testing.T) {
	for _, kind := range []string{"boot", "reset", "identity", "gap", "missing", "clock"} {
		t.Run(kind, func(t *testing.T) {
			store := testStore(t)
			start := time.Unix(1793380025, 0)
			diskSample(t, store, start, "a", diskReadings(100, 200))
			next, boot, readings := start.Add(5*time.Second), "a", diskReadings(300, 400)
			switch kind {
			case "boot":
				boot = "b"
			case "reset":
				readings = diskReadings(1, 2)
			case "identity":
				readings["vda"] = DiskCounters{Read: 300, Write: 400, Identity: "253:0"}
			case "gap":
				next = start.Add(20 * time.Second)
			case "clock":
				next = start.Add(-time.Second)
			case "missing":
				diskSample(t, store, start.Add(time.Second), "a", nil)
			}
			point := diskSample(t, store, next, boot, readings)[0]
			if point.ReadBPS != nil || point.WriteBPS != nil || len(diskReport(t, store).DiskIO) != 0 {
				t.Fatal("discontinuity created history or speed")
			}
			updated := readings["vda"]
			updated.Read += 25
			updated.Write += 50
			readings["vda"] = updated
			point = diskSample(t, store, next.Add(5*time.Second), boot, readings)[0]
			if point.ReadBPS == nil || *point.ReadBPS != 5 || *point.WriteBPS != 10 {
				t.Fatal("sampling did not recover")
			}
		})
	}
}

func TestDiskRestartUsesDurableBaseline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1793380025, 0)
	diskSample(t, store, start, "a", diskReadings(100, 200))
	store.DB.Close()
	restored, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.DB.Close()
	point := diskSample(t, restored, start.Add(5*time.Second), "a", diskReadings(125, 250))[0]
	if point.ReadBPS == nil || *point.ReadBPS != 5 {
		t.Fatal("baseline lost during restart")
	}
	if diskReport(t, restored).DiskIO[0].ReadBytes != "25" {
		t.Fatal("restart counted entire raw counter")
	}
}

func TestDiskOverflowRollsBackBaselineAndMinute(t *testing.T) {
	store := testStore(t)
	start := time.Unix(1793380025, 0)
	diskSample(t, store, start, "a", diskReadings(1, 1))
	_, err := store.DB.Exec("INSERT INTO disk_minutes VALUES('vda',?,1,?,0,1)", start.Unix()/60*60, int64(math.MaxInt64))
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.SampleDisks(start.Add(5*time.Second), "a", diskReadings(2, 2))
	if err == nil {
		t.Fatal("overflow accepted")
	}
	var counter, total int64
	if err = store.DB.QueryRow("SELECT read_counter FROM disk_baselines WHERE device='vda'").Scan(&counter); err != nil {
		t.Fatal(err)
	}
	if err = store.DB.QueryRow("SELECT read_bytes FROM disk_minutes WHERE device='vda'").Scan(&total); err != nil {
		t.Fatal(err)
	}
	if counter != 1 || total != math.MaxInt64 {
		t.Fatal("overflow modified committed baseline")
	}
}

func TestDiskAckLossAndConcurrentSamplingRemainPending(t *testing.T) {
	store := testStore(t)
	start := time.Unix(1793380025, 0)
	diskSample(t, store, start, "a", diskReadings(100, 100))
	diskSample(t, store, start.Add(5*time.Second), "a", diskReadings(200, 200))
	first := diskReport(t, store)
	if store.Acknowledge(Ack{}, first) == nil {
		t.Fatal("missing disk ack accepted")
	}
	if len(diskReport(t, store).DiskIO) != 1 {
		t.Fatal("missing ack advanced cursor")
	}
	diskSample(t, store, start.Add(10*time.Second), "a", diskReadings(300, 300))
	if err := store.Acknowledge(Ack{DiskIO: first.DiskIO[0].Revision}, first); err != nil {
		t.Fatal(err)
	}
	next := diskReport(t, store)
	if len(next.DiskIO) != 1 || next.DiskIO[0].ReadBytes != "200" {
		t.Fatal("ack skipped concurrent minute update")
	}
	if err := store.Acknowledge(Ack{DiskIO: next.DiskIO[0].Revision}, next); err != nil {
		t.Fatal(err)
	}
	if len(diskReport(t, store).DiskIO) != 0 {
		t.Fatal("acked history repeated")
	}
}

func TestDiskBatchPaginationAndRetention(t *testing.T) {
	store := testStore(t)
	start := time.Unix(1793380025, 0)
	tx, err := store.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 300; i++ {
		revision, nextErr := nextRevision(tx)
		if nextErr != nil {
			t.Fatal(nextErr)
		}
		if _, err = tx.Exec("INSERT INTO disk_minutes VALUES('vda',?,?,1,2,5)", start.Unix()/60*60-int64(i)*60, revision); err != nil {
			t.Fatal(err)
		}
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	first := diskReport(t, store)
	if len(first.DiskIO) != 256 {
		t.Fatal("batch limit not respected")
	}
	if err = store.Acknowledge(Ack{DiskIO: first.DiskIO[255].Revision}, first); err != nil {
		t.Fatal(err)
	}
	if len(diskReport(t, store).DiskIO) != 44 {
		t.Fatal("remaining records skipped")
	}
	sample(t, store, start.Unix(), "a", []string{"ens3"}, map[string]Counters{"ens3": {1, 1}})
	diskSample(t, store, start.Add(31*24*time.Hour), "a", nil)
	var disks, traffic int
	store.DB.QueryRow("SELECT COUNT(*) FROM disk_minutes").Scan(&disks)
	store.DB.QueryRow("SELECT COUNT(*) FROM minutes").Scan(&traffic)
	if disks != 0 || traffic != 1 {
		t.Fatal("retention removed network history or retained expired disks")
	}
}

func TestDiskWholeDeviceFiltering(t *testing.T) {
	for _, name := range []string{"vda", "sda", "nvme0n1", "xvdb"} {
		if !WholeIODisk(name, false, 0) {
			t.Fatalf("excluded whole device %s", name)
		}
	}
	for _, name := range []string{"loop0", "ram0", "zram0", "sr0", "fd0", "../sda"} {
		if WholeIODisk(name, false, 0) {
			t.Fatalf("included unwanted device %s", name)
		}
	}
	if WholeIODisk("sda1", true, 0) || WholeIODisk("dm-0", false, 1) || WholeIODisk("md0", false, 2) {
		t.Fatal("double-counted partition or stacked device")
	}
}

func TestDiskV1StoreUpgradePreservesNetworkData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	sample(t, store, 1793380025, "a", []string{"ens3"}, map[string]Counters{"ens3": {1, 1}})
	source := store.SourceID
	_, err = store.DB.Exec("DROP TABLE disk_minutes; DROP TABLE disk_baselines; DELETE FROM sync_state WHERE name='disk_io'; PRAGMA user_version=1;")
	if err != nil {
		t.Fatal(err)
	}
	store.DB.Close()
	upgraded, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.DB.Close()
	var version, traffic int
	upgraded.DB.QueryRow("PRAGMA user_version").Scan(&version)
	upgraded.DB.QueryRow("SELECT COUNT(*) FROM minutes").Scan(&traffic)
	if version != 4 || traffic != 1 || upgraded.SourceID != source {
		t.Fatal("upgrade changed existing data")
	}
}

func TestDiskSharedProtocolFixture(t *testing.T) {
	body, err := os.ReadFile("../../../packages/contracts/fixtures/disk-report.json")
	if err != nil {
		t.Fatal(err)
	}
	var report Report
	if err = json.Unmarshal(body, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.DiskIO) != 1 || report.DiskIO[0].ReadBytes != "9007199254740993" || report.Snapshot.DiskIO[0].ReadBPS != nil {
		t.Fatal("disk contract mismatch")
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip Report
	if err = json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.DiskIO[0] != report.DiskIO[0] {
		t.Fatal("disk bytes lost precision")
	}
}
