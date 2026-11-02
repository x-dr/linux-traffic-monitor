package monitor

import "regexp"

type ServiceConfig struct {
	Manager string `json:"manager"`
	Name    string `json:"name"`
}
type DiagnosticsConfig struct {
	Enabled  bool            `json:"enabled"`
	Services []ServiceConfig `json:"services"`
}
type WorkloadsConfig struct {
	Enabled   bool     `json:"enabled"`
	Docker    bool     `json:"docker"`
	Processes []string `json:"processes"`
}
type TelemetryStats struct {
	Last    *float64 `json:"last"`
	Avg     *float64 `json:"avg"`
	Max     *float64 `json:"max"`
	Count   int64    `json:"count"`
	Seconds float64  `json:"seconds"`
}
type TelemetryObject struct {
	Object     string                    `json:"object"`
	Identity   string                    `json:"identity"`
	ObservedAt float64                   `json:"observed_at"`
	Interval   int                       `json:"interval_seconds"`
	Status     string                    `json:"status"`
	Values     map[string]TelemetryStats `json:"values"`
}
type TelemetryMinute struct {
	Minute        int64             `json:"minute_ts"`
	Revision      int64             `json:"revision"`
	ConfigVersion int64             `json:"config_version"`
	Objects       []TelemetryObject `json:"objects"`
}
type StreamHealth struct {
	DropsTracked  bool     `json:"drops_tracked"`
	Name          string   `json:"name"`
	Pending       int64    `json:"pending"`
	Oldest        *float64 `json:"oldest_at"`
	Cursor        int64    `json:"cursor"`
	Dropped       int64    `json:"dropped"`
	DroppedOldest *float64 `json:"dropped_oldest_at"`
	DroppedNewest *float64 `json:"dropped_newest_at"`
}
type SyncHealth struct {
	Streams []StreamHealth `json:"streams"`
	LastAck *float64       `json:"last_ack_at"`
}

var serviceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_.@:-]{1,100}$`)

func (c ExtensionsConfig) validateTelemetry() bool {
	if c.Diagnostics != nil {
		if len(c.Diagnostics.Services) > 10 {
			return false
		}
		seen := map[string]bool{}
		for _, s := range c.Diagnostics.Services {
			if !serviceNamePattern.MatchString(s.Name) || (s.Manager != "systemd" && s.Manager != "openrc") || seen[s.Manager+":"+s.Name] {
				return false
			}
			seen[s.Manager+":"+s.Name] = true
		}
	}
	if c.Workloads != nil {
		if len(c.Workloads.Processes) > 20 {
			return false
		}
		seen := map[string]bool{}
		for _, p := range c.Workloads.Processes {
			if !serviceNamePattern.MatchString(p) || seen[p] {
				return false
			}
			seen[p] = true
		}
	}
	return true
}
func observation(object, identity, status string, now float64, interval int, values map[string]*float64) TelemetryObject {
	o := TelemetryObject{Object: object, Identity: identity, Status: status, ObservedAt: now, Interval: interval, Values: map[string]TelemetryStats{}}
	for key, v := range values {
		s := TelemetryStats{Last: v, Avg: v, Max: v}
		if v != nil {
			s.Count = 1
			s.Seconds = float64(interval)
		}
		o.Values[key] = s
	}
	return o
}
