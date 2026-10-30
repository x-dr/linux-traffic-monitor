package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const Version = "1.1.0"

type Runner struct {
	Store       *Store
	Client      *http.Client
	ConfigPath  string
	mu          sync.RWMutex
	config      Config
	snapshot    Snapshot
	configError *string
}

func NewRunner(store *Store, cfg Config, path string) *Runner {
	return &Runner{Store: store, ConfigPath: path, config: cfg, Client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return errors.New("中心地址发生重定向，请配置最终 HTTPS 地址")
	}}}
}
func (r *Runner) Collect(ctx context.Context, resources bool) error {
	r.mu.RLock()
	cfg := r.config
	previous := r.snapshot
	r.mu.RUnlock()
	if resources {
		previous = CollectResources(ctx, Version)
	}
	var diskReadings map[string]DiskCounters
	var diskReadError error
	if resources {
		diskReadings, diskReadError = ReadDiskCounters(ctx)
	}
	now := time.Now()
	selected := ResolveInterfaces(cfg.Settings)
	readings := map[string]Counters{}
	for _, name := range selected {
		if value, err := ReadCounters(name); err == nil {
			readings[name] = value
		}
	}
	network, err := r.Store.SampleNetwork(now, BootID(), selected, readings)
	if err != nil {
		return errors.New("本地流量数据库写入失败")
	}
	previous.ObservedAt = float64(now.UnixMilli()) / 1000
	previous.RxBPS = network.RX
	previous.TxBPS = network.TX
	previous.SelectedInterfaces = network.Selected
	previous.ReadableInterfaces = network.Readable
	previous.Interfaces = AvailableInterfaces()
	if network.Error != nil {
		previous.Error = network.Error
	}
	if resources {
		previous.DiskIOSupported = true
		previous.DiskIO, err = r.Store.SampleDisks(now, BootID(), diskReadings)
		if err != nil {
			return errors.New("本地磁盘读写数据库写入失败")
		}
		if diskReadError != nil {
			message := "磁盘读写指标不可读"
			if previous.Error != nil {
				message = *previous.Error + "; " + message
			}
			previous.Error = &message
		}
		seq, err := r.Store.SaveResource(now, map[string]*float64{"cpu_percent": previous.CPUPercent, "memory_percent": previous.MemoryPercent, "swap_percent": previous.SwapPercent, "load1": previous.Load[0], "rx_bps": number(network.RX), "tx_bps": number(network.TX)})
		if err != nil {
			return errors.New("本地资源数据库写入失败")
		}
		previous.Revision = seq
	} else {
		previous.Revision = max(previous.Revision, network.Revision)
	}
	r.mu.Lock()
	r.snapshot = previous
	r.mu.Unlock()
	return nil
}
func (r *Runner) Send(ctx context.Context) error {
	report, err := r.Store.Batch()
	if err != nil {
		return errors.New("待同步记录读取失败")
	}
	r.mu.RLock()
	cfg := r.config
	report.Snapshot = r.snapshot
	report.AppliedVersion = cfg.AppliedVersion
	report.ConfigError = r.configError
	r.mu.RUnlock()
	if cfg.AppliedVersion == 0 {
		report.ImportedConfig = &cfg.Settings
	}
	body, err := json.Marshal(report)
	if err != nil {
		return errors.New("上报编码失败")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(cfg.ServerURL, "/")+"/api/v1/agent/report", bytes.NewReader(body))
	if err != nil {
		return errors.New("中心地址无效")
	}
	request.Header.Set("Authorization", "Bearer "+cfg.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := r.Client.Do(request)
	if err != nil {
		return errors.New("中心连接失败，数据保留在本地等待重试")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return fmt.Errorf("中心拒绝上报（HTTP %d），本地同步进度保持不变", response.StatusCode)
	}
	var reply Reply
	if err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&reply); err != nil {
		return errors.New("中心响应格式无效")
	}
	if err = r.Store.Acknowledge(reply.Ack, report); err != nil {
		return err
	}
	if reply.ConfigVersion > cfg.AppliedVersion {
		if err = reply.Config.Validate(); err == nil {
			cfg.Settings = reply.Config
			cfg.AppliedVersion = reply.ConfigVersion
			err = SaveConfig(r.ConfigPath, cfg)
		}
		r.mu.Lock()
		if err != nil {
			message := "配置校验或持久化失败，继续使用原配置"
			r.configError = &message
		} else {
			r.config = cfg
			r.configError = nil
		}
		r.mu.Unlock()
	}
	return nil
}

func Run(ctx context.Context, cfg Config, path string, once bool) error {
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(cfg.DataDir, "agent.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("此数据目录已有 Agent 运行")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	store, err := OpenStore(filepath.Join(cfg.DataDir, "traffic.db"))
	if err != nil {
		return err
	}
	defer store.DB.Close()
	runner := NewRunner(store, cfg, path)
	if err = runner.Collect(ctx, true); err != nil {
		return err
	}
	if once {
		return runner.Send(ctx)
	}
	var worker sync.WaitGroup
	worker.Add(1)
	go func() {
		defer worker.Done()
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			if err := runner.Send(ctx); err != nil && ctx.Err() == nil {
				log.Print(err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	ticks := 0
	for {
		select {
		case <-ctx.Done():
			worker.Wait()
			return nil
		case <-ticker.C:
			ticks++
			if err := runner.Collect(ctx, ticks%5 == 0); err != nil {
				log.Print(err)
			}
		}
	}
}
