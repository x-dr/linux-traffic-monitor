package monitor

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func probeConfig(target string) ProbeAssignment {
	return ProbeAssignment{ID: "14fd6834-91aa-48ba-aa75-8e27c8f635e4", Version: 1, StartAt: seconds(time.Now()) - 60, Kind: "http", Target: target, Family: "ipv4", Interval: 15, Timeout: 1}
}

type fixedResolver struct {
	addresses []netip.Addr
	calls     *int
}

func (f fixedResolver) LookupNetIP(_ context.Context, _, _ string) ([]netip.Addr, error) {
	if f.calls != nil {
		*f.calls++
	}
	return f.addresses, nil
}

func TestProbeAddressPolicyAndDNSPinning(t *testing.T) {
	executor := ProbeExecutor{}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.169.254", "100.100.100.200", "168.63.129.16", "64:ff9b::a9fe:a9fe", "fe80::1", "224.0.0.1"} {
		if executor.allowed(netip.MustParseAddr(address)) {
			t.Errorf("allowed restricted address %s", address)
		}
	}
	executor.AllowCIDRs = []string{"0.0.0.0/0", "::/0"}
	for _, address := range []string{"169.254.169.254", "100.100.100.200", "168.63.129.16", "fe80::1"} {
		if executor.allowed(netip.MustParseAddr(address)) {
			t.Fatal("sensitive address bypassed local allowlist")
		}
	}
	if !executor.allowed(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("explicit local allowlist ignored")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host[:len("example.test")] != "example.test" {
			t.Error("host header lost")
		}
		w.WriteHeader(204)
	}))
	defer server.Close()
	_, port, _ := net.SplitHostPort(server.Listener.Addr().String())
	calls := 0
	executor = ProbeExecutor{AllowCIDRs: []string{"127.0.0.1/32"}, Resolver: fixedResolver{[]netip.Addr{netip.MustParseAddr("127.0.0.1")}, &calls}}
	result := executor.Execute(context.Background(), probeConfig("http://example.test:"+port+"/"), seconds(time.Now())-1)
	if result.Status != "success" || calls != 1 || result.LatencyMS == nil {
		t.Fatalf("pinned request failed: %s, lookups %d", result.Status, calls)
	}
	executor.Resolver = fixedResolver{addresses: []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("10.0.0.1")}}
	result = executor.Execute(context.Background(), probeConfig("http://example.test/"), seconds(time.Now())-1)
	if result.Status != "blocked" || result.Attempts != 0 {
		t.Fatal("mixed private DNS answers accepted")
	}
}

func TestProbeHTTPRedirectBodyLimitTLSAndTimeout(t *testing.T) {
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/destination", 302)
		case "/destination":
			hits++
		case "/large":
			w.Write([]byte(strings.Repeat("a", 1024*1024)))
		case "/timeout":
			select {
			case <-r.Context().Done():
			case <-time.After(1500 * time.Millisecond):
			}
		case "/error":
			w.WriteHeader(503)
		default:
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	executor := ProbeExecutor{AllowCIDRs: []string{"127.0.0.1/32"}}
	for _, pair := range []struct{ path, status string }{{"/", "success"}, {"/redirect", "http"}, {"/large", "success"}, {"/timeout", "timeout"}, {"/error", "http"}} {
		r := executor.Execute(context.Background(), probeConfig(server.URL+pair.path), seconds(time.Now())-1)
		if r.Status != pair.status || r.Attempts != 1 {
			t.Errorf("%s: %s", pair.path, r.Status)
		}
	}
	if hits != 0 {
		t.Fatal("redirect followed")
	}
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer secure.Close()
	r := executor.Execute(context.Background(), probeConfig(secure.URL), seconds(time.Now())-1)
	if r.Status != "tls" || r.CertificateExpiresAt == nil || r.LatencyMS != nil {
		t.Fatal("self-signed TLS accepted or certificate evidence lost")
	}
}

func TestProbeTCPIPv6AndICMPPermission(t *testing.T) {
	listener, err := net.Listen("tcp6", "[::1]:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	p := probeConfig(host)
	p.Family = "ipv6"
	p.Kind = "tcp"
	p.Port, err = strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	r := (ProbeExecutor{AllowCIDRs: []string{"::1/128"}}).Execute(context.Background(), p, seconds(time.Now())-1)
	if r.Status != "success" {
		t.Fatal(r.Status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	status, err := pingEcho(ctx, netip.MustParseAddr("127.0.0.1"), func(_, _, _ int) (int, error) { return -1, syscall.EPERM })
	if status != "unsupported" || !errors.Is(err, syscall.EPERM) {
		t.Fatal("permission failure classified as packet loss")
	}
	status, err = pingEcho(ctx, netip.MustParseAddr("127.0.0.1"), openPingSocket)
	if status == "unsupported" {
		t.Skip("environment has no non-root ICMP ping socket")
	}
	if err != nil || status != "success" {
		t.Fatalf("local ping: %s %v", status, err)
	}
}

func TestProbeIndependentACKRetentionAndV2Migration(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "traffic.db")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	source := s.SourceID
	s.DB.Exec("DROP TABLE probe_results; DELETE FROM sync_state WHERE name='probes'; PRAGMA user_version=2")
	s.DB.Close()
	s, err = OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	if s.SourceID != source {
		t.Fatal("migration replaced source")
	}
	var version int
	s.DB.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 3 {
		t.Fatal(version)
	}
	now := time.Now()
	r := ProbeResult{SampleID: newSampleID(), TaskID: probeConfig("").ID, TaskVersion: 1, ScheduledAt: seconds(now), StartedAt: seconds(now), CompletedAt: seconds(now), Status: "success", Attempts: 1, LatencyMS: number(10)}
	if err = s.SaveProbe(r); err != nil {
		t.Fatal(err)
	}
	pending, err := s.probeBatch()
	if err != nil {
		t.Fatal(err)
	}
	report, _ := s.Batch()
	report.Probes = &pending
	if err = s.Acknowledge(Ack{}, report); err != nil {
		t.Fatal(err)
	}
	pending, _ = s.probeBatch()
	if len(pending) != 1 {
		t.Fatal("missing ACK advanced probe cursor")
	}
	wrong := pending[0].Revision + 1
	if s.Acknowledge(Ack{Probes: &wrong}, report) == nil {
		t.Fatal("unmatched ACK accepted")
	}
	exact := pending[0].Revision
	if err = s.Acknowledge(Ack{Probes: &exact}, report); err != nil {
		t.Fatal(err)
	}
	pending, _ = s.probeBatch()
	if len(pending) != 0 {
		t.Fatal("ACK not persisted")
	}
	r.SampleID = newSampleID()
	r.ScheduledAt = seconds(now.Add(-8 * 24 * time.Hour))
	if err = s.SaveProbe(r); err != nil {
		t.Fatal(err)
	}
	if err = s.PruneProbes(now); err != nil {
		t.Fatal(err)
	}
	drops, err := s.ProbeDropSummary()
	if err != nil || drops.Count != 1 || drops.Oldest == nil {
		t.Fatal("unconfirmed retention loss not persisted")
	}
}

func TestProbeNegotiationDowngradeAndDurableConfig(t *testing.T) {
	s := testStore(t)
	cfg := Config{Settings: DefaultSettings(), Token: strings.Repeat("t", 40)}
	requests := []Report{}
	downgrade := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var report Report
		json.NewDecoder(req.Body).Decode(&report)
		requests = append(requests, report)
		if downgrade && report.Capabilities != nil {
			w.WriteHeader(400)
			return
		}
		reply := Reply{Ack: Ack{}, Config: DefaultSettings(), ConfigVersion: 1}
		if !downgrade {
			reply.ServerCapabilities = &Capabilities{Probes: 1}
			reply.ExtensionsVersion = 2
			reply.ExtensionsConfig = &ExtensionsConfig{Probes: []ProbeAssignment{probeConfig("https://example.com/")}}
		}
		json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()
	cfg.ServerURL = server.URL
	path := filepath.Join(t.TempDir(), "agent.json")
	r := NewRunner(s, cfg, path)
	if err := r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests[0].Capabilities != nil || !r.probesActive {
		t.Fatal("first report sent unnegotiated fields")
	}
	loaded, err := LoadConfig(path)
	if err != nil || loaded.AppliedExtensions != 2 {
		t.Fatal("extension configuration not durable")
	}
	if err = r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests[1].Capabilities == nil || requests[1].Probes == nil || *requests[1].AppliedExtensions != 2 {
		t.Fatal("extensions not separately acknowledged")
	}
	downgrade = true
	if err = r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 4 || requests[3].Capabilities != nil || r.probesActive {
		t.Fatal("downgrade failed base-only re-negotiation")
	}
	restarted := NewRunner(s, loaded, path)
	if restarted.probesActive {
		t.Fatal("restart forgot capability removal")
	}
	block := filepath.Join(t.TempDir(), "file")
	os.WriteFile(block, []byte("x"), 0600)
	downgrade = false
	failed := NewRunner(s, cfg, filepath.Join(block, "agent.json"))
	if err = failed.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if failed.config.AppliedExtensions != 0 || failed.extensionsError == nil {
		t.Fatal("failed save acknowledged extensions")
	}
}

func TestProbeBudgetAndSchedulingDoNotReplayExpiredSlots(t *testing.T) {
	p := probeConfig("https://example.com/")
	p.StartAt = 100
	if nextProbeSlot(p, 131) != 145 {
		t.Fatal("missed slots replayed")
	}
	report := Report{Traffic: []TrafficMinute{}, Resources: []ResourceMinute{}, Totals: []Total{}, DiskIO: []DiskMinute{}}
	pending := []ProbeResult{}
	for i := int64(1); i <= 256; i++ {
		report.Traffic = append(report.Traffic, TrafficMinute{Interface: "ens3", Revision: i, RX: "1", TX: "1"})
		pending = append(pending, ProbeResult{SampleID: newSampleID(), Revision: 1000 + i})
	}
	report.Probes = &pending
	body, err := budgetReport(&report, 2048)
	if err != nil || len(body) > 2048 {
		t.Fatal("budget exceeded")
	}
	if len(report.Traffic) < 1 || len(*report.Probes) < 1 || report.Traffic[0].Revision != 1 || (*report.Probes)[0].Revision != 1001 {
		t.Fatal("budget starved a stream or skipped oldest record")
	}
}

func TestProbeMigrationRollbackPreservesV2(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.Exec("CREATE TABLE probe_results(conflict TEXT); PRAGMA user_version=2")
	if migrateProbeStore(db) == nil {
		t.Fatal("conflicting migration succeeded")
	}
	var version int
	db.QueryRow("PRAGMA user_version").Scan(&version)
	if version != 2 {
		t.Fatal("failed migration advanced version")
	}
}

func TestProbeSchedulerDoesNotBlockCollectionAndStopsOnCancellation(t *testing.T) {
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { started <- struct{}{}; <-r.Context().Done() }))
	defer server.Close()
	s := testStore(t)
	p := probeConfig(server.URL)
	p.StartAt = seconds(time.Now()) + 0.75
	p.Timeout = 3
	cfg := Config{Settings: DefaultSettings(), Extensions: ExtensionsConfig{Probes: []ProbeAssignment{p}}, AppliedExtensions: 1, ProbeAllowCIDRs: []string{"127.0.0.1/32"}}
	r := NewRunner(s, cfg, filepath.Join(t.TempDir(), "agent.json"))
	r.probesActive = true
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { r.RunProbes(ctx); close(done) }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("probe was not scheduled")
	}
	before := time.Now()
	if err := r.Collect(ctx, false); err != nil {
		t.Fatal(err)
	}
	if time.Since(before) > 500*time.Millisecond {
		t.Fatal("probe blocked base collection")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("probe worker ignored cancellation")
	}
}

func TestProbeSharedContractFixture(t *testing.T) {
	body, err := os.ReadFile("../../../packages/contracts/fixtures/probes.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Config ExtensionsConfig `json:"config"`
		Result ProbeResult      `json:"result"`
	}
	if err = json.Unmarshal(body, &fixture); err != nil {
		t.Fatal(err)
	}
	if err = fixture.Config.Validate(); err != nil {
		t.Fatal(err)
	}
	if fixture.Result.Status != "success" || fixture.Result.TaskID != fixture.Config.Probes[0].ID || fixture.Result.LatencyMS == nil || fixture.Result.CertificateExpiresAt == nil {
		t.Fatal("shared fixture lost fields")
	}
}

func TestProbeOfflineRetriesKeepSampleAndIndependentCursor(t *testing.T) {
	s := testStore(t)
	offline := false
	cfg := Config{Settings: DefaultSettings(), Token: strings.Repeat("t", 40)}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if offline {
			w.WriteHeader(503)
			return
		}
		var report Report
		json.NewDecoder(req.Body).Decode(&report)
		reply := Reply{Ack: Ack{}, Config: DefaultSettings(), ConfigVersion: 1, ServerCapabilities: &Capabilities{Probes: 1}}
		if report.Probes != nil {
			var maximum int64
			for _, row := range *report.Probes {
				maximum = max(maximum, row.Revision)
			}
			reply.Ack.Probes = &maximum
		}
		json.NewEncoder(w).Encode(reply)
	}))
	defer server.Close()
	cfg.ServerURL = server.URL
	r := NewRunner(s, cfg, filepath.Join(t.TempDir(), "agent.json"))
	if err := r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	sample := ProbeResult{SampleID: newSampleID(), TaskID: probeConfig("").ID, TaskVersion: 1, Status: "success", Attempts: 1, LatencyMS: number(10), ScheduledAt: seconds(time.Now()) - 1, StartedAt: seconds(time.Now()) - 1, CompletedAt: seconds(time.Now())}
	if err := s.SaveProbe(sample); err != nil {
		t.Fatal(err)
	}
	offline = true
	if r.Send(context.Background()) == nil {
		t.Fatal("offline failure hidden")
	}
	if !r.probesActive {
		t.Fatal("network outage stopped saved probe configuration")
	}
	pending, _ := s.probeBatch()
	if len(pending) != 1 || pending[0].SampleID != sample.SampleID {
		t.Fatal("offline result lost")
	}
	offline = false
	if err := r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, _ = s.probeBatch()
	if len(pending) != 1 {
		t.Fatal("base re-negotiation advanced extension cursor")
	}
	if err := r.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	pending, _ = s.probeBatch()
	if len(pending) != 0 {
		t.Fatal("reconnected probe ACK not applied")
	}
}
