import { lazy, Suspense } from 'react';
import { Alert, Button, Empty, Progress, Segmented, Select, Skeleton } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { HistoryGranularity, NodeView } from '@traffic/contracts';
import { client } from './api';
import { bytes, date } from './format';
import './history.css';

const TrendChart = lazy(() => import('./TrendChart'));
const ranges = [{ label: '1 小时', value: 60 }, { label: '6 小时', value: 360 }, { label: '24 小时', value: 1440 },
  { label: '7 天', value: 10080 }, { label: '30 天', value: 43200 }];
const granularities = [{ label: '自动聚合', value: 'auto' }, { label: '按小时', value: 'hour' }, { label: '按天（UTC）', value: 'day' }];

export default function NodeHistory({ node }: { node: NodeView }) {
  const [params, setParams] = useSearchParams();
  const requestedMinutes = Number(params.get('minutes'));
  const minutes = ranges.some(range => range.value === requestedMinutes) ? requestedMinutes : 60;
  const iface = /^[a-zA-Z0-9_.:-]{1,15}$/.test(params.get('interface') || '') ? params.get('interface')! : '';
  const device = /^[a-zA-Z0-9_.:-]{1,128}$/.test(params.get('device') || '') ? params.get('device')! : '';
  const granularity: HistoryGranularity = ['hour', 'day'].includes(params.get('granularity') || '')
    ? params.get('granularity') as HistoryGranularity : 'auto';
  const mode = params.get('network') === 'volume' ? 'volume' : 'speed';
  const update = (key: string, value: string | number) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value === '' || value === 'auto' || value === 'speed') next.delete(key);
    else next.set(key, String(value));
    return next;
  });
  const query = useQuery({ queryKey: ['history', node.id, minutes, iface, device, granularity],
    queryFn: () => client.history(node.id, minutes, { interface: iface || undefined, device: device || undefined, granularity }) });
  const history = query.data;
  const interfaceNames = [...new Set([...(history?.network.interfaces || []), ...node.snapshot?.selected_interfaces || [], ...iface ? [iface] : []])].sort();
  const deviceNames = [...new Set([...(history?.disk_io.devices || []), ...node.snapshot?.disk_io?.map(d => d.device) || [], ...device ? [device] : []])].sort();
  const networkAvailable = history?.points.some(point => point.rx_bytes !== null);
  const diskAvailable = history?.points.some(point => point.disk_io !== null);
  const chart = (kind: 'network' | 'resource' | 'load' | 'disk') => {
    if (!history) return query.isError ? <div className="history-empty muted">历史数据加载失败，请重试。</div> : <div className="history-loading"><Skeleton active /></div>;
    const empty = kind === 'network' ? !networkAvailable : kind === 'disk' ? !diskAvailable : !history.points.some(point => point.values !== null);
    if (empty) return <div className="history-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={kind === 'disk'
      ? node.snapshot?.disk_io === undefined && !node.snapshot?.disk_io_supported ? '暂无硬盘读写历史，请升级 Agent 后等待采样。'
        : !device && !deviceNames.length ? '暂无可读取的整盘指标，请检查 VPS 是否提供块设备统计。'
        : '所选区间暂无这块磁盘的读写记录。'
      : '所选区间暂无采集记录。'} /></div>;
    return <Suspense fallback={<div className="history-loading"><Skeleton active /></div>}>
      <TrendChart history={history} kind={kind} networkMode={mode} />
    </Suspense>;
  };
  const total = history?.network.total;
  const diskTotal = history?.disk_io.total;
  const aggregationLabel = history ? history.step === 86400 ? '天（UTC）' : history.step === 3600 ? '小时' : '分钟' : '分钟';
  return <div className="node-history">
    <div className="range-toolbar history-toolbar">
      <div><span className="section-kicker">HISTORICAL TRENDS</span><h2>历史趋势</h2></div>
      <div className="history-controls">
        <Segmented aria-label="趋势时间范围" options={ranges} value={minutes} onChange={value => update('minutes', Number(value))} />
        <Select aria-label="历史聚合粒度" className="history-granularity" value={granularity} options={granularities}
          onChange={value => update('granularity', value)} />
      </div>
    </div>
    <div className="history-context" aria-live="polite">
      <span>{history ? `${date(history.start)} — ${date(history.end)} · 按${aggregationLabel}聚合` : '正在读取历史记录'}</span>
      <span>{query.isFetching && history ? '正在更新…' : '每 15 秒同步历史'}</span>
    </div>
    {query.isError && <Alert type={history ? 'warning' : 'error'} showIcon
      title={history ? '历史刷新失败，显示上次同步数据' : '历史数据加载失败'} description={query.error.message}
      action={<Button size="small" aria-label="重试历史数据" onClick={() => { void query.refetch(); }}>重试</Button>} />}
    <div className="detail-grid">
      <section className="panel history-panel" aria-label="网卡流量历史">
        <div className="panel-heading history-panel-heading">
          <div><span className="section-kicker">NETWORK TRAFFIC</span><h2>网卡流量历史</h2></div>
          <div className="history-controls">
            <Select aria-label="历史网卡筛选" className="history-device-select" value={iface} onChange={value => update('interface', value)}
              options={[{ label: '全部历史监控网卡', value: '' }, ...interfaceNames.map(name => ({ label: name, value: name }))]} />
            <Segmented aria-label="网络图表类型" value={mode} options={[{ label: '速率', value: 'speed' }, { label: '流量', value: 'volume' }]}
              onChange={value => update('network', value)} />
          </div>
        </div>
        <div className="history-summary">
          <Summary label="区间下载" value={networkAvailable ? total?.rx_bytes : null} accent="mint" />
          <Summary label="区间上传" value={networkAvailable ? total?.tx_bytes : null} accent="blue" />
          <Summary label="区间合计" value={networkAvailable ? total?.total_bytes : null} />
        </div>
        {chart('network')}
        <p className="history-note">{mode === 'volume' ? '每个时间桶的上传与下载流量' : '字节增量计算的时间桶平均速度'} · {iface || '全部历史监控网卡'}，含曾监控但已停用的网卡记录。</p>
      </section>
      <BillingCycle node={node} />
    </div>
    <section className="panel history-panel disk-history-panel" aria-label="硬盘读写历史">
      <div className="panel-heading history-panel-heading">
        <div><span className="section-kicker">DISK ACTIVITY</span><h2>硬盘读写历史</h2></div>
        <Select aria-label="历史磁盘筛选" className="history-device-select" value={device} onChange={value => update('device', value)}
          options={[{ label: '全部整盘', value: '' }, ...deviceNames.map(name => ({ label: name, value: name }))]} />
      </div>
      <div className="history-summary">
        <Summary label="区间读取" value={diskTotal?.read_bytes} accent="amber" />
        <Summary label="区间写入" value={diskTotal?.write_bytes} accent="violet" />
        <div className="history-sampling"><span>采样策略</span><strong>5 秒采样 · 保留 30 天</strong></div>
      </div>
      {chart('disk')}
      <p className="history-note">速度为实际采样区间的平均值，空缺表示未采集。仅统计 VPS 可见整盘，分区及叠加设备不重复累计。</p>
    </section>
    <div className="two-columns">
      <section className="panel"><div className="panel-heading"><h2>CPU 与内存</h2><span className="muted small">采样平均值</span></div>{chart('resource')}</section>
      <section className="panel"><div className="panel-heading"><h2>系统负载</h2><span className="muted small">1 分钟负载</span></div>{chart('load')}</section>
    </div>
  </div>;
}

function Summary({ label, value, accent = '' }: { label: string; value?: string | null; accent?: string }) {
  return <div className={`history-summary-item history-accent-${accent}`}><span>{label}</span><strong>{bytes(value)}</strong></div>;
}

function BillingCycle({ node }: { node: NodeView }) {
  const { traffic } = node;
  return <section className="panel cycle-panel">
    <span className="section-kicker">BILLING CYCLE</span><h2>本周期流量</h2>
    <div className="cycle-value">{bytes(traffic.month.total_bytes)}</div>
    <p className="small muted">{date(traffic.month.start)}<br />至 {date(traffic.month.end)}</p>
    <Progress percent={BigInt(traffic.month.total_bytes) > 0n ? Number(BigInt(traffic.month.rx_bytes) * 10000n / BigInt(traffic.month.total_bytes)) / 100 : 0}
      showInfo={false} strokeColor="#53d6b5" />
    <div className="summary-row"><span>↓ 下载</span><strong>{bytes(traffic.month.rx_bytes)}</strong></div>
    <div className="summary-row"><span>↑ 上传</span><strong>{bytes(traffic.month.tx_bytes)}</strong></div>
    <div className="cycle-previous"><span className="muted">上一完整周期</span><strong>{bytes(traffic.previous_month.total_bytes)}</strong>
      <p className="small muted">{date(traffic.previous_month.start)} — {date(traffic.previous_month.end)}</p></div>
  </section>;
}
