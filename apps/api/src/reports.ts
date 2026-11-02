import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { ReportJob, ReportJobInput, ReportRow, ReportRun, ResourceMinute, TelemetryMinute } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode, type NodeRow } from './nodes.js';
import { httpError } from './auth.js';
import { monthBounds } from './periods.js';
import { trafficBetween } from './traffic-accounting.js';
import { mergeResources, processRollups } from './history-rollups.js';
import { matches, validateChannels } from './alert-store.js';
export function reportJobs(db:DB):ReportJob[]{return (db.prepare('SELECT id,version,config FROM report_jobs ORDER BY created_at DESC').all() as {id:string;version:number;config:string}[]).map(r=>({...JSON.parse(r.config),id:r.id,version:r.version}));}
export function saveReportJob(db:DB,input:ReportJobInput,now:number,id:string=randomUUID(),expected?:number){
  if(!input.name.trim()||!DateTime.fromSeconds(now,{zone:input.timezone}).isValid)throw httpError(400,'名称或 IANA 时区无效');
  validateChannels(db,input.channel_ids);for(const node of input.node_ids)findNode(db,node);
  const old=reportJobs(db).find(j=>j.id===id);if(expected!==undefined&&old?.version!==expected)throw httpError(409,'报表配置已改变');
  if(!old&&(db.prepare('SELECT COUNT(*) n FROM report_jobs').get() as {n:number}).n>=50)throw httpError(400,'最多保存 50 个报表任务');
  db.transaction(()=>{
    db.prepare('INSERT INTO report_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config').run(id,(old?.version??0)+1,JSON.stringify(input),now);
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE event_id IS NULL AND json_extract(payload,'$.report_job_id')=? AND status IN ('pending','suppressed','sending')").run(id);
  })();return reportJobs(db).find(j=>j.id===id)!;
}
export function previousReportPeriod(now:number,job:ReportJobInput,node:NodeRow):[number,number]{
  if(job.period==='billing'){const [prev,curr]=monthBounds(now,JSON.parse(node.config));return [prev.toSeconds(),curr.toSeconds()];}
  const unit=job.period==='day'?'day':job.period==='week'?'week':'month';
  const end=DateTime.fromSeconds(now,{zone:job.timezone}).startOf(unit),start=end.minus({[unit+'s']:1});return [start.toSeconds(),end.toSeconds()];
}
export function reportRow(db:DB,node:NodeRow,start:number,end:number,now:number):ReportRow{
  const traffic=trafficBetween(db,node.id,null,start,end);
  const raw=db.prepare('SELECT minute_ts,metrics FROM resource_minutes WHERE node_id=? AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts').all(node.id,start,end) as {minute_ts:number;metrics:string}[];
  const earliestRaw=raw.length?Math.floor(raw[0].minute_ts/3600)*3600:Infinity;
  const old=db.prepare("SELECT data FROM history_rollups WHERE node_id=? AND domain='resource' AND step=3600 AND bucket>=? AND bucket+3600<=? AND bucket<? ORDER BY bucket").all(node.id,start,end,earliestRaw) as {data:string}[];
  const resources=mergeResources([...old.map(r=>JSON.parse(r.data)),...raw.map(r=>JSON.parse(r.metrics))] as ResourceMinute['values'][]);
  const observed=Math.min(end-start,(resources?.cpu_percent.count??0)*5);
  const probes=db.prepare('SELECT result FROM probe_results WHERE node_id=? AND scheduled_at>=? AND scheduled_at<?').all(node.id,start,end) as {result:string}[];
  let valid=0,success=0;for(const r of probes){const p=JSON.parse(r.result);if(p.attempts===1){valid++;if(p.status==='success')success++;}}
  const offlineRules=db.prepare('SELECT config FROM alert_rules WHERE archived=0').all() as {config:string}[];
  const tracked=offlineRules.some(r=>{const rule=JSON.parse(r.config);return rule.enabled&&rule.metric==='offline'&&matches(rule.scope,node);});
  const intervals=(db.prepare("SELECT first_anomaly_at start,COALESCE(resolved_at,?) end FROM alert_events WHERE node_id=? AND kind='offline' AND first_anomaly_at<? AND COALESCE(resolved_at,?)>? ORDER BY first_anomaly_at").all(end,node.id,end,end,start) as {start:number;end:number}[]).map(r=>({start:Math.max(start,r.start),end:Math.min(end,r.end)}));
  let downtime=0,lastEnd=start;for(const r of intervals){downtime+=Math.max(0,r.end-Math.max(lastEnd,r.start));lastEnd=Math.max(lastEnd,r.end);}
  const latest=db.prepare("SELECT data FROM telemetry_minutes WHERE node_id=? AND stream='diagnostics' AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts DESC LIMIT 1").get(node.id,start,end) as {data:string}|undefined;
  const capacity=latest?(JSON.parse(latest.data) as TelemetryMinute).objects.find(o=>o.object==='fs:/')?.values.used_percent?.last??null:null;
  return {node_id:node.id,name:node.name,start,end,rx_bytes:String(traffic.rx),tx_bytes:String(traffic.tx),availability:start>=now-7*86400&&valid?success/valid*100:null,
    observed_seconds:observed,downtime_seconds:tracked?downtime:null,cpu_avg:resources?.cpu_percent.avg??null,cpu_max:resources?.cpu_percent.max??null,capacity_used_percent:capacity};
}
export function executeReports(db:DB,now:number){
  processRollups(db,100);
  const nodes=db.prepare('SELECT * FROM nodes WHERE enabled=1 AND archived=0 ORDER BY id').all() as NodeRow[];
  db.transaction(()=>{for(const job of reportJobs(db)){
    if(!job.enabled)continue;
    const selected=nodes.filter(n=>(!job.node_ids.length||job.node_ids.includes(n.id))&&(!job.group||n.group_name===job.group));
    const periods=new Map<string,{start:number;end:number;nodes:NodeRow[]}>();
    for(const node of selected){const [start,end]=previousReportPeriod(now,job,node);const key=`${start}:${end}`;const period=periods.get(key)??{start,end,nodes:[]};period.nodes.push(node);periods.set(key,period);}
    for(const [key,period] of periods){
      if(db.prepare('SELECT 1 FROM report_runs WHERE job_id=? AND version=? AND period_key=?').get(job.id,job.version,key))continue;
      const id=randomUUID(),rows=period.nodes.map(node=>reportRow(db,node,period.start,period.end,now)),late=now-period.end>300;
      db.prepare('INSERT INTO report_runs VALUES(?,?,?,?,?,?,?)').run(id,job.id,job.version,key,now,Number(late),JSON.stringify(rows));
      const payload={report_job_id:job.id,report_version:job.version,report_id:id,name:job.name,late,timezone:job.timezone,start:period.start,end:period.end,rows,url:`/management?run=${id}`};
      for(const channel of job.channel_ids)db.prepare(`INSERT OR IGNORE INTO notification_outbox(id,event_id,node_id,channel_id,phase,idempotency_key,next_attempt_at,created_at,payload) VALUES(?,NULL,NULL,?,'report',?,?,?,?)`).run(randomUUID(),channel,`report:${job.id}:${job.version}:${key}:${channel}`,now,now,JSON.stringify(payload));
    }
  }})();
}
export function reportRuns(db:DB,offset=0):ReportRun[]{return (db.prepare('SELECT * FROM report_runs ORDER BY created_at DESC,id LIMIT 20 OFFSET ?').all(offset) as {id:string;job_id:string;period_key:string;created_at:number;late:number;data:string}[]).map(({data,late,...row})=>({...row,late:!!late,rows:JSON.parse(data)}));}
export function csvCell(value:unknown){const text=String(value??'');const safe=/^[\s\u0000-\u001f\uFEFF]*[=+\-@]/u.test(text)?`'${text}`:text;return `"${safe.replaceAll('"','""')}"`;}
export function reportCSV(rows:ReportRow[]){
  if(rows.length>50)throw httpError(413,'单次导出最多 50 个节点');
  const columns:(keyof ReportRow)[]=['name','start','end','rx_bytes','tx_bytes','availability','observed_seconds','downtime_seconds','cpu_avg','cpu_max','capacity_used_percent'];
  return '\uFEFF'+[columns.join(','),...rows.map(row=>columns.map(k=>csvCell(row[k])).join(','))].join('\r\n')+'\r\n';
}
