import { useEffect, useRef } from 'react';
import { theme } from 'antd';
import { init, use } from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ProbeHistory } from '@traffic/contracts';
use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

export default function ProbeChart({ points }: { points: ProbeHistory['points'] }) {
  const target = useRef<HTMLDivElement>(null), { token } = theme.useToken();
  useEffect(() => {
    const chart = init(target.current!);
    chart.setOption({ animation: false, color: [token.colorPrimary], grid: { left: 56, right: 15, top: 15, bottom: 30 },
      tooltip: { trigger: 'axis', confine: true, valueFormatter: (v: unknown) => v === null ? '无有效成功样本' : `${Number(v).toFixed(2)} ms` },
      xAxis: { type: 'time', axisLabel: { color: token.colorTextSecondary, hideOverlap: true } },
      yAxis: { type: 'value', min: 0, axisLabel: { color: token.colorTextSecondary, formatter: '{value} ms' }, splitLine: { lineStyle: { color: token.colorBorderSecondary } } },
      series: [...new Set(points.map(p => p.task_version))].map(version => ({ type: 'line', name: `v${version}`, showSymbol: false, connectNulls: false,
        data: points.map(p => [p.ts * 1000, p.task_version === version ? p.latency_ms : null]) })),
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(target.current!);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [points, token.colorPrimary, token.colorTextSecondary, token.colorBorderSecondary]);
  return <div className="probe-chart" ref={target} role="img" aria-label="探测成功耗时趋势，缺口为空" />;
}
