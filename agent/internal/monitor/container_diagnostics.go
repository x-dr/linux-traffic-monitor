package monitor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

func validateDockerProxy(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("Docker 代理地址无效")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || ip == nil || !ip.IsLoopback() || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("Docker 代理须为本机 loopback HTTP 地址")
	}
	return nil
}

var containerIDPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func dockerGet(ctx context.Context, client *http.Client, base, path string, target any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(base, "/")+path, nil)
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("Docker API unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 2*1024*1024+1))
	if err != nil || len(body) > 2*1024*1024 {
		return errors.New("Docker response exceeds limit")
	}
	return json.Unmarshal(body, target)
}
func collectContainers(ctx context.Context, base string, now float64) []TelemetryObject {
	unavailable := func(status string) []TelemetryObject {
		return []TelemetryObject{observation("docker", "docker", status, now, 30, map[string]*float64{})}
	}
	if base == "" {
		return unavailable("disabled")
	}
	if validateDockerProxy(base) != nil {
		return unavailable("unreadable")
	}
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 2 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect blocked") }}
	var containers []struct {
		ID     string `json:"Id"`
		Names  []string
		State  string
		Status string
	}
	if dockerGet(ctx, client, base, "/containers/json?all=1", &containers) != nil {
		return unavailable("unreadable")
	}
	result := []TelemetryObject{}
	for _, container := range containers {
		if len(result) >= 10 || ctx.Err() != nil {
			break
		}
		if !containerIDPattern.MatchString(container.ID) {
			continue
		}
		values := map[string]*float64{"running": number(0), "healthy": nil, "restarts": nil, "cpu_percent": nil, "memory_bytes": nil, "rx_bytes": nil, "tx_bytes": nil, "read_bytes": nil, "write_bytes": nil}
		if container.State == "running" {
			values["running"] = number(1)
		}
		var inspect struct {
			RestartCount int
			State        struct{ Health *struct{ Status string } }
		}
		status := "ok"
		if dockerGet(ctx, client, base, "/containers/"+container.ID+"/json", &inspect) == nil {
			values["restarts"] = number(float64(inspect.RestartCount))
			if inspect.State.Health != nil {
				healthy := 0.
				if inspect.State.Health.Status == "healthy" {
					healthy = 1
				}
				values["healthy"] = number(healthy)
			}
		} else {
			status = "unreadable"
		}
		if container.State == "running" {
			type cpuStats struct {
				CPUUsage struct {
					TotalUsage uint64 `json:"total_usage"`
				} `json:"cpu_usage"`
				System uint64  `json:"system_cpu_usage"`
				Online float64 `json:"online_cpus"`
			}
			var stats struct {
				CPU      cpuStats `json:"cpu_stats"`
				Previous cpuStats `json:"precpu_stats"`
				Memory   struct{ Usage float64 }
				Networks map[string]struct {
					RX float64 `json:"rx_bytes"`
					TX float64 `json:"tx_bytes"`
				}
				Block struct {
					Entries []struct {
						Op    string
						Value float64
					} `json:"io_service_bytes_recursive"`
				} `json:"blkio_stats"`
			}
			if dockerGet(ctx, client, base, "/containers/"+container.ID+"/stats?stream=false", &stats) == nil {
				values["memory_bytes"] = number(stats.Memory.Usage)
				if stats.CPU.System > stats.Previous.System && stats.CPU.CPUUsage.TotalUsage >= stats.Previous.CPUUsage.TotalUsage && stats.CPU.Online > 0 {
					values["cpu_percent"] = number(float64(stats.CPU.CPUUsage.TotalUsage-stats.Previous.CPUUsage.TotalUsage) / float64(stats.CPU.System-stats.Previous.System) * stats.CPU.Online * 100)
				}
				rx, tx, read, write := 0., 0., 0., 0.
				for _, v := range stats.Networks {
					rx += v.RX
					tx += v.TX
				}
				for _, v := range stats.Block.Entries {
					switch strings.ToLower(v.Op) {
					case "read":
						read += v.Value
					case "write":
						write += v.Value
					}
				}
				values["rx_bytes"] = number(rx)
				values["tx_bytes"] = number(tx)
				values["read_bytes"] = number(read)
				values["write_bytes"] = number(write)
			} else {
				status = "unreadable"
			}
		}
		name := container.ID[:12]
		if len(container.Names) > 0 {
			name = strings.TrimPrefix(container.Names[0], "/")
			if len(name) > 120 {
				name = name[:120]
			}
		}
		result = append(result, observation("container:"+name, container.ID, status, now, 30, values))
	}
	return result
}
