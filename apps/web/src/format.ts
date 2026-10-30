export function bytes(value: string | number | bigint | null | undefined, speed = false) {
  if (value === null || value === undefined) return '—';
  let n = Number(value); const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('en-US', { maximumFractionDigits: i ? 2 : 0 })} ${units[i]}${speed ? '/s' : ''}`;
}
export function percent(value: number | null | undefined) { return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`; }
export function date(value: number | string | null | undefined) { return value == null ? '尚未上报' : new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString('zh-CN', { hour12: false }); }
export function uptime(value: number | undefined) {
  if (value === undefined) return '—';
  const days = Math.floor(value / 86400), hours = Math.floor(value % 86400 / 3600);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor(value % 3600 / 60)} 分钟`;
}
