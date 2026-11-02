package monitor

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"
	_ "time/tzdata"
)

type Settings struct {
	Interfaces     any    `json:"interfaces"`
	MonthStartDay  int    `json:"month_start_day"`
	MonthStartTime string `json:"month_start_time"`
	Timezone       string `json:"timezone"`
}

type Config struct {
	DockerProxyURL    string           `json:"docker_proxy_url,omitempty"`
	ServerURL         string           `json:"server_url"`
	Token             string           `json:"token"`
	DataDir           string           `json:"data_dir"`
	Settings          Settings         `json:"settings"`
	AppliedVersion    int64            `json:"applied_config_version"`
	Extensions        ExtensionsConfig `json:"extensions_config"`
	AppliedExtensions int64            `json:"applied_extensions_config_version"`
	ProbeAllowCIDRs   []string         `json:"probe_allow_cidrs,omitempty"`
}

func DefaultSettings() Settings {
	return Settings{Interfaces: "auto", MonthStartDay: 1, MonthStartTime: "00:00", Timezone: "Asia/Shanghai"}
}

var ifacePattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,15}$`)
var timePattern = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

func (s Settings) InterfaceNames() ([]string, bool) {
	switch v := s.Interfaces.(type) {
	case string:
		return nil, v == "auto"
	case []string:
		return v, false
	case []any:
		names := make([]string, 0, len(v))
		for _, value := range v {
			name, ok := value.(string)
			if !ok {
				return nil, false
			}
			names = append(names, name)
		}
		return names, false
	}
	return nil, false
}

func (s Settings) Validate() error {
	if s.MonthStartDay < 1 || s.MonthStartDay > 31 || !timePattern.MatchString(s.MonthStartTime) {
		return errors.New("统计日须为 1～31，时间格式须为 HH:MM")
	}
	if len(s.Timezone) > 64 {
		return errors.New("时区名称过长")
	}
	if _, err := time.LoadLocation(s.Timezone); err != nil || s.Timezone == "" || s.Timezone == "Local" {
		return errors.New("无效的 IANA 时区")
	}
	names, auto := s.InterfaceNames()
	if auto {
		return nil
	}
	if len(names) == 0 || len(names) > 16 {
		return errors.New("网卡须为 auto 或 1～16 个名称")
	}
	seen := map[string]bool{}
	for _, name := range names {
		if !ifacePattern.MatchString(name) || seen[name] {
			return errors.New("网卡名称无效或重复")
		}
		seen[name] = true
	}
	return nil
}

func LoadConfig(path string) (Config, error) {
	var cfg Config
	body, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err = json.Unmarshal(body, &cfg); err != nil {
		return cfg, errors.New("配置 JSON 无效")
	}
	if cfg.Settings.Timezone == "" {
		cfg.Settings = DefaultSettings()
	}
	if cfg.DataDir == "" {
		cfg.DataDir = "/var/lib/trafficmon-agent"
	}
	if cfg.AppliedVersion < 0 {
		return cfg, errors.New("配置版本无效")
	}
	if err = cfg.Settings.Validate(); err != nil {
		return cfg, err
	}
	if err = cfg.Extensions.Validate(); err != nil || cfg.AppliedExtensions < 0 {
		return cfg, errors.New("扩展配置无效")
	}
	for _, cidr := range cfg.ProbeAllowCIDRs {
		if _, _, err := net.ParseCIDR(cidr); err != nil {
			return cfg, errors.New("探测允许网段无效")
		}
	}
	if cfg.DockerProxyURL != "" {
		if err = validateDockerProxy(cfg.DockerProxyURL); err != nil {
			return cfg, err
		}
	}
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return cfg, errors.New("server_url 须为不含凭据或查询参数的中心地址")
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")) {
		return cfg, errors.New("上报必须使用 HTTPS；HTTP 仅允许本机开发")
	}
	if len(cfg.Token) < 32 || len(cfg.Token) > 256 {
		return cfg, errors.New("token 无效，请使用中心生成的节点凭据")
	}
	if info, statErr := os.Stat(path); statErr == nil && info.Mode().Perm()&0077 != 0 {
		return cfg, errors.New("凭据配置文件权限须为 0600，请先执行 chmod 600")
	}
	return cfg, nil
}

func SaveConfig(path string, cfg Config) error {
	body, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-config-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(append(body, '\n')); err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(name, path)
}

func MonthBounds(now time.Time, cfg Settings) (time.Time, time.Time, time.Time) {
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		panic("MonthBounds requires validated settings")
	}
	local := now.In(loc)
	var hour, minute int
	fmt.Sscanf(cfg.MonthStartTime, "%d:%d", &hour, &minute)
	anchor := func(year int, month time.Month) time.Time {
		last := time.Date(year, month+1, 0, 0, 0, 0, 0, loc).Day()
		day := min(cfg.MonthStartDay, last)
		return calendarAnchor(year, month, day, hour, minute, loc)
	}
	base := time.Date(local.Year(), local.Month(), 1, 0, 0, 0, 0, loc)
	if local.Before(anchor(base.Year(), base.Month())) {
		base = base.AddDate(0, -1, 0)
	}
	p, n := base.AddDate(0, -1, 0), base.AddDate(0, 1, 0)
	return anchor(p.Year(), p.Month()), anchor(base.Year(), base.Month()), anchor(n.Year(), n.Month())
}

// Use the earliest instant for repeated local times and the pre-transition offset for gaps.
func calendarAnchor(year int, month time.Month, day, hour, minute int, loc *time.Location) time.Time {
	naive := time.Date(year, month, day, hour, minute, 0, 0, time.UTC)
	before := time.Date(year, month, day-2, 12, 0, 0, 0, loc)
	after := time.Date(year, month, day+2, 12, 0, 0, 0, loc)
	_, beforeOffset := before.Zone()
	_, afterOffset := after.Zone()
	var earliest time.Time
	for _, offset := range []int{beforeOffset, afterOffset} {
		candidate := time.Unix(naive.Unix()-int64(offset), 0).In(loc)
		if candidate.Year() == year && candidate.Month() == month && candidate.Day() == day && candidate.Hour() == hour && candidate.Minute() == minute {
			if earliest.IsZero() || candidate.Before(earliest) {
				earliest = candidate
			}
		}
	}
	if !earliest.IsZero() {
		return earliest
	}
	return time.Unix(naive.Unix()-int64(beforeOffset), 0).In(loc)
}
