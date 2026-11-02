package monitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestTelemetryOldCenterFallbackKeepsUnacknowledgedHistoryAndStopsCapabilities(t *testing.T) {
	s := testStore(t)
	now := time.Now()
	if err := s.SaveTelemetry("diagnostics", now, 1, []TelemetryObject{observation("cpu", "boot", "ok", float64(now.Unix()), 5, map[string]*float64{"iowait_percent": number(5)})}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		var raw map[string]json.RawMessage
		if err := json.NewDecoder(req.Body).Decode(&raw); err != nil {
			t.Error(err)
		}
		if calls == 1 {
			if raw["capabilities"] == nil || raw["diagnostics"] == nil {
				t.Error("no extension batch")
			}
			w.WriteHeader(422)
			return
		}
		for _, key := range []string{"diagnostics", "workloads", "sync_health", "capabilities", "applied_extensions_config_version", "extensions_config_error"} {
			if raw[key] != nil {
				t.Errorf("fallback kept %s", key)
			}
		}
		json.NewEncoder(w).Encode(Reply{Config: DefaultSettings(), ConfigVersion: 1, Ack: Ack{}})
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Token: "test-only-token-with-at-least-32-characters", Settings: DefaultSettings(), AppliedVersion: 1}
	runner := NewRunner(s, cfg, filepath.Join(t.TempDir(), "agent.json"))
	runner.serverCapabilities = &Capabilities{Diagnostics: 1, Workloads: 1}
	runner.telemetryCapabilities = *runner.serverCapabilities
	if err := runner.Send(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatal(calls)
	}
	pending, _ := s.telemetryBatch("diagnostics")
	if len(pending) != 1 {
		t.Fatal("rejected batch was acknowledged")
	}
	if runner.telemetryCapabilities.Diagnostics != 0 {
		t.Fatal("capability not withdrawn")
	}
}
