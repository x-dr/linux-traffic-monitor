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

func TestRetryAckLossAndConfigFailure(t *testing.T) {
	s := testStore(t)
	start := int64(1793380020)
	sample(t, s, start, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	path := filepath.Join(t.TempDir(), "agent.json")
	cfg := Config{Settings: DefaultSettings(), Token: "test-only-token-with-at-least-32-characters", DataDir: t.TempDir()}
	attempts := 0
	var firstRevision int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		attempts++
		if req.Header.Get("Authorization") != "Bearer "+cfg.Token {
			t.Error("missing credential")
		}
		var report Report
		if err := json.NewDecoder(req.Body).Decode(&report); err != nil {
			t.Error(err)
		}
		if attempts == 1 {
			firstRevision = report.Traffic[0].Revision
			w.WriteHeader(503)
			return
		}
		if report.Traffic[0].Revision != firstRevision {
			t.Error("failed request advanced cursor")
		}
		settings := DefaultSettings()
		settings.Timezone = "invalid/zone"
		json.NewEncoder(w).Encode(Reply{Ack: Ack{Traffic: report.Traffic[0].Revision, Totals: report.Totals[0].Revision}, Config: settings, ConfigVersion: 2})
	}))
	defer server.Close()
	cfg.ServerURL = server.URL
	if err := SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	runner := NewRunner(s, cfg, path)
	if runner.Send(context.Background()) == nil {
		t.Fatal("HTTP error hidden")
	}
	if err := runner.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runner.configError == nil || runner.config.AppliedVersion != 0 {
		t.Fatal("invalid config replaced working config")
	}
	batch, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Traffic) != 0 {
		t.Fatal("successful ack not persisted")
	}
}
func TestConfigAppliesOnlyAfterDurableWrite(t *testing.T) {
	s := testStore(t)
	cfg := Config{Settings: DefaultSettings(), Token: "test-only-token-with-at-least-32-characters", DataDir: t.TempDir()}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		json.NewEncoder(w).Encode(Reply{Ack: Ack{}, Config: Settings{Interfaces: "auto", MonthStartDay: 15, MonthStartTime: "08:30", Timezone: "Asia/Shanghai"}, ConfigVersion: 3})
	}))
	defer server.Close()
	cfg.ServerURL = server.URL
	path := filepath.Join(t.TempDir(), "agent.json")
	runner := NewRunner(s, cfg, path)
	if err := runner.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AppliedVersion != 3 || loaded.Settings.MonthStartDay != 15 {
		t.Fatal("config not persisted")
	}
	block := filepath.Join(t.TempDir(), "not-a-directory")
	os.WriteFile(block, []byte("x"), 0600)
	failed := NewRunner(s, cfg, filepath.Join(block, "agent.json"))
	if err = failed.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if failed.configError == nil || failed.config.AppliedVersion != 0 {
		t.Fatal("configuration switched despite persistence failure")
	}
}
func TestTransportTimeoutDoesNotAcknowledge(t *testing.T) {
	s := testStore(t)
	sample(t, s, 1793380020, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		select {
		case <-req.Context().Done():
		case <-time.After(100 * time.Millisecond):
		}
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Token: "test-only-token-with-at-least-32-characters", Settings: DefaultSettings()}
	runner := NewRunner(s, cfg, filepath.Join(t.TempDir(), "agent.json"))
	runner.Client.Timeout = 30 * time.Millisecond
	if runner.Send(context.Background()) == nil {
		t.Fatal("timeout hidden")
	}
	batch, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	if len(batch.Traffic) == 0 {
		t.Fatal("timeout lost local history")
	}
}
