import { DateTime, IANAZone } from 'luxon';
import type { MonitorConfig } from '../../../packages/contracts/src/index.js';

export function validateTimezone(config: MonitorConfig) {
  if (!IANAZone.isValidZone(config.timezone)) throw Object.assign(new Error('无效的 IANA 时区'), { statusCode: 400 });
  return config;
}

export function monthBounds(now: number, cfg: MonitorConfig) {
  const local = DateTime.fromSeconds(now, { zone: cfg.timezone });
  if (!local.isValid) throw new Error('统计时区不可用');
  const [hour, minute] = cfg.month_start_time.split(':').map(Number);
  const anchor = (month: DateTime) => {
    const value = month.startOf('month').set({ day: Math.min(cfg.month_start_day, month.daysInMonth!), hour, minute });
    // Choose the earliest instant when a local hour repeats during a DST transition.
    return value.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
  };
  const thisMonth = anchor(local);
  const base = now < thisMonth.toSeconds() ? local.minus({ months: 1 }) : local;
  return [anchor(base.minus({ months: 1 })), anchor(base), anchor(base.plus({ months: 1 }))] as const;
}
