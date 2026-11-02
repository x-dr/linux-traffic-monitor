import { lazy, Suspense } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Select } from 'antd';
import { useSearchParams } from 'react-router-dom';
import type { History, ResourceMinute } from '@traffic/contracts';
import { api } from './api';
import { ErrorState } from './components';
const TrendChart=lazy(()=>import('./TrendChart'));
import { bytes } from './format';
type Bucket={ts:number;object:string;data:ResourceMinute['values']|{read_bytes:string;write_bytes:string;observed_seconds:number}};
export default function LongHistory({id}:{id:string}){
 const [params,setParams]=useSearchParams();const domain=params.get('long_domain')==='disk'?'disk':'resource',days=[30,365,1095].includes(Number(params.get('long_days')))?Number(params.get('long_days')):365,granularity=params.get('long_step')==='hour'?'hour':'day',offset=Math.max(0,Number(params.get('long_offset'))||0),device=params.get('long_device')||'';
 const query=useQuery({queryKey:['long-history',id,domain,days,granularity,offset,device],queryFn:()=>api<{step:number;start:number;end:number;points:Bucket[]}>(`/nodes/${id}/long-history?${new URLSearchParams({domain,days:String(days),granularity,offset:String(offset),...(device?{object:device}:{})})}`)});
 const update=(key:string,value:string)=>{const next=new URLSearchParams(params);next.set(`long_${key}`,value);if(key!=='offset')next.delete('long_offset');setParams(next,{preventScrollReset:true});};
 let history:History|undefined;
 if(query.data){const data=query.data;const buckets=new Map<number,Bucket[]>();for(const p of data.points)buckets.set(p.ts,[...buckets.get(p.ts)??[],p]);const points:History['points']=[];
 for(let ts=Math.floor(data.start/data.step)*data.step;ts<data.end;ts+=data.step){const rows=buckets.get(ts)??[];let disk:History['points'][number]['disk_io']=null;
 if(domain==='disk'&&rows.length){const values=rows.map(r=>r.data as {read_bytes:string;write_bytes:string;observed_seconds:number});let read=0n,write=0n,readRate=0,writeRate=0;for(const v of values){read+=BigInt(v.read_bytes);write+=BigInt(v.write_bytes);if(v.observed_seconds>0){readRate+=Number(v.read_bytes)/v.observed_seconds;writeRate+=Number(v.write_bytes)/v.observed_seconds;}}disk={read_bytes:String(read),write_bytes:String(write),read_bps:readRate,write_bps:writeRate};}
 points.push({ts,duration_seconds:data.step,rx_bytes:null,tx_bytes:null,values:domain==='resource'?(rows[0]?.data as ResourceMinute['values']??null):null,disk_io:disk});}
 history={points,step:data.step,start:data.start,end:data.end,minutes:days*1440,network:{interfaces:[],interface:null,total:{rx_bytes:'0',tx_bytes:'0',total_bytes:'0'}},disk_io:{devices:[],device:device||null,total:{read_bytes:null,write_bytes:null}}};}
 return <section className="panel"><h2>资源与磁盘长期历史</h2><div className="monitor-filters"><Select aria-label="长期历史领域" value={domain} onChange={v=>update('domain',v)} options={[{value:'resource',label:'CPU / 内存'},{value:'disk',label:'磁盘 I/O'}]}/><Select aria-label="长期历史范围" value={days} onChange={v=>update('days',String(v))} options={[{value:30,label:'30 天'},{value:365,label:'1 年'},{value:1095,label:'3 年'}]}/><Select aria-label="长期历史粒度" value={granularity} onChange={v=>update('step',v)} options={[{value:'hour',label:'小时（保留 1 年）'},{value:'day',label:'天（保留 3 年）'}]}/>{domain==='disk'&&<Select aria-label="长期历史设备" allowClear value={device||undefined} placeholder="全部设备" onChange={v=>update('device',v??'')} options={[...new Set(query.data?.points.map(p=>p.object)??[])].map(value=>({value,label:value}))}/>}</div>
 {query.isError&&<ErrorState error={query.error}/>} {history&&<Suspense fallback={<p role="status">正在加载图表…</p>}><TrendChart history={history} kind={domain==='disk'?'disk':'resource'}/></Suspense>}
 <p className="muted">均值按有效采样次数或观测时长加权，最大值与覆盖单独保留。缺失区域为空；流量仍由原始分钟记录计费。每页最多 2000 桶。</p>
 <div className="telemetry-values">{query.data?.points.slice(-3).map(p=><div key={`${p.ts}:${p.object}`}><span>{new Date(p.ts*1000).toLocaleString()} {p.object}</span>{'cpu_percent' in p.data?<small>CPU 最大 {p.data.cpu_percent.max?.toFixed(1)??'—'}% · {p.data.cpu_percent.count} 个有效样本</small>:<small>读取 {bytes(p.data.read_bytes)} / 写入 {bytes(p.data.write_bytes)} · 有效观测 {p.data.observed_seconds.toFixed(0)} 秒</small>}</div>)}</div><div className="monitor-actions"><Button disabled={!offset} onClick={()=>update('offset',String(Math.max(0,offset-2000)))}>上一页汇总</Button><Button disabled={(query.data?.points.length??0)<2000} onClick={()=>update('offset',String(offset+2000))}>下一页汇总</Button></div>
 </section>;
}
