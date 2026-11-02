package monitor

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
)

type counterBaseline struct {
	at       float64
	identity string
	values   []float64
}
type DiagnosticCollector struct {
	baselines   map[string]counterBaseline
	slow        []TelemetryObject
	lastSlow    float64
	network     []TelemetryObject
	lastNetwork float64
}

func (c *DiagnosticCollector) rates(key, identity string, now float64, values ...float64) []*float64 {
	if c.baselines == nil {
		c.baselines = map[string]counterBaseline{}
	}
	old, ok := c.baselines[key]
	c.baselines[key] = counterBaseline{now, identity, values}
	result := make([]*float64, len(values))
	maxGap := 15.
	if strings.HasPrefix(key, "net:") || key == "tcp" {
		maxGap = 45
	}
	if strings.HasPrefix(key, "process:") {
		maxGap = 90
	}
	if !ok || old.identity != identity || now <= old.at || now-old.at > maxGap || len(values) != len(old.values) {
		return result
	}
	for i, v := range values {
		if v < old.values[i] {
			return result
		}
	}
	for i, v := range values {
		result[i] = number((v - old.values[i]) / (now - old.at))
	}
	return result
}
func (c *DiagnosticCollector) Collect(ctx context.Context, cfg DiagnosticsConfig, now float64) []TelemetryObject {
	objects := []TelemetryObject{}
	boot := BootID()
	values := map[string]*float64{"user_percent": nil, "system_percent": nil, "iowait_percent": nil, "steal_percent": nil, "load_per_core": nil}
	status := "ok"
	if times, err := cpu.TimesWithContext(ctx, false); err == nil && len(times) > 0 {
		t := times[0]
		total := t.User + t.Nice + t.System + t.Idle + t.Iowait + t.Irq + t.Softirq + t.Steal
		deltas := c.rates("cpu", boot, now, total, t.User, t.System, t.Iowait, t.Steal)
		if deltas[0] != nil && *deltas[0] > 0 {
			for i, k := range []string{"user_percent", "system_percent", "iowait_percent", "steal_percent"} {
				values[k] = number(*deltas[i+1] / *deltas[0] * 100)
			}
		}
	} else {
		status = "unreadable"
	}
	if l, err := load.AvgWithContext(ctx); err == nil {
		values["load_per_core"] = number(l.Load1 / float64(runtime.NumCPU()))
	}
	objects = append(objects, observation("cpu", boot, status, now, 5, values))
	swap := map[string]*float64{"sin_bps": nil, "sout_bps": nil, "total_bytes": nil}
	status = "ok"
	if v, err := mem.SwapMemoryWithContext(ctx); err == nil {
		rates := c.rates("swap", boot, now, float64(v.Sin), float64(v.Sout))
		swap["sin_bps"] = rates[0]
		swap["sout_bps"] = rates[1]
		swap["total_bytes"] = number(float64(v.Total))
	} else {
		status = "unreadable"
	}
	objects = append(objects, observation("swap", boot, status, now, 5, swap))
	memoryValues := map[string]*float64{"total_bytes": nil, "available_bytes": nil}
	memoryStatus := "ok"
	if memory, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		memoryValues["total_bytes"] = number(float64(memory.Total))
		memoryValues["available_bytes"] = number(float64(memory.Available))
	} else {
		memoryStatus = "unreadable"
	}
	objects = append(objects, observation("memory", boot, memoryStatus, now, 5, memoryValues))
	for _, kind := range []string{"cpu", "memory", "io"} {
		v, status := readPSI("/proc/pressure/" + kind)
		objects = append(objects, observation("psi:"+kind, boot, status, now, 5, v))
	}
	ioCounters, err := disk.IOCountersWithContext(ctx)
	diskNames, _ := ReadDiskCounters(ctx)
	diskCount := 0
	for name, id := range diskNames {
		if diskCount >= 24 {
			break
		}
		diskCount++
		v, ok := ioCounters[name]
		status = "ok"
		metrics := map[string]*float64{"read_iops": nil, "write_iops": nil, "read_wait_ms": nil, "write_wait_ms": nil}
		if err != nil || !ok {
			status = "unreadable"
		} else {
			d := c.rates("disk:"+name, boot+":"+id.Identity, now, float64(v.ReadCount), float64(v.WriteCount), float64(v.ReadTime), float64(v.WriteTime))
			metrics["read_iops"] = d[0]
			metrics["write_iops"] = d[1]
			if d[0] != nil && *d[0] > 0 {
				metrics["read_wait_ms"] = number(*d[2] / *d[0])
			}
			if d[1] != nil && *d[1] > 0 {
				metrics["write_wait_ms"] = number(*d[3] / *d[1])
			}
		}
		objects = append(objects, observation("disk:"+name, boot+":"+id.Identity, status, now, 5, metrics))
	}
	if now-c.lastSlow >= 30 || c.lastSlow == 0 {
		c.slow = c.collectFilesystems(ctx, now)
		c.slow = append(c.slow, collectServices(ctx, cfg.Services, now)...)
		c.lastSlow = now
	}
	// Do not carry old objects into a different minute: every object retains its own sample time.
	for _, o := range c.slow {
		if int64(o.ObservedAt)/60 == int64(now)/60 {
			objects = append(objects, o)
		}
	}
	if now-c.lastNetwork >= 15 || c.lastNetwork == 0 {
		c.network = c.collectNetwork(ctx, now, boot)
		c.lastNetwork = now
	}
	for _, o := range c.network {
		if int64(o.ObservedAt)/60 == int64(now)/60 {
			objects = append(objects, o)
		}
	}
	return objects
}
func readPSI(path string) (map[string]*float64, string) {
	values := map[string]*float64{}
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return values, "unsupported"
	}
	if err != nil {
		return values, "unreadable"
	}
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		for _, f := range fields[1:] {
			key, v, ok := strings.Cut(f, "=")
			if !ok {
				continue
			}
			n, err := strconv.ParseFloat(v, 64)
			if err == nil && n >= 0 {
				if key == "total" {
					key = "total_us"
				}
				values[fields[0]+"_"+key] = number(n)
			}
		}
	}
	if len(values) == 0 {
		return values, "unreadable"
	}
	return values, "ok"
}
func (c *DiagnosticCollector) collectFilesystems(ctx context.Context, now float64) []TelemetryObject {
	result := []TelemetryObject{}
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		return []TelemetryObject{observation("filesystem", BootID(), "unreadable", now, 30, map[string]*float64{})}
	}
	for _, p := range partitions {
		if !PersistentPartition(p.Fstype, p.Mountpoint) || len(p.Mountpoint) > 240 {
			continue
		}
		var st syscall.Stat_t
		identity := p.Device + ":" + p.Fstype
		if syscall.Stat(p.Mountpoint, &st) == nil {
			identity = fmt.Sprintf("%s:%d", identity, st.Dev)
			var fs syscall.Statfs_t
			if syscall.Statfs(p.Mountpoint, &fs) == nil {
				identity = fmt.Sprintf("%s:%v", identity, fs.Fsid)
			}
		}
		values := map[string]*float64{"total_bytes": nil, "free_bytes": nil, "used_bytes": nil, "used_percent": nil, "inode_total": nil, "inode_used": nil, "inode_free": nil, "inode_percent": nil}
		status := "ok"
		if v, e := disk.UsageWithContext(ctx, p.Mountpoint); e == nil {
			values["total_bytes"] = number(float64(v.Total))
			values["free_bytes"] = number(float64(v.Free))
			values["used_bytes"] = number(float64(v.Used))
			values["used_percent"] = number(v.UsedPercent)
			values["inode_total"] = number(float64(v.InodesTotal))
			values["inode_used"] = number(float64(v.InodesUsed))
			values["inode_free"] = number(float64(v.InodesFree))
			if v.InodesTotal > 0 {
				values["inode_percent"] = number(v.InodesUsedPercent)
			}
		} else {
			status = "unreadable"
		}
		result = append(result, observation("fs:"+p.Mountpoint, identity, status, now, 30, values))
		if len(result) >= 64 {
			break
		}
	}
	return result
}
func (c *DiagnosticCollector) collectNetwork(ctx context.Context, now float64, boot string) []TelemetryObject {
	result := []TelemetryObject{}
	status := "ok"
	values := map[string]*float64{"established": nil, "listen": nil, "time_wait": nil, "retransmits_per_second": nil}
	if connections, err := gnet.ConnectionsWithContext(ctx, "tcp"); err == nil {
		counts := map[string]float64{}
		for _, v := range connections {
			counts[v.Status]++
		}
		values["established"] = number(counts["ESTABLISHED"])
		values["listen"] = number(counts["LISTEN"])
		values["time_wait"] = number(counts["TIME_WAIT"])
		for _, state := range []string{"SYN_SENT", "SYN_RECV", "FIN_WAIT1", "FIN_WAIT2", "CLOSE_WAIT", "LAST_ACK", "CLOSING", "CLOSED"} {
			values[strings.ToLower(state)] = number(counts[state])
		}
	} else {
		status = "unreadable"
	}
	if proto, err := gnet.ProtoCountersWithContext(ctx, []string{"tcp"}); err == nil && len(proto) > 0 {
		if v, ok := proto[0].Stats["RetransSegs"]; ok {
			values["retransmits_per_second"] = c.rates("tcp", boot, now, float64(v))[0]
		}
	}
	result = append(result, observation("tcp", boot, status, now, 15, values))
	if counters, err := gnet.IOCountersWithContext(ctx, true); err == nil {
		for _, v := range counters {
			if !ifacePattern.MatchString(v.Name) {
				continue
			}
			rates := c.rates("net:"+v.Name, boot, now, float64(v.PacketsRecv), float64(v.PacketsSent), float64(v.Errin), float64(v.Errout), float64(v.Dropin), float64(v.Dropout))
			metrics := map[string]*float64{}
			for i, k := range []string{"rx_packets_per_second", "tx_packets_per_second", "rx_errors_per_second", "tx_errors_per_second", "rx_drops_per_second", "tx_drops_per_second"} {
				metrics[k] = rates[i]
			}
			result = append(result, observation("net:"+v.Name, boot+":"+v.Name, "ok", now, 15, metrics))
			if len(result) >= 20 {
				break
			}
		}
	}
	return result
}
func (r *Runner) RunDiagnostics(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	collector := &DiagnosticCollector{}
	var lastVersion int64 = -1
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			r.mu.RLock()
			cfg := r.config
			active := r.telemetryCapabilities.Diagnostics == 1
			r.mu.RUnlock()
			if !active || cfg.Extensions.Diagnostics == nil || !cfg.Extensions.Diagnostics.Enabled {
				continue
			}
			if cfg.AppliedExtensions != lastVersion {
				collector = &DiagnosticCollector{}
				lastVersion = cfg.AppliedExtensions
			}
			work, cancel := context.WithTimeout(ctx, 20*time.Second)
			objects := collector.Collect(work, *cfg.Extensions.Diagnostics, float64(now.UnixMilli())/1000)
			cancel()
			if err := r.Store.SaveTelemetry("diagnostics", now, cfg.AppliedExtensions, objects); err != nil {
				log.Print("诊断分钟记录保存失败")
				continue
			}
		}
	}
}
