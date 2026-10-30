import { Tag, Progress, Empty, Button, Skeleton, Alert } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { NodeStatus } from '@traffic/contracts';
import { percent } from './format';

export const statuses: Record<NodeStatus, { label: string; color: string }> = {
  online: { label: '在线', color: 'success' }, stale: { label: '数据陈旧', color: 'warning' },
  offline: { label: '离线', color: 'error' }, pending: { label: '待接入', color: 'default' },
  disabled: { label: '已停用', color: 'default' }, archived: { label: '已归档', color: 'default' },
};
export function StatusTag({ status }: { status: NodeStatus }) {
  const item = statuses[status];
  return <Tag color={item.color}><span className={`status-dot ${status}`} />{item.label}</Tag>;
}
export function PageTitle({ eyebrow, title, subtitle, extra }: { eyebrow: string; title: string; subtitle: string; extra?: ReactNode }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div>{extra && <div className="page-title-actions">{extra}</div>}</div>;
}
export function MetricCard({ title, value, hint, icon, accent = 'mint' }: { title: string; value: ReactNode; hint: ReactNode; icon: ReactNode; accent?: string }) {
  return <section className={`metric-card accent-${accent}`}><div className="metric-top"><span>{title}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value}</div><div className="metric-hint">{hint}</div></section>;
}
export function Gauge({ value, color = '#53d6b5' }: { value: number | null | undefined; color?: string }) {
  return <div className="gauge"><span className="mono">{percent(value)}</span><Progress percent={value ?? 0} showInfo={false} strokeColor={color} size="small" aria-label={percent(value)} /></div>;
}
export function NoNodes() {
  return <div className="empty-fleet"><Empty description={<><h3>从第一台 VPS 开始</h3><p>接入 Agent 后，这里将实时呈现你的服务器状态。</p></>} /><Link to="/connect"><Button type="primary" icon={<PlusOutlined />}>接入服务器</Button></Link></div>;
}
export function LoadingState({ metrics = false }: { metrics?: boolean }) {
  return <div className="page-loading" role="status" aria-label="正在加载页面" aria-busy="true">
    <div className="loading-heading" aria-hidden="true"><Skeleton active title={{ width: '24%' }} paragraph={{ rows: 1, width: '56%' }} /></div>
    {metrics && <div className="metrics-grid" aria-hidden="true">{[0, 1, 2, 3].map(key =>
      <div className="metric-card loading-metric" key={key}><Skeleton active paragraph={{ rows: 2 }} /></div>
    )}</div>}
    <div className="panel loading-panel" aria-hidden="true"><Skeleton active paragraph={{ rows: 6 }} /></div>
  </div>;
}
export function ErrorState({ error }: { error: Error | null }) { return <Alert showIcon type="error" title="数据加载失败" description={error?.message || '请稍后重试'} />; }
