import { useState } from 'react';
import { Alert, App, Button, Form, Input, Select, Switch } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { ReportJob, ReportJobInput, ReportRow } from '@traffic/contracts';
import { management } from './management-api';
import { monitoring } from './monitoring-api';
import { client } from './api';
import { bytes, date } from './format';
import { ErrorState } from './components';
export default function ReportSettings(){
  const {message}=App.useApp(),[editor,setEditor]=useState<ReportJob|null|false>(false),[params,setParams]=useSearchParams();
  const page=Math.max(0,Number(params.get('report_page'))||0);
  const jobs=useQuery({queryKey:['report-jobs'],queryFn:management.jobs}),runs=useQuery({queryKey:['report-runs',page],queryFn:()=>management.runs(page*20),refetchInterval:10000});
  const toggle=async(job:ReportJob)=>{const {id,version,...input}=job;try{await management.saveJob({...input,enabled:!job.enabled},id,version);await jobs.refetch();}catch(e){message.error((e as Error).message);}};
  return <section className="panel"><div className="monitor-card-heading"><h2>定时报表与导出</h2><div className="monitor-actions"><Button onClick={()=>setEditor(null)}>新建报表</Button><Button onClick={()=>{void management.run().then(()=>runs.refetch()).catch(e=>message.error((e as Error).message));}}>生成最近一期</Button></div></div>
    <p className="muted">按时区生成日、周、月或节点计费周期报表；恢复运行只补最近一期，并标记迟发。可用率指近 7 天有效探测的观测成功率；故障时长指离线告警区间，无对应数据时留空。</p>
    {editor!==false&&<ReportEditor key={editor?.id??'new'} job={editor??undefined} onSaved={()=>{setEditor(false);void jobs.refetch();}} onCancel={()=>setEditor(false)}/>}
    {jobs.isError&&<ErrorState error={jobs.error}/>}<div className="monitor-cards">{jobs.data?.jobs.map(job=><article key={job.id} className="monitor-card"><strong>{job.name}</strong><p>{{day:'日',week:'周',month:'月',billing:'计费周期'}[job.period]} · {job.timezone} · {job.enabled?'启用':'停用'} · v{job.version}</p><div className="monitor-actions"><Button onClick={()=>setEditor(job)}>编辑报表</Button><Button onClick={()=>{void toggle(job);}}>{job.enabled?'停用':'启用'}</Button></div></article>)}</div>
    <h3>最近生成</h3>{runs.isError&&<ErrorState error={runs.error}/>}<div className="monitor-cards">{runs.data?.runs.map(run=><article className="monitor-card" key={run.id}><strong>{jobs.data?.jobs.find(j=>j.id===run.job_id)?.name??'历史报表'}</strong><p>{date(run.created_at)} · {run.late?'迟发':'按期'} · {run.rows.length} 个节点</p><a href={`/api/v1/report-runs/${run.id}/csv`} download>下载 CSV</a>{run.rows.map(row=><p key={row.node_id}>{row.name} · 下载 {bytes(row.rx_bytes)} / 上传 {bytes(row.tx_bytes)} · CPU {row.cpu_avg===null?'—':`${row.cpu_avg.toFixed(1)}%`}</p>)}</article>)}</div><div className="monitor-actions"><Button disabled={!page} onClick={()=>{const next=new URLSearchParams(params);next.set('report_page',String(page-1));setParams(next,{preventScrollReset:true});}}>上一页报表</Button><Button disabled={(runs.data?.runs.length??0)<20} onClick={()=>{const next=new URLSearchParams(params);next.set('report_page',String(page+1));setParams(next,{preventScrollReset:true});}}>下一页报表</Button></div>
  </section>;
}
function ReportEditor({job,onSaved,onCancel}:{job?:ReportJob;onSaved:()=>void;onCancel:()=>void}){
  const [form]=Form.useForm<ReportJobInput>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<ReportRow[]|null>(null);
  const nodes=useQuery({queryKey:['nodes'],queryFn:client.nodes}),channels=useQuery({queryKey:['channels'],queryFn:monitoring.channels});
  const save=async(input:ReportJobInput)=>{setBusy(true);setError('');try{await management.saveJob(input,job?.id,job?.version);onSaved();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <Form name="report-job" form={form} layout="vertical" onFinish={save} initialValues={job??{name:'监控日报',enabled:false,period:'day',timezone:'Asia/Shanghai',node_ids:[],group:'',channel_ids:[]}}>
    {error&&<Alert type="error" showIcon title={error}/>}<div className="form-grid"><Form.Item label="报表名称" name="name" rules={[{required:true,whitespace:true}]}><Input maxLength={100}/></Form.Item><Form.Item label="统计周期" name="period"><Select options={[{value:'day',label:'自然日'},{value:'week',label:'自然周（周一开始）'},{value:'month',label:'日历月'},{value:'billing',label:'节点计费周期'}]}/></Form.Item><Form.Item label="IANA 时区" name="timezone" rules={[{required:true}]}><Input/></Form.Item><Form.Item label="分组筛选（空为全部）" name="group"><Input maxLength={100}/></Form.Item></div><Form.Item label="节点范围（空为全部）" name="node_ids"><Select mode="multiple" options={nodes.data?.nodes.map(n=>({value:n.id,label:n.name}))}/></Form.Item><Form.Item label="通知渠道" name="channel_ids"><Select mode="multiple" options={channels.data?.channels.map(c=>({value:c.id,label:c.name}))}/></Form.Item><Form.Item name="enabled" label="启用定时任务" valuePropName="checked"><Switch/></Form.Item><div className="monitor-actions"><Button type="primary" htmlType="submit" loading={busy}>保存报表任务</Button><Button onClick={()=>{void form.validateFields().then(v=>management.preview(v)).then(v=>setPreview(v.rows)).catch(e=>setError((e as Error).message));}}>预览最近一期</Button><Button onClick={onCancel}>取消</Button></div>{preview&&<p>预览 {preview.length} 个节点：{preview.map(r=>`${r.name}（${date(r.start)} 至 ${date(r.end)}，已观测 ${r.observed_seconds} 秒）`).join('；')}</p>}
  </Form>;
}
