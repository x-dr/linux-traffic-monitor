package monitor

import (
	"context"
	"fmt"
	"runtime"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
)

func CollectResources(ctx context.Context, version string) Snapshot {
	s := Snapshot{Arch: runtime.GOARCH, AgentVersion: version, CPUCores: runtime.NumCPU(), MemoryTotal: "0", MemoryAvailable: "0", SwapTotal: "0", Interfaces: AvailableInterfaces(), SelectedInterfaces: []string{}, ReadableInterfaces: []string{}, Disks: []Disk{}}
	failures := []string{}
	if values, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(values) > 0 {
		s.CPUPercent = number(values[0])
	} else {
		failures = append(failures, "CPU")
	}
	if value, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		s.MemoryTotal = strconv.FormatUint(value.Total, 10)
		s.MemoryAvailable = strconv.FormatUint(value.Available, 10)
		if value.Total > 0 {
			s.MemoryPercent = number(float64(value.Total-value.Available) / float64(value.Total) * 100)
		}
	} else {
		failures = append(failures, "内存")
	}
	if value, err := mem.SwapMemoryWithContext(ctx); err == nil {
		s.SwapTotal = strconv.FormatUint(value.Total, 10)
		s.SwapPercent = number(value.UsedPercent)
	} else {
		failures = append(failures, "Swap")
	}
	if value, err := load.AvgWithContext(ctx); err == nil {
		s.Load = [3]*float64{number(value.Load1), number(value.Load5), number(value.Load15)}
	} else {
		failures = append(failures, "负载")
	}
	if value, err := host.InfoWithContext(ctx); err == nil {
		s.Hostname = value.Hostname
		s.OS = strings.TrimSpace(value.Platform + " " + value.PlatformVersion)
		s.Kernel = value.KernelVersion
		s.Uptime = float64(value.Uptime)
	} else {
		failures = append(failures, "系统信息")
	}
	partitions, err := disk.PartitionsWithContext(ctx, false)
	if err != nil {
		failures = append(failures, "磁盘")
	}
	seen := map[string]bool{}
	for _, p := range partitions {
		if !PersistentPartition(p.Fstype, p.Mountpoint) || seen[p.Device] {
			continue
		}
		value, err := disk.UsageWithContext(ctx, p.Mountpoint)
		if err != nil {
			failures = append(failures, "磁盘 "+p.Mountpoint)
			continue
		}
		seen[p.Device] = true
		s.Disks = append(s.Disks, Disk{Mount: p.Mountpoint, FS: p.Fstype, Total: strconv.FormatUint(value.Total, 10), Used: strconv.FormatUint(value.Used, 10), Free: strconv.FormatUint(value.Free, 10), Percent: number(value.UsedPercent)})
	}
	if len(failures) > 0 {
		message := fmt.Sprintf("部分资源指标不可读: %s", strings.Join(failures, ", "))
		s.Error = &message
	}
	return s
}

func PersistentPartition(fs, mount string) bool {
	if strings.HasPrefix(mount, "/var/lib/docker/") || strings.HasPrefix(mount, "/var/lib/containers/") || strings.HasPrefix(mount, "/snap/") {
		return false
	}
	switch fs {
	case "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "overlay", "aufs", "squashfs", "cgroup", "cgroup2", "securityfs", "debugfs", "tracefs", "fusectl", "mqueue", "hugetlbfs", "nsfs", "ramfs", "autofs":
		return false
	}
	return true
}
