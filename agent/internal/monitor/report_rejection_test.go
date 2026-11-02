package monitor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestReportRejectionOnlyLogsKnownConflictReasons(t *testing.T) {
	reasons := []string{
		"采集源发生变化，请创建新节点以保留原历史",
		"扩展配置确认超出中心版本，请检查是否恢复过中心数据库",
		"指标配置版本超出中心版本",
		"探测结果身份或 revision 冲突",
		"探测结果身份冲突",
		"探测 revision 冲突",
	}
	for _, reason := range reasons {
		t.Run(reason, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]string{"error": reason, "token": "must-not-log"})
			message := reportRejection(409, strings.NewReader(string(raw))).Error()
			if !strings.Contains(message, reason) || strings.Contains(message, "must-not-log") {
				t.Fatal("known reason missing or unrelated response fields leaked")
			}
		})
	}
	for _, body := range []string{
		`{"error":"unknown secret must-not-log"}`,
		`{"error":"采集源发生变化，请创建新节点以保留原历史\nmust-not-log"}`,
		`<html>must-not-log</html>`,
		`{"error":`,
		`{"error":42}`,
		`{"error":"采集源发生变化，请创建新节点以保留原历史","extra":"` + strings.Repeat("x", 4096) + `"}`,
	} {
		message := reportRejection(409, strings.NewReader(body)).Error()
		if message != "中心拒绝上报（HTTP 409），本地同步进度保持不变" {
			t.Fatal("unrecognized or oversized response was logged")
		}
	}
	raw, _ := json.Marshal(map[string]string{"error": reasons[0]})
	if message := reportRejection(503, strings.NewReader(string(raw))).Error(); message != "中心拒绝上报（HTTP 503），本地同步进度保持不变" {
		t.Fatal("non-conflict response changed error handling")
	}
}

func TestReportConflictKeepsSourceHistoryAndCursorsForRetry(t *testing.T) {
	s := testStore(t)
	sample(t, s, 1793380020, "a", []string{"ens3"}, map[string]Counters{"ens3": {100, 100}})
	before, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		var report Report
		if err := json.NewDecoder(req.Body).Decode(&report); err != nil {
			t.Error(err)
		}
		if report.SourceID != before.SourceID || len(report.Traffic) != len(before.Traffic) {
			t.Error("conflict changed source or pending history")
		}
		if (calls == 1) != (report.Capabilities != nil) {
			t.Error("conflict did not return to base negotiation")
		}
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"error": "采集源发生变化，请创建新节点以保留原历史"})
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Settings: DefaultSettings(), AppliedVersion: 1, AppliedExtensions: 2}
	runner := NewRunner(s, cfg, filepath.Join(t.TempDir(), "agent.json"))
	runner.serverCapabilities = &Capabilities{Reporting: 1}
	for attempt := 0; attempt < 3; attempt++ {
		err := runner.Send(context.Background())
		if err == nil || !strings.Contains(err.Error(), "原因：采集源发生变化") {
			t.Fatal("conflict reason hidden")
		}
	}
	if calls != 3 {
		t.Fatal("409 caused an immediate retry or fallback")
	}
	after, err := s.Batch()
	if err != nil {
		t.Fatal(err)
	}
	if after.SourceID != before.SourceID || len(after.Traffic) != len(before.Traffic) || after.Traffic[0].Revision != before.Traffic[0].Revision || len(after.Totals) != len(before.Totals) {
		t.Fatal("conflict acknowledged or rewrote pending data")
	}
	if runner.config.AppliedVersion != cfg.AppliedVersion || runner.config.AppliedExtensions != cfg.AppliedExtensions {
		t.Fatal("conflict rewrote applied config versions")
	}
}
