package monitor

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/shirou/gopsutil/v4/disk"
)

type DiskCounters struct {
	Read, Write int64
	Identity    string
}

var devicePattern = regexp.MustCompile(`^[a-zA-Z0-9_.:-]{1,128}$`)

func WholeIODisk(name string, partition bool, slaves int) bool {
	if !devicePattern.MatchString(name) || partition || slaves > 0 {
		return false
	}
	for _, prefix := range []string{"loop", "ram", "zram", "sr", "fd"} {
		if strings.HasPrefix(name, prefix) {
			return false
		}
	}
	return true
}

func ReadDiskCounters(ctx context.Context) (map[string]DiskCounters, error) {
	entries, err := os.ReadDir("/sys/class/block")
	if err != nil {
		return nil, err
	}
	names := []string{}
	identities := map[string]string{}
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join("/sys/class/block", name)
		_, partitionErr := os.Stat(filepath.Join(path, "partition"))
		slaves, slaveErr := os.ReadDir(filepath.Join(path, "slaves"))
		if slaveErr != nil || !WholeIODisk(name, partitionErr == nil, len(slaves)) {
			continue
		}
		body, identityErr := os.ReadFile(filepath.Join(path, "dev"))
		if identityErr != nil {
			continue
		}
		identities[name] = strings.TrimSpace(string(body))
		names = append(names, name)
	}
	readings := map[string]DiskCounters{}
	if len(names) == 0 {
		return readings, nil
	}
	counters, err := disk.IOCountersWithContext(ctx, names...)
	if err != nil {
		return readings, err
	}
	for _, name := range names {
		value, ok := counters[name]
		if !ok || value.ReadBytes > math.MaxInt64 || value.WriteBytes > math.MaxInt64 {
			err = errors.New("部分磁盘读写计数器不可读或超出范围")
			continue
		}
		readings[name] = DiskCounters{Read: int64(value.ReadBytes), Write: int64(value.WriteBytes), Identity: identities[name]}
	}
	return readings, err
}
