import { Alert, Progress } from 'antd';
import type { QuotaView } from '@traffic/contracts';
import { date } from './format';

const directions = { tx: '上传', rx: '下载', sum: '上传 + 下载', max: '上传与下载的较大值' };
function amount(value: string | null, unit: QuotaView['policy']['input_unit']) {
  if (value === null) return '—';
  const divisors = { GB: 1000n ** 3n, TB: 1000n ** 4n, GiB: 1024n ** 3n, TiB: 1024n ** 4n };
  const n = BigInt(value), divisor = divisors[unit];
  return `${n / divisor}.${String(n % divisor * 100n / divisor).padStart(2, '0')} ${unit}`;
}
export default function QuotaSummary({ quota }: { quota: QuotaView }) {
  const f = quota.forecast;
  return <div className="quota-summary">
    <div className="monitor-card-heading"><h3>计费流量 · {directions[quota.policy.direction]}</h3><strong>{quota.percent.toFixed(2)}%</strong></div>
    <p className="quota-period">{quota.start} → {quota.end}</p>
    <p>计费网卡：{quota.policy.interfaces.join('、')} · 策略 v{quota.policy.version}{!quota.policy.enabled && '（未启用）'}</p>
    <Progress percent={Math.min(100, quota.percent)} status={quota.exceeded ? 'exception' : 'normal'} showInfo={false} />
    <div className="quota-facts"><div><span>已用 / 额度</span><strong>{amount(quota.billed_bytes, quota.policy.input_unit)} / {amount(quota.policy.quota_bytes, quota.policy.input_unit)}</strong><small>{quota.billed_bytes} / {quota.policy.quota_bytes} 字节</small></div><div><span>剩余额度</span><strong>{quota.exceeded ? '已超额' : amount(quota.remaining_bytes, quota.policy.input_unit)}</strong></div><div><span>周期剩余</span><strong>{(quota.remaining_seconds / 86400).toFixed(1)} 天</strong></div></div>
    {quota.missing_interfaces.length > 0 && <Alert type="warning" showIcon title="计费记录可能存在缺口" description={`未持续采集或周期记录不足：${quota.missing_interfaces.join('、')}。不会补零。`} />}
    {f.available ? <div className="forecast"><h4>用量预测</h4><p>预计周期末：{amount(f.projected_bytes, quota.policy.input_unit)} · 预计耗尽：{quota.exceeded ? '已超额' : f.exhaustion_at ? date(f.exhaustion_at) : '无法估算'}</p><p className="muted">{f.window_start} → {f.window_end} · {f.days} 个有效自然日 · 最低分钟覆盖 {(f.coverage * 100).toFixed(1)}% · {f.reason}</p></div> : <p className="muted">预测暂不可用：{f.reason}；有效自然日 {f.days} 天。</p>}
    <p className="muted">{quota.basis}</p>
  </div>;
}
