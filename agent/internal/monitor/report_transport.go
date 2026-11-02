package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func (r *Runner) Send(ctx context.Context) error {
	if err := r.Store.PruneProbes(time.Now()); err != nil {
		return errors.New("探测保留任务失败")
	}
	report, err := r.Store.Batch()
	if err != nil {
		return errors.New("待同步记录读取失败")
	}
	r.mu.RLock()
	cfg := r.config
	caps := r.serverCapabilities
	report.Snapshot = r.snapshot
	report.AppliedVersion = cfg.AppliedVersion
	report.ConfigError = r.configError
	extensionError := r.extensionsError
	r.mu.RUnlock()
	if cfg.AppliedVersion == 0 {
		report.ImportedConfig = &cfg.Settings
	}
	if caps != nil && caps.Probes == 1 {
		report.Capabilities = &Capabilities{Probes: 1}
		report.AppliedExtensions = &cfg.AppliedExtensions
		report.ExtensionsError = extensionError
		probes, err := r.Store.probeBatch()
		if err != nil {
			return errors.New("探测同步读取失败")
		}
		report.Probes = &probes
		report.ProbeDrops, err = r.Store.ProbeDropSummary()
		if err != nil {
			return err
		}
	}
	reply, status, err := r.postReport(ctx, cfg, &report)
	if err != nil && report.Capabilities != nil && (status == 400 || status == 422) {
		// One base-only re-negotiation. Rejected extension batches remain unacknowledged.
		report.Capabilities = nil
		report.Probes = nil
		report.AppliedExtensions = nil
		report.ExtensionsError = nil
		report.ProbeDrops = nil
		reply, _, err = r.postReport(ctx, cfg, &report)
	}
	if err != nil {
		r.mu.Lock()
		r.serverCapabilities = nil
		r.mu.Unlock()
		return err
	}
	if reply.ConfigVersion < 1 || reply.ReceivedAt < 0 || (reply.ServerCapabilities != nil && reply.ServerCapabilities.Probes != 0 && reply.ServerCapabilities.Probes != 1) {
		return errors.New("中心响应格式无效")
	}
	if err = r.Store.Acknowledge(reply.Ack, report); err != nil {
		return err
	}
	// A valid response may explicitly remove capabilities; a network failure does not.
	supported := "0"
	if reply.ServerCapabilities != nil && reply.ServerCapabilities.Probes == 1 {
		supported = "1"
	}
	if _, err = r.Store.DB.Exec("UPDATE meta SET v=? WHERE k='server_probes_supported'", supported); err != nil {
		return errors.New("中心能力持久化失败")
	}
	r.mu.Lock()
	r.serverCapabilities = reply.ServerCapabilities
	r.probesActive = reply.ServerCapabilities != nil && reply.ServerCapabilities.Probes == 1
	r.mu.Unlock()
	if reply.ConfigVersion > cfg.AppliedVersion {
		candidate := cfg
		err = reply.Config.Validate()
		if err == nil {
			candidate.Settings = reply.Config
			candidate.AppliedVersion = reply.ConfigVersion
			err = SaveConfig(r.ConfigPath, candidate)
		}
		r.mu.Lock()
		if err != nil {
			message := "配置校验或持久化失败，继续使用原配置"
			r.configError = &message
		} else {
			cfg = candidate
			r.config = cfg
			r.configError = nil
		}
		r.mu.Unlock()
	}
	if reply.ServerCapabilities != nil && reply.ServerCapabilities.Probes == 1 && reply.ExtensionsVersion > cfg.AppliedExtensions {
		candidate := cfg
		message := "invalid_config"
		if reply.ExtensionsConfig == nil {
			err = errors.New(message)
		} else {
			err = reply.ExtensionsConfig.Validate()
		}
		if err == nil {
			candidate.Extensions = *reply.ExtensionsConfig
			candidate.AppliedExtensions = reply.ExtensionsVersion
			err = SaveConfig(r.ConfigPath, candidate)
			message = "persist_failed"
		}
		r.mu.Lock()
		if err != nil {
			r.extensionsError = &message
		} else {
			r.config = candidate
			r.extensionsError = nil
		}
		r.mu.Unlock()
	}
	return nil
}
func (r *Runner) postReport(ctx context.Context, cfg Config, report *Report) (Reply, int, error) {
	var reply Reply
	body, err := budgetReport(report, 1536*1024)
	if err != nil {
		return reply, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.ServerURL, "/")+"/api/v1/agent/report", bytes.NewReader(body))
	if err != nil {
		return reply, 0, errors.New("中心地址无效")
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := r.Client.Do(req)
	if err != nil {
		return reply, 0, errors.New("中心连接失败，数据保留在本地等待重试")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return reply, response.StatusCode, fmt.Errorf("中心拒绝上报（HTTP %d），本地同步进度保持不变", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return reply, 200, errors.New("中心响应过大或不完整")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields["ack"] == nil || fields["config"] == nil || fields["config_version"] == nil || fields["received_at"] == nil || json.Unmarshal(raw, &reply) != nil {
		return reply, 200, errors.New("中心响应格式无效")
	}
	return reply, 200, nil
}

// Allocate bytes in stream order, preserving each stream's oldest pending rows.
func budgetReport(report *Report, budget int) ([]byte, error) {
	traffic, resources, totals, disks := report.Traffic, report.Resources, report.Totals, report.DiskIO
	var probes []ProbeResult
	if report.Probes != nil {
		probes = *report.Probes
		empty := []ProbeResult{}
		report.Probes = &empty
	}
	report.Traffic = []TrafficMinute{}
	report.Resources = []ResourceMinute{}
	report.Totals = []Total{}
	report.DiskIO = nil
	base, err := json.Marshal(report)
	if err != nil {
		return nil, errors.New("上报编码失败")
	}
	remaining := budget - len(base)
	if len(disks) > 0 {
		remaining -= len(`,"disk_io":[]`)
	}
	lengths := []int{len(traffic), len(resources), len(totals), len(disks), len(probes)}
	items := make([][][]byte, 5)
	for stream, count := range lengths {
		for i := 0; i < count; i++ {
			var value any
			switch stream {
			case 0:
				value = traffic[i]
			case 1:
				value = resources[i]
			case 2:
				value = totals[i]
			case 3:
				value = disks[i]
			case 4:
				value = probes[i]
			}
			body, e := json.Marshal(value)
			if e != nil {
				return nil, errors.New("上报编码失败")
			}
			items[stream] = append(items[stream], body)
		}
	}
	// Reserve one record from every non-empty stream before assigning spare bytes.
	minimum := 0
	for _, stream := range items {
		if len(stream) > 0 {
			minimum += len(stream[0])
		}
	}
	if remaining < minimum {
		return nil, errors.New("快照及最小同步批次超过总字节预算")
	}
	positions := make([]int, 5)
	for {
		progress := false
		for stream, values := range items {
			position := positions[stream]
			if position >= len(values) {
				continue
			}
			size := len(values[position])
			if position > 0 {
				size++
			}
			if size > remaining {
				continue
			}
			remaining -= size
			positions[stream]++
			progress = true
		}
		if !progress {
			break
		}
	}
	report.Traffic = traffic[:positions[0]]
	report.Resources = resources[:positions[1]]
	report.Totals = totals[:positions[2]]
	report.DiskIO = disks[:positions[3]]
	if report.Probes != nil {
		selected := probes[:positions[4]]
		if selected == nil {
			selected = []ProbeResult{}
		}
		report.Probes = &selected
	}
	body, err := json.Marshal(report)
	if err != nil || len(body) > budget {
		return nil, errors.New("上报总字节预算不足")
	}
	return body, nil
}
