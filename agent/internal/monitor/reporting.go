package monitor

import (
	"context"
	"log"
	"time"
)

func validReportInterval(seconds int) bool {
	switch seconds {
	case 1, 3, 5, 10, 15:
		return true
	}
	return false
}

func (r *Runner) reportInterval() time.Duration {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.telemetryCapabilities.Reporting == 1 {
		if seconds := r.config.Extensions.ReportInterval; seconds != nil && validReportInterval(*seconds) {
			return time.Duration(*seconds) * time.Second
		}
	}
	return 5 * time.Second
}

func (r *Runner) runReports(ctx context.Context) {
	for ctx.Err() == nil {
		started := time.Now()
		if err := r.Send(ctx); err != nil && ctx.Err() == nil {
			log.Print(err)
		}
		interval := r.reportInterval()
		delay := interval - time.Since(started)
		if delay <= 0 {
			// A slow request never causes a burst of overdue reports.
			delay = interval
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
