package monitor

import (
	"context"
	"math"
	"time"
)

type probeJob struct {
	config     ProbeAssignment
	scheduled  float64
	allow      []string
	generation int64
}

// This scheduler owns its deadlines; slow targets never occupy the collector or sender.
func (r *Runner) RunProbes(ctx context.Context) {
	jobs := make(chan probeJob, 2)
	done := make(chan struct{}, 2)
	for i := 0; i < 2; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for {
				select {
				case <-ctx.Done():
					return
				case job := <-jobs:
					r.mu.RLock()
					current := r.probesActive && job.generation == r.config.AppliedExtensions
					r.mu.RUnlock()
					if !current {
						continue
					}
					result := (ProbeExecutor{AllowCIDRs: job.allow}).Execute(ctx, job.config, job.scheduled)
					if ctx.Err() == nil {
						if err := r.Store.SaveProbe(result); err != nil {
							r.setProbeStoreError()
						}
					}
				}
			}
		}()
	}
	defer func() { <-done; <-done }()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	deadlines := map[string]float64{}
	previous := map[string]int64{}
	for {
		select {
		case <-ctx.Done():
			return
		case tick := <-ticker.C:
			r.mu.RLock()
			cfg := r.config
			active := r.probesActive
			r.mu.RUnlock()
			if !active {
				clear(deadlines)
				clear(previous)
				continue
			}
			present := map[string]bool{}
			now := seconds(tick)
			for _, p := range cfg.Extensions.Probes {
				present[p.ID] = true
				if previous[p.ID] != p.Version {
					deadlines[p.ID] = nextProbeSlot(p, now)
					previous[p.ID] = p.Version
				}
				scheduled := deadlines[p.ID]
				if now < scheduled {
					continue
				}
				// Advance directly to the next future slot; never replay missed requests.
				deadlines[p.ID] = nextProbeSlot(p, now+0.001)
				job := probeJob{p, scheduled, cfg.ProbeAllowCIDRs, cfg.AppliedExtensions}
				if now-scheduled > 1 {
					continue
				}
				select {
				case jobs <- job:
				default:
					result := ProbeResult{SampleID: newSampleID(), TaskID: p.ID, TaskVersion: p.Version, ScheduledAt: scheduled, StartedAt: now, CompletedAt: now, Status: "skipped"}
					if err := r.Store.SaveProbe(result); err != nil {
						r.setProbeStoreError()
					}
				}
			}
			for id := range deadlines {
				if !present[id] {
					delete(deadlines, id)
					delete(previous, id)
				}
			}
		}
	}
}
func nextProbeSlot(p ProbeAssignment, now float64) float64 {
	return p.StartAt + math.Max(0, math.Ceil((now-p.StartAt)/float64(p.Interval)))*float64(p.Interval)
}
func (r *Runner) setProbeStoreError() {
	r.mu.Lock()
	defer r.mu.Unlock()
	message := "persist_failed"
	r.extensionsError = &message
}
