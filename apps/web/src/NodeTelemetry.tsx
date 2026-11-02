import { lazy, Suspense } from 'react';
import { Alert, Select, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { management } from './management-api';
import { date } from './format';
import { ErrorState, LoadingState } from './components';
const TelemetryChart=lazy(()=>import('./TelemetryChart'));
import TelemetrySettings from './TelemetrySettings';
import './telemetry.css';
const labels:Record<string,string>={ok:'可用',unsupported:'不支持',unreadable:'不可读',disabled:'未启用',absent:'未运行'};
export default function NodeTelemetry({id,stream='diagnostics'}:{id:string;stream?:'diagnostics'|'workloads'}){
  const [params,setParams]=useSearchParams();const prefix=stream==='diagnostics'?'diag':'workload';
  const query=useQuery({queryKey:['telemetry',id,stream],queryFn:()=>management.telemetry(id,stream),refetchInterval:5000});
  const selected=params.get(`${prefix}_object`)||query.data?.latest[0]?.object||'cpu';
  const current=query.data?.latest.find(o=>o.object===selected),metric=params.get(`${prefix}_metric`)||Object.keys(current?.values??{})[0]||'iowait_percent';
  const minutes=[60,1440,43200,527040,1581120].includes(Number(params.get(`${prefix}_minutes`)))?Number(params.get(`${prefix}_minutes`)):60;
  const history=useQuery({queryKey:['telemetry-history',id,stream,minutes,selected],queryFn:()=>management.history(id,stream,minutes,selected),refetchInterval:30000,enabled:!!query.data});
  const update=(key:string,value:string)=>{const next=new URLSearchParams(params);next.set(`${prefix}_${key}`,value);if(key==='object')next.delete(`${prefix}_metric`);setParams(next,{replace:true,preventScrollReset:true});};
  if(query.isPending)return <LoadingState/>;if(query.isError)return <ErrorState error={query.error}/>;const view=query.data;
  return <div className="telemetry-page">
    <Alert showIcon type={view.supported?'info':'warning'} title={!view.supported?'待升级 Agent（此能力尚不支持）':!view.enabled?'采集未启用':view.error?`Agent 配置错误：${view.error}`:view.config_version!==view.applied_version?'等待 Agent 应用配置':'扩展配置已应用'} description={`中心配置 v${view.config_version} / Agent 已应用 v${view.applied_version}。各指标按自身采样时间判断新鲜度。`}/>
    <section className="panel"><h2>{stream==='diagnostics'?'系统诊断历史':'容器与重点进程'}</h2><div className="monitor-filters">
      <Select aria-label="诊断对象" showSearch={{optionFilterProp:"label"}} value={selected} onChange={v=>update('object',v)} options={[...new Set([selected,...view.latest.map(o=>o.object),...history.data?.points.map(p=>p.object.object)??[]])].map(value=>({value,label:value}))}/>
      <Select aria-label="诊断指标" value={metric} onChange={v=>update('metric',v)} options={[...new Set([metric,...Object.keys(current?.values??{}),...history.data?.points.flatMap(p=>Object.keys(p.object.values))??[]])].map(value=>({value,label:value}))}/>
      <Select aria-label="诊断时间范围" value={minutes} onChange={v=>update('minutes',String(v))} options={[{value:60,label:'最近 1 小时'},{value:1440,label:'最近 1 天'},{value:43200,label:'最近 30 天'},{value:527040,label:'最近 1 年'},{value:1581120,label:'最近 3 年'}]}/>
    </div>
    {current?<><p><Tag color={current.fresh?'success':'warning'}>{labels[current.status]} · {current.fresh?'新鲜':'无新鲜数据'}</Tag>采样：{date(current.observed_at)} · 周期 {current.interval_seconds} 秒</p><div className="telemetry-values">{Object.entries(current.values).map(([key,v])=><div key={key}><span>{key}</span><strong>{v.last===null?'—':v.last.toLocaleString(undefined,{maximumFractionDigits:3})}</strong><small>有效 {v.count} 次 / {v.seconds.toFixed(0)} 秒</small></div>)}</div></>:<p className="muted">当前没有该对象；历史记录仍可查询。缺失指标不按零显示。</p>}
    {history.isError&&<ErrorState error={history.error}/>}{history.data&&<><Suspense fallback={<p role="status">正在加载图表…</p>}><TelemetryChart history={history.data} metric={metric}/></Suspense><p className="muted">{history.data.total} 个桶 · 粒度 {history.data.step} 秒。断档与身份变更中断连线；均值按有效观测加权。{history.data.total>history.data.points.length?'结果超过单页上限，请缩短时间窗口。':''}</p></>}
    </section>
    {view.forecasts?.length? <section className="panel"><h2>磁盘容量趋势估算</h2>{view.forecasts.map(f=><p key={f.object}>{f.object} · {f.full_at?`预计写满 ${date(f.full_at)}`:f.reason} · 有效 {f.days} 天</p>)}</section>:null}
    <TelemetrySettings key={`${id}:${stream}`} id={id} view={view} stream={stream}/>
    {stream==='diagnostics'&&<section className="panel"><h2>Agent 同步状态</h2><p>上次成功确认：{date(view.sync?.last_ack_at)}</p><div className="telemetry-values">{view.sync?.streams.map(s=><div key={s.name}><strong>{s.name}</strong><span>积压 {s.pending} 条 · 水位 {s.cursor}</span><small>最早 {date(s.oldest_at)}<br/>{s.drops_tracked?`过期丢弃 ${s.dropped} 条 · ${date(s.dropped_oldest_at)} 至 ${date(s.dropped_newest_at)}`:['traffic','totals'].includes(s.name)?'长期保留':'未提供此流的过期丢弃统计'}</small></div>)??<p className="muted">等待新版 Agent 同步诊断。</p>}</div></section>}
  </div>;
}
