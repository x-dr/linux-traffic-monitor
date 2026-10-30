import test from 'node:test';
import assert from 'node:assert/strict';
import { monthBounds } from '../src/periods.js';
import { defaultConfig } from '../../../packages/contracts/src/index.js';

test('calendar month, custom time and year rollover use local boundaries', () => {
  const cfg = { ...defaultConfig, month_start_day: 15, month_start_time: '08:30' };
  const before = monthBounds(Date.parse('2026-10-15T00:29:00Z') / 1000, cfg);
  assert.equal(before[1].toISO(), '2026-09-15T08:30:00.000+08:00');
  assert.equal(before[2].toISO(), '2026-10-15T08:30:00.000+08:00');
  const exact = monthBounds(Date.parse('2026-10-15T00:30:00Z') / 1000, cfg);
  assert.equal(exact[1].month, 10);
  const year = monthBounds(Date.parse('2027-01-01T00:00:00Z') / 1000, defaultConfig);
  assert.equal(year[0].year, 2026); assert.equal(year[0].month, 12); assert.equal(year[2].month, 2);
});

test('short months clamp independently and leap years retain Feb 29', () => {
  const cfg = { ...defaultConfig, month_start_day: 31, month_start_time: '09:00' };
  const bounds = monthBounds(Date.parse('2027-03-01T00:00:00Z') / 1000, cfg);
  assert.equal(bounds[1].day, 28); assert.equal(bounds[2].day, 31);
  const leap = monthBounds(Date.parse('2028-03-01T00:00:00Z') / 1000, cfg);
  assert.equal(leap[1].day, 29);
});

test('DST gaps advance and repeated hours choose the earliest instant', () => {
  const gap = monthBounds(Date.parse('2026-03-09T12:00:00Z') / 1000, { ...defaultConfig, timezone: 'America/New_York', month_start_day: 8, month_start_time: '02:30' });
  assert.equal(gap[1].toUTC().toISO(), '2026-03-08T07:30:00.000Z');
  const repeated = monthBounds(Date.parse('2026-11-02T12:00:00Z') / 1000, { ...defaultConfig, timezone: 'America/New_York', month_start_day: 1, month_start_time: '01:30' });
  assert.equal(repeated[1].toUTC().toISO(), '2026-11-01T05:30:00.000Z');
});
