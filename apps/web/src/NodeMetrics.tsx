import type { CSSProperties } from 'react';
import { ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { NodeView } from '@traffic/contracts';
import { bytes, date, percent, uptime } from './format';
import { statuses } from './components';

export function TrafficPair({ rx, tx, speed = false }: {
  rx: string | number | null | undefined;
  tx: string | number | null | undefined;
  speed?: boolean;
}) {
  return <span className={`traffic-pair${speed ? ' traffic-speed' : ''}`}>
    <span title="下载"><ArrowDownOutlined aria-label="下载" />{bytes(rx, speed)}</span>
    <span className="traffic-divider" aria-hidden="true">/</span>
    <span title="上传"><ArrowUpOutlined aria-label="上传" />{bytes(tx, speed)}</span>
  </span>;
}

export function ResourceBar({ node, value, label }: {
  node: NodeView; value: number | null | undefined; label: string;
}) {
  if (node.status !== 'online' && node.status !== 'stale') {
    return <span className={`resource-unavailable resource-${node.status}`}>{statuses[node.status].label}</span>;
  }
  if (value == null || !Number.isFinite(value)) return <span className="resource-unavailable">—</span>;
  const level = value >= 90 ? 'danger' : value >= 75 ? 'warning' : 'normal';
  const stale = node.status === 'stale';
  return <span className={`resource-bar resource-${level}${stale ? ' resource-stale' : ''}`}
    role="meter" aria-label={`${label}${stale ? '（最后采样）' : ''}`} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.min(100, Math.max(0, value))} aria-valuetext={percent(value)}
    title={`${label} ${percent(value)}${stale ? ' · 数据陈旧，显示最后采样' : ''}`}
    style={{ '--resource-fill': `${Math.min(100, Math.max(0, value))}%` } as CSSProperties}>
    <span>{Math.round(value)}%</span>
  </span>;
}

function memoryUsed(total: string, available: string) {
  const used = BigInt(total) - BigInt(available);
  return bytes(used > 0n ? used : 0n);
}

export function NodePreview({ node }: { node: NodeView }) {
  const snapshot = node.snapshot;
  const disk = snapshot?.disks.find(item => item.mount === '/');
  return <div className="node-preview" aria-label={`${node.name} 运行详情`}>
    <div className="node-preview-header">
      <span><strong>{node.name}</strong><span className="muted">{snapshot?.hostname || '等待 Agent 首次上报'}</span></span>
      <Link to={`/nodes/${node.id}`}>完整详情 <ArrowRightOutlined /></Link>
    </div>
    {node.status !== 'online' && <p className="node-preview-notice">{snapshot ? `当前${statuses[node.status].label}，以下为最后同步的记录。` : '完成 Agent 安装后，运行指标将在这里显示。'}</p>}
    {(snapshot?.error || node.config_error) && <p className="node-preview-notice">{node.config_error || snapshot?.error}</p>}
    <dl className="node-preview-grid">
      <div><dt>系统 / 架构</dt><dd>{snapshot ? `${snapshot.os} · ${snapshot.arch}` : '—'}</dd></div>
      <div><dt>CPU 核心 / 运行时长</dt><dd>{snapshot ? `${snapshot.cpu_cores} 核 · ${uptime(snapshot.uptime_seconds)}` : '—'}</dd></div>
      <div><dt>负载 1 / 5 / 15 分钟</dt><dd>{snapshot?.load.map(value => value?.toFixed(2) ?? '—').join(' / ') || '—'}</dd></div>
      <div><dt>内存 已用 / 总量</dt><dd>{snapshot ? `${memoryUsed(snapshot.memory_total, snapshot.memory_available)} / ${bytes(snapshot.memory_total)}` : '—'}</dd></div>
      <div><dt>Swap 使用率 / 总量</dt><dd>{snapshot ? `${percent(snapshot.swap_percent)} / ${bytes(snapshot.swap_total)}` : '—'}</dd></div>
      <div><dt>根分区 已用 / 总量</dt><dd>{disk ? `${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}` : '—'}</dd></div>
      <div><dt>监控网卡</dt><dd>{snapshot?.selected_interfaces.join(', ') || '—'}</dd></div>
      <div><dt>流量统计周期</dt><dd>{date(node.traffic.month.start)} — {date(node.traffic.month.end)}<small>{node.config.timezone}</small></dd></div>
      <div><dt>最后上报</dt><dd>{date(node.last_received_at)}</dd></div>
    </dl>
    {node.tags.length > 0 && <div className="node-preview-tags">{node.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}
  </div>;
}
