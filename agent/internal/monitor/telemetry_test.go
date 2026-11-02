package monitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTelemetryStoreAggregationIdentityAndIndependentACK(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "traffic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	now := time.Unix(1800000000, 0)
	save := func(at time.Time, id string, value float64) {
		t.Helper()
		if err = s.SaveTelemetry("diagnostics", at, 1, []TelemetryObject{observation("cpu", id, "ok", float64(at.Unix()), 5, map[string]*float64{"iowait_percent": number(value)})}); err != nil {
			t.Fatal(err)
		}
	}
	save(now, "a", 10)
	save(now, "a", 100)
	save(now.Add(5*time.Second), "a", 30)
	rows, err := s.telemetryBatch("diagnostics")
	if err != nil {
		t.Fatal(err)
	}
	stats := rows[0].Objects[0].Values["iowait_percent"]
	if stats.Count != 2 || *stats.Avg != 20 || *stats.Max != 30 || stats.Seconds != 10 {
		t.Fatalf("bad aggregation: %+v", stats)
	}
	report := Report{Diagnostics: &rows}
	bad := rows[0].Revision + 1
	if s.Acknowledge(Ack{Diagnostics: &bad}, report) == nil {
		t.Fatal("invalid ACK accepted")
	}
	if err = s.Acknowledge(Ack{}, report); err != nil {
		t.Fatal(err)
	}
	pending, _ := s.telemetryBatch("diagnostics")
	if len(pending) != 1 {
		t.Fatal("missing ACK advanced stream")
	}
	correct := rows[0].Revision
	if err = s.Acknowledge(Ack{Diagnostics: &correct}, report); err != nil {
		t.Fatal(err)
	}
	pending, _ = s.telemetryBatch("diagnostics")
	if len(pending) != 0 {
		t.Fatal("ACK not persisted")
	}
	save(now.Add(10*time.Second), "b", 90)
	rows, _ = s.telemetryBatch("diagnostics")
	if rows[0].Objects[0].Values["iowait_percent"].Count != 1 {
		t.Fatal("identity continuity not broken")
	}
	health, err := s.SyncHealth()
	if err != nil || len(health.Streams) != 7 || health.LastAck == nil {
		t.Fatalf("health: %+v %v", health, err)
	}
	if err = s.PruneTelemetry(now.Add(31 * 24 * time.Hour)); err != nil {
		t.Fatal(err)
	}
	health, _ = s.SyncHealth()
	for _, h := range health.Streams {
		if h.Name == "diagnostics" && h.Dropped != 1 {
			t.Fatalf("drop missing: %+v", h)
		}
	}
}
func TestDiagnosticCounterBaselinesAndPSI(t *testing.T) {
	c := &DiagnosticCollector{}
	if c.rates("cpu", "boot", 100, 10)[0] != nil {
		t.Fatal("first rate not null")
	}
	if *c.rates("cpu", "boot", 105, 20)[0] != 2 {
		t.Fatal("bad rate")
	}
	if c.rates("cpu", "boot", 110, 1)[0] != nil {
		t.Fatal("reset spike")
	}
	if c.rates("cpu", "boot", 150, 50)[0] != nil {
		t.Fatal("gap spike")
	}
	if c.rates("cpu", "newboot", 155, 60)[0] != nil {
		t.Fatal("boot spike")
	}
	path := filepath.Join(t.TempDir(), "psi")
	_, status := readPSI(path)
	if status != "unsupported" {
		t.Fatal(status)
	}
	os.WriteFile(path, []byte("some avg10=1.50 avg60=2.00 avg300=0.00 total=100\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n"), 0600)
	values, status := readPSI(path)
	if status != "ok" || *values["some_avg10"] != 1.5 || len(values) != 8 {
		t.Fatal(values, status)
	}
}
func TestTelemetryConfigRejectsCommandsAndContainerProxyUsesOnlyFixedGET(t *testing.T) {
	cfg := ExtensionsConfig{Diagnostics: &DiagnosticsConfig{Services: []ServiceConfig{{Manager: "systemd", Name: "nginx; reboot"}}}}
	if cfg.Validate() == nil {
		t.Fatal("command allowed")
	}
	id := strings.Repeat("a", 64)
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Error("non-read operation")
		}
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/containers/json":
			w.Write([]byte(`[{"Id":"` + id + `","Names":["/demo"],"State":"running"}]`))
		case "/containers/" + id + "/json":
			w.Write([]byte(`{"RestartCount":2,"State":{"Health":{"Status":"healthy"}},"Config":{"Env":["DO_NOT_STORE"]}}`))
		default:
			w.Write([]byte(`{"cpu_stats":{"cpu_usage":{"total_usage":200},"system_cpu_usage":2000,"online_cpus":2},"precpu_stats":{"cpu_usage":{"total_usage":100},"system_cpu_usage":1000},"memory":{"usage":1024},"networks":{"eth0":{"rx_bytes":100,"tx_bytes":200}},"blkio_stats":{"io_service_bytes_recursive":[{"Op":"Read","Value":50}]}}`))
		}
	}))
	defer server.Close()
	result := collectContainers(context.Background(), server.URL, 1800000000)
	if len(result) != 1 || result[0].Identity != id || *result[0].Values["cpu_percent"].Last != 20 {
		t.Fatalf("bad container: %+v", result)
	}
	raw, _ := json.Marshal(result)
	if strings.Contains(string(raw), "DO_NOT_STORE") {
		t.Fatal("environment leaked")
	}
	if len(paths) != 3 {
		t.Fatal(paths)
	}
	for _, url := range []string{"http://example.com:2375", "http://169.254.169.254", "unix:///var/run/docker.sock", "http://127.0.0.1:2375/?x=1"} {
		if validateDockerProxy(url) == nil {
			t.Fatal("unsafe proxy", url)
		}
	}
}
func TestTelemetryBudgetKeepsEveryStreamAndBaseFallbackHasNoExtensions(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "traffic.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	report, _ := s.Batch()
	now := time.Unix(1800000000, 0)
	s.SaveTelemetry("diagnostics", now, 1, []TelemetryObject{observation("cpu", "a", "ok", float64(now.Unix()), 5, map[string]*float64{"iowait_percent": number(5)})})
	d, _ := s.telemetryBatch("diagnostics")
	w := []TelemetryMinute{}
	report.Diagnostics = &d
	report.Workloads = &w
	report.Capabilities = &Capabilities{Diagnostics: 1, Workloads: 1}
	body, err := budgetReport(&report, 1500)
	if err != nil || len(body) > 1500 || len(*report.Diagnostics) != 1 {
		t.Fatal(err, len(body))
	}
}

func TestServiceManagersUseConfiguredNamesAndExplicitUnsupportedStates(t *testing.T) {
	dir := t.TempDir()
	systemd := `#!/bin/sh
if [ "$1" != show ] || [ "$2" != --property=ActiveState ] || [ "$3" != --value ] || [ "$4" != -- ]; then exit 1; fi
case "$5" in demo.service) printf 'active\n';; denied.service) exit 1;; *) printf 'unknown\n';; esac
`
	openrc := `#!/bin/sh
if [ "$2" != status ]; then exit 1; fi
case "$1" in demo) exit 0;; stopped) exit 3;; *) exit 1;; esac
`
	if err := os.WriteFile(filepath.Join(dir, "systemctl"), []byte(systemd), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "rc-service"), []byte(openrc), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	result := collectServices(context.Background(), []ServiceConfig{{Manager: "systemd", Name: "demo.service"}, {Manager: "openrc", Name: "demo"}, {Manager: "openrc", Name: "stopped"}, {Manager: "systemd", Name: "denied.service"}, {Manager: "systemd", Name: "missing.service"}}, 1800000000)
	if len(result) != 5 || *result[0].Values["running"].Last != 1 || *result[1].Values["running"].Last != 1 || *result[2].Values["running"].Last != 0 || result[3].Status != "unreadable" || result[4].Status != "unsupported" {
		t.Fatalf("service states: %+v", result)
	}
}
