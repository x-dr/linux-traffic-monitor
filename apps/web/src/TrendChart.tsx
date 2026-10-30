import { useEffect, useRef } from 'react';
import { theme } from 'antd';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { History } from '@traffic/contracts';
import { bytes } from './format';

use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);
export default function TrendChart({ history, kind = 'network', networkMode = 'speed' }: {
  history: History; kind?: 'network' | 'resource' | 'load' | 'disk'; networkMode?: 'speed' | 'volume';
}) {
  const target = useRef<HTMLDivElement>(null);
  const { token } = theme.useToken();
  useEffect(() => {
    const chart = init(target.current!);
    const network = kind === 'network';
    const disk = kind === 'disk';
    const byteAxis = network || disk;
    const speed = disk || networkMode === 'speed';
    const names = network ? ['下载', '上传'] : disk ? ['读取', '写入'] : kind === 'load' ? ['1 分钟负载'] : ['CPU', '内存'];
    const colors = network ? ['#53d6b5', '#789cff'] : disk ? ['#f6bd68', '#b299ff'] : ['#789cff', '#b299ff'];
    const series = names.map((name, index) => {
      const data = history.points.map(point => {
        const traffic = point[index ? 'tx_bytes' : 'rx_bytes'];
        const value = network ? traffic === null ? null : Number(traffic) / (speed ? point.duration_seconds : 1)
          : disk ? point.disk_io?.[index ? 'write_bps' : 'read_bps'] ?? null
          : kind === 'load' ? point.values?.load1.avg ?? null : point.values?.[index ? 'memory_percent' : 'cpu_percent'].avg ?? null;
        return [point.ts * 1000, value];
      });
      return { name, type: 'line' as const, showSymbol: data.filter(point => point[1] !== null).length === 1,
        symbolSize: 6, connectNulls: false, smooth: false, lineStyle: { width: 2 }, areaStyle: { opacity: 0.07 }, data };
    });
    chart.setOption({
      color: colors, animation: false, textStyle: { fontFamily: 'inherit' },
      legend: { top: 0, right: 0, icon: 'roundRect', itemWidth: 10, itemHeight: 5, textStyle: { color: token.colorTextSecondary } },
      grid: { left: byteAxis ? 85 : 48, right: 15, top: 42, bottom: 30 },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: token.colorBgElevated, borderColor: token.colorBorder, textStyle: { color: token.colorText }, valueFormatter: (v: unknown) => v === null ? '无数据' : byteAxis ? bytes(Number(v), speed) : `${Number(v).toFixed(2)}${kind === 'resource' ? '%' : ''}` },
      xAxis: { type: 'time', axisLine: { lineStyle: { color: token.colorBorderSecondary } }, axisLabel: { color: token.colorTextSecondary, hideOverlap: true }, splitLine: { show: false } },
      yAxis: { type: 'value', min: 0, max: kind === 'resource' ? 100 : undefined, axisLabel: { color: token.colorTextSecondary, formatter: (v: number) => byteAxis ? bytes(v, speed) : `${v}${kind === 'resource' ? '%' : ''}` }, splitLine: { lineStyle: { color: token.colorBorderSecondary, type: 'dashed' } } },
      series,
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(target.current!);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [history, kind, networkMode, token.colorBgElevated, token.colorBorder, token.colorBorderSecondary, token.colorText, token.colorTextSecondary]);
  return <div className="trend-chart" ref={target} role="img" aria-label={kind === 'network' ? `上下行网络${networkMode === 'speed' ? '速率' : '流量'}趋势图` : kind === 'disk' ? '硬盘读取和写入速度趋势图' : kind === 'load' ? '系统负载趋势图' : 'CPU 和内存使用率趋势图'} />;
}
