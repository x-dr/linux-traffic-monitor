import { useState, type Key } from 'react';
import { Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { ClockCircleOutlined, CloudServerOutlined, DashboardOutlined, DatabaseOutlined, DownOutlined, HddOutlined, SwapOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { NodeView } from '@traffic/contracts';
import { date, uptime } from './format';
import { StatusTag } from './components';
import { NodePreview, ResourceBar, TrafficPair } from './NodeMetrics';

function compareBytes(a: string, b: string) {
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}

export default function NodeTable({ nodes }: { nodes: NodeView[] }) {
  const [expanded, setExpanded] = useState<readonly Key[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const currentPage = Math.min(page, Math.max(1, Math.ceil(nodes.length / pageSize)));
  const toggle = (id: string) => setExpanded(keys => keys.includes(id) ? keys.filter(key => key !== id) : [...keys, id]);
  const columns: TableColumnsType<NodeView> = [
    { title: <span><CloudServerOutlined /> 节点</span>, key: 'name', width: 200,
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_, node) => <div className="node-identity">
        <button className={`node-expand${expanded.includes(node.id) ? ' is-expanded' : ''}`}
          aria-label={`${expanded.includes(node.id) ? '收起' : '展开'} ${node.name} 运行详情`}
          aria-expanded={expanded.includes(node.id)} aria-controls={`node-preview-${node.id}`} onClick={() => toggle(node.id)}><DownOutlined /></button>
        <Link className="node-table-name" to={`/nodes/${node.id}`} title={`${node.name} · ${node.group || '未分组'}`}>
          <strong>{node.name}</strong><small>{node.group || '未分组'} · {node.snapshot?.os || '等待接入'}</small>
        </Link>
      </div> },
    { title: '状态', key: 'status', width: 98, render: (_, node) => <StatusTag status={node.status} /> },
    { title: <span>月流量 <span className="column-direction">↓ / ↑</span></span>, key: 'month', width: 195,
      sorter: (a, b) => compareBytes(a.traffic.month.total_bytes, b.traffic.month.total_bytes),
      render: (_, node) => <span className="monthly-traffic"><TrafficPair rx={node.traffic.month.rx_bytes} tx={node.traffic.month.tx_bytes} /></span> },
    { title: <span><ClockCircleOutlined /> 运行</span>, key: 'uptime', width: 100,
      sorter: (a, b) => (a.snapshot?.uptime_seconds ?? -1) - (b.snapshot?.uptime_seconds ?? -1),
      render: (_, node) => <span className={node.status !== 'online' ? 'muted' : ''} title={node.status !== 'online' ? `最后记录 · ${date(node.last_received_at)}` : undefined}>{uptime(node.snapshot?.uptime_seconds)}</span> },
    { title: '负载', key: 'load', width: 66,
      sorter: (a, b) => (a.snapshot?.load[0] ?? -1) - (b.snapshot?.load[0] ?? -1),
      render: (_, node) => <span className={node.status !== 'online' ? 'muted' : ''} title="1 分钟平均负载">{node.snapshot?.load[0]?.toFixed(2) ?? '—'}</span> },
    { title: <span><SwapOutlined /> 网络 <span className="column-direction">↓ / ↑</span></span>, key: 'network', width: 200,
      render: (_, node) => <TrafficPair rx={node.status === 'online' ? node.snapshot?.rx_bps : null} tx={node.status === 'online' ? node.snapshot?.tx_bps : null} speed /> },
    { title: <span>总流量 <span className="column-direction">↓ / ↑</span></span>, key: 'total', width: 195,
      sorter: (a, b) => compareBytes(a.traffic.total.total_bytes, b.traffic.total.total_bytes),
      render: (_, node) => <TrafficPair rx={node.traffic.total.rx_bytes} tx={node.traffic.total.tx_bytes} /> },
    { title: <span><DashboardOutlined /> CPU</span>, key: 'cpu', width: 95,
      sorter: (a, b) => (a.snapshot?.cpu_percent ?? -1) - (b.snapshot?.cpu_percent ?? -1),
      render: (_, node) => <ResourceBar node={node} value={node.snapshot?.cpu_percent} label="CPU" /> },
    { title: <span><DatabaseOutlined /> 内存</span>, key: 'memory', width: 95,
      sorter: (a, b) => (a.snapshot?.memory_percent ?? -1) - (b.snapshot?.memory_percent ?? -1),
      render: (_, node) => <ResourceBar node={node} value={node.snapshot?.memory_percent} label="内存" /> },
    { title: <span><HddOutlined /> 磁盘</span>, key: 'disk', width: 85,
      render: (_, node) => <ResourceBar node={node} value={node.snapshot?.disks.find(disk => disk.mount === '/')?.used_percent} label="磁盘" /> },
  ];

  return <div className="desktop-node-table node-table-container">
    <Table<NodeView> rowKey="id" size="small" dataSource={nodes}
      columns={columns.map(column => ({ ...column, className: 'node-table-cell' }))}
      rowClassName={(node, index) => `${index % 2 ? 'node-row-alternate' : 'node-row'}${node.status !== 'online' ? ' node-row-inactive' : ''}`}
      pagination={{ current: currentPage, pageSize, showSizeChanger: true, hideOnSinglePage: nodes.length <= 10,
        showTotal: total => `共 ${total} 台`, onChange: (next, size) => { setPage(next); setPageSize(size); } }}
      scroll={{ x: 1329 }} tableLayout="fixed"
      locale={{ emptyText: '没有符合条件的服务器' }}
      expandable={{ expandedRowKeys: expanded, onExpandedRowsChange: setExpanded, showExpandColumn: false,
        expandedRowClassName: 'node-row-expanded',
        expandedRowRender: node => <div id={`node-preview-${node.id}`}><NodePreview node={node} /></div> }} />
  </div>;
}
