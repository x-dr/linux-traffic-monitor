package monitor

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strings"
)

type Capabilities struct {
	Probes      int `json:"probes,omitempty"`
	Diagnostics int `json:"diagnostics,omitempty"`
	Workloads   int `json:"workloads,omitempty"`
	Reporting   int `json:"reporting,omitempty"`
}
type ProbeAssignment struct {
	ID       string  `json:"id"`
	Version  int64   `json:"version"`
	StartAt  float64 `json:"start_at"`
	Kind     string  `json:"kind"`
	Target   string  `json:"target"`
	Port     int     `json:"port"`
	Family   string  `json:"family"`
	Interval int     `json:"interval_seconds"`
	Timeout  int     `json:"timeout_seconds"`
}
type ExtensionsConfig struct {
	Probes         []ProbeAssignment  `json:"probes"`
	Diagnostics    *DiagnosticsConfig `json:"diagnostics,omitempty"`
	Workloads      *WorkloadsConfig   `json:"workloads,omitempty"`
	ReportInterval *int               `json:"report_interval_seconds,omitempty"`
}
type ProbeDrops struct {
	Count  int64    `json:"count"`
	Oldest *float64 `json:"oldest_at"`
	Newest *float64 `json:"newest_at"`
}
type ProbeResult struct {
	SampleID             string   `json:"sample_id"`
	TaskID               string   `json:"task_id"`
	TaskVersion          int64    `json:"task_version"`
	Revision             int64    `json:"revision"`
	ScheduledAt          float64  `json:"scheduled_at"`
	StartedAt            float64  `json:"started_at"`
	CompletedAt          float64  `json:"completed_at"`
	Status               string   `json:"status"`
	Attempts             int      `json:"attempts"`
	LatencyMS            *float64 `json:"latency_ms"`
	HTTPStatus           *int     `json:"http_status"`
	CertificateExpiresAt *float64 `json:"certificate_expires_at"`
}

var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var hostPattern = regexp.MustCompile(`^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9])$`)

func (c ExtensionsConfig) Validate() error {
	if c.ReportInterval != nil && !validReportInterval(*c.ReportInterval) {
		return errors.New("invalid_config")
	}
	if !c.validateTelemetry() || len(c.Probes) > 10 {
		return errors.New("invalid_config")
	}
	seen := map[string]bool{}
	for _, p := range c.Probes {
		host := p.Target
		if p.Kind == "http" {
			u, err := url.Parse(p.Target)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(p.Target, "?#") || p.Port != 0 {
				return errors.New("invalid_config")
			}
			host = u.Hostname()
		} else if p.Kind != "tcp" && p.Kind != "icmp" {
			return errors.New("invalid_config")
		}
		ip := net.ParseIP(host)
		if len(host) > 253 || strings.Contains(host, "%") || (ip == nil && !hostPattern.MatchString(host)) {
			return errors.New("invalid_config")
		}
		if ip != nil && ((ip.To4() != nil) != (p.Family == "ipv4")) {
			return errors.New("invalid_config")
		}
		if !uuidPattern.MatchString(p.ID) || seen[p.ID] || p.Version < 1 || p.StartAt < 0 || (p.Family != "ipv4" && p.Family != "ipv6") || p.Interval < 15 || p.Interval > 3600 || p.Timeout < 1 || p.Timeout > 10 || p.Port < 0 || p.Port > 65535 || (p.Kind == "tcp" && p.Port == 0) || (p.Kind == "icmp" && p.Port != 0) {
			return errors.New("invalid_config")
		}
		seen[p.ID] = true
	}
	return nil
}
