package monitor

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"time"
)

func collectServices(ctx context.Context, services []ServiceConfig, now float64) []TelemetryObject {
	result := []TelemetryObject{}
	for _, service := range services {
		if !serviceNamePattern.MatchString(service.Name) {
			continue
		}
		work, cancel := context.WithTimeout(ctx, 2*time.Second)
		command := "systemctl"
		args := []string{"show", "--property=ActiveState", "--value", "--", service.Name}
		if service.Manager == "openrc" {
			command = "rc-service"
			args = []string{service.Name, "status"}
		}
		cmd := exec.CommandContext(work, command, args...)
		body, err := cmd.Output()
		cancel()
		status := "ok"
		var running *float64
		if service.Manager == "systemd" {
			if err == nil {
				switch strings.TrimSpace(string(body)) {
				case "active", "reloading":
					running = number(1)
				case "inactive", "failed", "activating", "deactivating":
					running = number(0)
				default:
					status = "unsupported"
				}
			} else {
				status = "unreadable"
			}
		} else {
			if err == nil {
				running = number(1)
			} else {
				var exit *exec.ExitError
				if errors.As(err, &exit) && exit.ExitCode() == 3 {
					running = number(0)
				} else {
					status = "unreadable"
				}
			}
		}
		if errors.Is(err, exec.ErrNotFound) {
			status = "unsupported"
		}
		result = append(result, observation("service:"+service.Manager+":"+service.Name, service.Manager+":"+service.Name, status, now, 30, map[string]*float64{"running": running}))
	}
	return result
}
