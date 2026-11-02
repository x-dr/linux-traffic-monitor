package monitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReportIntervalValidationAndDurableConfig(t *testing.T) {
	for _, seconds := range []int{-1, 0, 2, 4, 16} {
		if (ExtensionsConfig{ReportInterval: &seconds}).Validate() == nil {
			t.Errorf("accepted interval %d", seconds)
		}
	}
	s := testStore(t)
	seconds, version := 5, int64(1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		var report Report
		if err := json.NewDecoder(req.Body).Decode(&report); err != nil {
			t.Error(err)
		}
		if version == 1 && (report.AppliedExtensions == nil || *report.AppliedExtensions != 0) {
			t.Error("missing interval was acknowledged before durable application")
		}
		json.NewEncoder(w).Encode(Reply{Config: DefaultSettings(), ConfigVersion: 1, ServerCapabilities: &Capabilities{Reporting: 1},
			ExtensionsConfig: &ExtensionsConfig{ReportInterval: &seconds}, ExtensionsVersion: version})
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Token: "test-only-token-with-at-least-32-characters", Settings: DefaultSettings(), AppliedVersion: 1, AppliedExtensions: 1}
	path := filepath.Join(t.TempDir(), "agent.json")
	runner := NewRunner(s, cfg, path)
	runner.serverCapabilities = &Capabilities{Reporting: 1}
	for _, interval := range []int{1, 3, 5, 10, 15} {
		seconds = interval
		// The first application repairs a previously acknowledged config missing the new field.
		if err := runner.Send(context.Background()); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadConfig(path)
		if err != nil || loaded.Extensions.ReportInterval == nil || *loaded.Extensions.ReportInterval != interval {
			t.Fatalf("interval %d not persisted: %v", interval, err)
		}
		if runner.reportInterval() != time.Duration(interval)*time.Second {
			t.Fatalf("interval %d not active", interval)
		}
		version++
	}
	seconds = 2
	if err := runner.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.extensionsError == nil || runner.reportInterval() != 15*time.Second {
		t.Fatal("invalid interval replaced working config")
	}
	seconds = 1
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	runner.ConfigPath = filepath.Join(blocked, "agent.json")
	if err := runner.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.extensionsError == nil || runner.reportInterval() != 15*time.Second {
		t.Fatal("failed durable write changed interval")
	}
	runner.serverCapabilities = nil
	if runner.reportInterval() != 15*time.Second {
		t.Fatal("re-negotiation lost saved interval")
	}
	runner.telemetryCapabilities = Capabilities{}
	if runner.reportInterval() != 5*time.Second {
		t.Fatal("old center did not restore default")
	}
}

func TestReportLoopChangesIntervalAndStopsPromptly(t *testing.T) {
	s := testStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	times := make(chan time.Time, 4)
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		seconds := 1
		if calls == 2 {
			seconds = 3
		}
		times <- time.Now()
		json.NewEncoder(w).Encode(Reply{Config: DefaultSettings(), ConfigVersion: 1, ServerCapabilities: &Capabilities{Reporting: 1},
			ExtensionsConfig: &ExtensionsConfig{ReportInterval: &seconds}, ExtensionsVersion: int64(calls)})
	}))
	defer server.Close()
	runner := NewRunner(s, Config{ServerURL: server.URL, Settings: DefaultSettings(), AppliedVersion: 1}, filepath.Join(t.TempDir(), "agent.json"))
	done := make(chan struct{})
	go func() { runner.runReports(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	var previous time.Time
	for i, expected := range []time.Duration{0, time.Second, 3 * time.Second, time.Second} {
		select {
		case at := <-times:
			if i > 0 && (at.Sub(previous) < expected-150*time.Millisecond || at.Sub(previous) > expected+time.Second) {
				t.Fatalf("report %d gap %v, expected %v", i, at.Sub(previous), expected)
			}
			previous = at
		case <-time.After(6 * time.Second):
			t.Fatal("report did not arrive")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("report loop did not stop promptly")
	}
}
