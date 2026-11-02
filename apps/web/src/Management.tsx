import { useQuery } from '@tanstack/react-query';
import { PageTitle, ErrorState } from './components';
import { management } from './management-api';
import { bytes, date } from './format';
import RegistrationSettings from './RegistrationSettings';
import ReportSettings from './ReportSettings';
import './telemetry.css';
export default function Management(){
  const control=useQuery({queryKey:['control-diagnostics'],queryFn:management.control,refetchInterval:10000});
  return <><PageTitle title="运行管理" eyebrow="OPERATIONS" subtitle="批量接入、长期历史、定时报表与监控自身状态。"/><div className="management-page"><section className="panel"><h2>中心诊断</h2>{control.isError&&<ErrorState error={control.error}/>}<div className="telemetry-values">{control.data&&<><div><span>数据库</span><strong>{bytes(control.data.database_bytes)}</strong><small>汇总待处理 {control.data.rollup_pending} 个小时桶</small></div><div><span>上报耗时 / 最大值</span><strong>{control.data.report_ms.toFixed(2)} / {control.data.report_max_ms.toFixed(2)} ms</strong><small>共 {control.data.reports} 次</small></div><div><span>判定调度延迟</span><strong>{control.data.scheduler_lag_ms.toFixed(0)} ms</strong><small>最近 {date(control.data.last_tick_at)}</small></div>{control.data.notification_queue.map(s=><div key={s.status}><span>通知 {s.status}</span><strong>{s.count}</strong></div>)}</>}</div><p className="muted">原始资源与诊断保留 30 天，小时汇总 1 年、天汇总 3 年；流量分钟记录长期保留。</p></section><RegistrationSettings/><ReportSettings/></div></>;
}
