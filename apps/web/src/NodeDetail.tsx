import { Alert, Descriptions, Table, Tabs } from 'antd';
import { ArrowLeftOutlined, DashboardOutlined, DatabaseOutlined, HddOutlined, ClockCircleOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { NodeView } from '@traffic/contracts';
import { client } from './api';
import { bytes, date, percent, uptime } from './format';
import { ErrorState, Gauge, LoadingState, MetricCard, PageTitle, StatusTag } from './components';
import NodeSettings from './NodeSettings';
import NodeHistory from './NodeHistory';
import TrafficPolicyPanel from './TrafficPolicy';
import NodeEvents from './NodeEvents';
import ProbesPage from './Probes';
import NodeTelemetry from './NodeTelemetry';
import NodeAsset from './NodeAsset';
import LongHistory from './LongHistory';
import { useSearchParams } from 'react-router-dom';

export default function NodeDetail() {
  const { id = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const query = useQuery({ queryKey: ['node', id], queryFn: () => client.node(id) });
  if (query.isPending) return <LoadingState metrics />;
  if (query.isError) return <ErrorState error={query.error} />;
  const node = query.data, snapshot = node.snapshot, traffic = node.traffic;
  const rootDisk = snapshot?.disks.find(d => d.mount === '/');
  return <>
    <Link to="/nodes" className="back-link"><ArrowLeftOutlined /> 返回服务器列表</Link>
    <PageTitle eyebrow={snapshot?.hostname || 'SERVER DETAILS'} title={node.name}
      subtitle={`${node.group || '未分组'} · ${snapshot?.os || '等待 Agent 接入'} · 最后上报：${date(node.last_received_at)}`}
      extra={<StatusTag status={node.status} />} />
    {node.status !== 'online' && <Alert className="connection-alert" showIcon type={node.status === 'offline' ? 'warning' : 'info'}
      title={node.status === 'pending' ? '等待 Agent 首次上报' : '当前未收到实时数据，下面展示最后已同步的记录'}
      description={node.status === 'pending' ? '请在节点接入页面完成 Agent 配置与安装。' : '历史数据已保留，连接恢复后自动更新。'} />}
    {snapshot?.error && <Alert showIcon type="warning" title={snapshot.error} />}
    <Tabs activeKey={['monitor','system','settings','quota','events','probes','diagnostics','workloads','asset','long-history'].includes(search.get('tab') || '') ? search.get('tab')! : 'monitor'} onChange={tab => { const next = new URLSearchParams(search); next.set('tab', tab); setSearch(next, { preventScrollReset: true }); }} items={[
      { key: 'monitor', label: '运行监控', children: <>
        <div className="metrics-grid">
          <MetricCard title="CPU 使用率" value={percent(snapshot?.cpu_percent)} hint={`${snapshot?.cpu_cores ?? '—'} 个逻辑核心`}
            icon={<DashboardOutlined />} accent="blue" />
          <MetricCard title="内存使用率" value={percent(snapshot?.memory_percent)}
            hint={snapshot ? `可用 ${bytes(snapshot.memory_available)} / ${bytes(snapshot.memory_total)}` : '等待采样'}
            icon={<DatabaseOutlined />} accent="violet" />
          <MetricCard title="根分区使用率" value={percent(rootDisk?.used_percent)}
            hint={rootDisk ? `${bytes(rootDisk.used_bytes)} / ${bytes(rootDisk.total_bytes)}` : '尚未发现根分区指标'}
            icon={<HddOutlined />} accent="amber" />
          <MetricCard title="持续运行时间" value={uptime(snapshot?.uptime_seconds)} hint={`Agent ${snapshot?.agent_version || '—'}`}
            icon={<ClockCircleOutlined />} />
        </div>
        <NodeHistory key={node.id} node={node} />
        <section className="panel lifetime-panel">
          <div><span className="section-kicker">LIFETIME TRAFFIC</span><h2>历史累计</h2></div>
          <div><span>累计下载</span><strong>{bytes(traffic.total.rx_bytes)}</strong></div>
          <div><span>累计上传</span><strong>{bytes(traffic.total.tx_bytes)}</strong></div>
          <div><span>累计合计</span><strong>{bytes(traffic.total.total_bytes)}</strong></div>
        </section>
      </> },
      { key: 'diagnostics', label: '系统诊断', children: <NodeTelemetry id={node.id} /> },
      { key: 'workloads', label: '容器与进程', children: <NodeTelemetry id={node.id} stream="workloads" /> },
      { key: 'long-history', label: '长期历史', children: <LongHistory id={node.id} /> },
      { key: 'asset', label: '资产', children: <NodeAsset id={node.id} /> },
      { key: 'quota', label: '流量套餐', children: <TrafficPolicyPanel node={node} /> },
      { key: 'events', label: '事件', children: <NodeEvents id={node.id} /> },
      { key: 'probes', label: '网络质量', children: <ProbesPage node={node.id} /> },
      { key: 'system', label: '系统信息', children: <SystemInfo node={node} /> },
      { key: 'settings', label: '节点设置', children: <NodeSettings key={`${node.id}:${node.config_version}`} node={node} /> },
    ]} />
    <div className="page-footnote">流量来自网卡计数器。安装前的数据无法追溯；停机跨月时无法精确分摊各周期流量。</div>
  </>;
}

function SystemInfo({ node }: { node: NodeView }) {
  const { snapshot } = node;
  return <div className="two-columns">
    <section className="panel"><h2>主机信息</h2><Descriptions column={1} items={[
      { key: 'host', label: '主机名', children: snapshot?.hostname || '—' },
      { key: 'os', label: '系统', children: snapshot?.os || '—' },
      { key: 'arch', label: '架构', children: snapshot?.arch || '—' },
      { key: 'kernel', label: '内核', children: snapshot?.kernel || '—' },
      { key: 'cores', label: 'CPU 核心', children: snapshot?.cpu_cores ?? '—' },
      { key: 'uptime', label: '运行时长', children: uptime(snapshot?.uptime_seconds) },
      { key: 'load', label: '负载 1 / 5 / 15', children: snapshot?.load.map(value => value?.toFixed(2) ?? '—').join(' / ') || '—' },
      { key: 'swap', label: 'Swap', children: `${percent(snapshot?.swap_percent)} / ${bytes(snapshot?.swap_total)}` },
      { key: 'interfaces', label: '监控网卡', children: snapshot?.selected_interfaces.join(', ') || '—' },
      { key: 'timezone', label: '统计时区', children: node.config.timezone },
    ]} /></section>
    <section className="panel"><h2>磁盘空间</h2><Table rowKey="mount" dataSource={snapshot?.disks || []} pagination={false}
      scroll={{ x: 450 }} columns={[
        { title: '挂载点', dataIndex: 'mount' },
        { title: '已用 / 总量', render: (_, disk) => `${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}` },
        { title: '使用率', render: (_, disk) => <Gauge value={disk.used_percent} color="#f6bd68" /> },
      ]} /></section>
  </div>;
}
