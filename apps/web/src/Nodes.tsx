import { useEffect, useState } from 'react';
import { Button, Card, Input, Select } from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { NodeStatus } from '@traffic/contracts';
import { client } from './api';
import { date, uptime } from './format';
import { ErrorState, LoadingState, NoNodes, PageTitle, StatusTag, statuses } from './components';
import NodeTable from './NodeTable';
import { NodePreview, ResourceBar, TrafficPair } from './NodeMetrics';
import './nodes.css';

export default function NodesPage() {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<string>();
  const [status, setStatus] = useState<NodeStatus>();
  const [now, setNow] = useState(Date.now());
  const query = useQuery({ queryKey: ['nodes'], queryFn: client.nodes });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (query.isPending) return <LoadingState />;
  if (!query.data) return <ErrorState error={query.error} />;

  const nodes = query.data.nodes;
  const term = search.trim().toLowerCase();
  const filtered = nodes.filter(node =>
    (status === 'archived' ? node.archived : !node.archived)
    && (!term || `${node.name} ${node.snapshot?.hostname || ''} ${node.tags.join(' ')}`.toLowerCase().includes(term))
    && (!group || node.group === group)
    && (!status || node.status === status));
  const active = nodes.filter(node => !node.archived);
  const groups = [...new Set(nodes.map(node => node.group).filter(Boolean))].sort();
  const age = Math.max(0, Math.floor((now - query.dataUpdatedAt) / 1000));
  const updated = age < 5 ? '刚刚' : age < 60 ? `${age} 秒前` : `${Math.floor(age / 60)} 分钟前`;

  return <div className="vps-page">
    <PageTitle eyebrow="YOUR SERVER FLEET" title="VPS 管理"
      subtitle="一行掌握节点状态，展开查看运行详情。"
      extra={<Link to="/connect"><Button type="primary" icon={<PlusOutlined />}>接入 VPS</Button></Link>} />
    {nodes.length === 0 ? <NoNodes /> : <section className="panel node-monitor" aria-label="VPS 监控">
      <div className="node-monitor-heading">
        <div className="node-monitor-title"><span className="monitor-mark" /><h2>节点监控</h2><span className="node-count">{active.length} 台</span></div>
        <div className="node-health" aria-label="节点状态统计">
          {(['online', 'stale', 'offline', 'pending', 'disabled'] as const).map(value => {
            const count = active.filter(node => node.status === value).length;
            return count > 0 ? <span key={value} className={`health-item health-${value}`}><i />{count} {statuses[value].label}</span> : null;
          })}
        </div>
      </div>
      <div className="node-filters">
        <Input aria-label="搜索服务器" placeholder="搜索名称、主机名或标签" prefix={<SearchOutlined />}
          value={search} onChange={event => setSearch(event.target.value)} allowClear />
        <Select aria-label="分组筛选" placeholder="全部分组" value={group} onChange={setGroup} allowClear
          options={groups.map(value => ({ label: value, value }))} />
        <Select aria-label="状态筛选" placeholder="全部状态" value={status} onChange={setStatus} allowClear
          options={Object.entries(statuses).map(([value, item]) => ({ label: item.label, value }))} />
        <Button className="node-refresh" icon={<ReloadOutlined />} loading={query.isFetching}
          onClick={() => { void query.refetch(); }}>刷新数据</Button>
      </div>
      {query.isError && <div className="node-refresh-error" role="alert">刷新失败，显示上次同步数据：{query.error.message}</div>}
      <NodeTable nodes={filtered} />
      <div className="mobile-node-cards">
        {filtered.map(node => <Card key={node.id} size="small" className="node-mobile-card"
          title={<Link className="mobile-node-name" to={`/nodes/${node.id}`}>{node.name}</Link>}
          extra={<StatusTag status={node.status} />}>
          <div className="mobile-node-meta"><span>{node.group || '未分组'} · {node.snapshot?.os || '等待接入'}</span><span>{uptime(node.snapshot?.uptime_seconds)}</span></div>
          {((node.active_alerts ?? 0) > 0 || node.quota_percent != null) && <p><Link to={`/nodes/${node.id}?tab=events`}>活跃告警 {node.active_alerts ?? 0}</Link>{node.quota_percent != null && <> · <Link to={`/nodes/${node.id}?tab=quota`}>额度 {node.quota_percent.toFixed(1)}%</Link></>}</p>}
          <div className="mobile-resource-grid">
            <div><span>CPU</span><ResourceBar node={node} value={node.snapshot?.cpu_percent} label="CPU" /></div>
            <div><span>内存</span><ResourceBar node={node} value={node.snapshot?.memory_percent} label="内存" /></div>
            <div><span>磁盘</span><ResourceBar node={node} value={node.snapshot?.disks.find(disk => disk.mount === '/')?.used_percent} label="磁盘" /></div>
          </div>
          <dl className="mobile-traffic-list">
            <div><dt>网络速率</dt><dd><TrafficPair rx={node.status === 'online' ? node.snapshot?.rx_bps : null} tx={node.status === 'online' ? node.snapshot?.tx_bps : null} speed /></dd></div>
            <div><dt>月流量</dt><dd><TrafficPair rx={node.traffic.month.rx_bytes} tx={node.traffic.month.tx_bytes} /></dd></div>
            <div><dt>总流量</dt><dd><TrafficPair rx={node.traffic.total.rx_bytes} tx={node.traffic.total.tx_bytes} /></dd></div>
          </dl>
          <details className="mobile-node-preview"><summary>运行详情</summary><NodePreview node={node} /></details>
        </Card>)}
        {filtered.length === 0 && <div className="node-empty">没有符合条件的服务器</div>}
      </div>
      <div className="node-monitor-footer">
        <span title={date(query.dataUpdatedAt / 1000)}>最后更新：{updated}<span className="update-separator">·</span>共 {filtered.length} 台服务器</span>
        <span>↓ 下载 / ↑ 上传<span className="update-separator">·</span>月流量按节点周期统计</span>
      </div>
    </section>}
  </div>;
}
