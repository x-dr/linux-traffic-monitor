package monitor

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v4/process"
)

type WorkloadCollector struct{ counters DiagnosticCollector }

func (c *WorkloadCollector) Collect(ctx context.Context, cfg Config, now float64) []TelemetryObject {
	result := []TelemetryObject{}
	workloads := cfg.Extensions.Workloads
	if workloads == nil {
		return result
	}
	allowed := map[string]bool{}
	for _, name := range workloads.Processes {
		allowed[name] = true
	}
	found := map[string]bool{}
	processes, err := process.ProcessesWithContext(ctx)
	if err != nil {
		for name := range allowed {
			result = append(result, observation("process:"+name, name, "unreadable", now, 30, map[string]*float64{}))
		}
	} else {
		type reading struct {
			o   TelemetryObject
			rss uint64
		}
		readings := []reading{}
		unreadable := false
		for _, p := range processes {
			if ctx.Err() != nil {
				break
			}
			name, e := p.NameWithContext(ctx)
			if e != nil {
				unreadable = true
				continue
			}
			if !allowed[name] {
				continue
			}
			found[name] = true
			created, e := p.CreateTimeWithContext(ctx)
			if e != nil {
				continue
			}
			identity := fmt.Sprintf("%s:%d:%d", BootID(), p.Pid, created)
			values := map[string]*float64{"cpu_percent": nil, "rss_bytes": nil, "pid": number(float64(p.Pid)), "running": number(1)}
			status := "ok"
			var rss uint64
			if memory, e := p.MemoryInfoWithContext(ctx); e == nil {
				rss = memory.RSS
				values["rss_bytes"] = number(float64(rss))
			} else {
				status = "unreadable"
			}
			if times, e := p.TimesWithContext(ctx); e == nil {
				rate := c.counters.rates("process:"+identity, identity, now, times.User+times.System)[0]
				if rate != nil {
					values["cpu_percent"] = number(*rate * 100)
				}
			} else {
				status = "unreadable"
			}
			readings = append(readings, reading{observation("process:"+name+":"+fmt.Sprint(p.Pid), identity, status, now, 30, values), rss})
		}
		sort.Slice(readings, func(i, j int) bool { return readings[i].rss > readings[j].rss })
		for i, r := range readings {
			if i >= 10 {
				break
			}
			result = append(result, r.o)
		}
		for name := range allowed {
			status := "ok"
			running := number(1)
			if !found[name] {
				if unreadable || ctx.Err() != nil {
					status = "unreadable"
					running = nil
				} else {
					status = "absent"
					running = number(0)
				}
			}
			result = append(result, observation("process:"+name, name, status, now, 30, map[string]*float64{"running": running}))
		}
	}
	if workloads.Docker {
		result = append(result, collectContainers(ctx, cfg.DockerProxyURL, now)...)
	}
	return result
}
func (r *Runner) RunWorkloads(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	collector := &WorkloadCollector{}
	var lastVersion int64 = -1
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			r.mu.RLock()
			cfg := r.config
			active := r.telemetryCapabilities.Workloads == 1
			r.mu.RUnlock()
			if !active || cfg.Extensions.Workloads == nil || !cfg.Extensions.Workloads.Enabled {
				continue
			}
			if cfg.AppliedExtensions != lastVersion {
				collector = &WorkloadCollector{}
				lastVersion = cfg.AppliedExtensions
			}
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			objects := collector.Collect(work, cfg, float64(now.UnixMilli())/1000)
			cancel()
			if err := r.Store.SaveTelemetry("workloads", now, cfg.AppliedExtensions, objects); err != nil {
				log.Print("工作负载分钟记录保存失败")
				continue
			}
		}
	}
}
