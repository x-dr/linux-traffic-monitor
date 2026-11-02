import { filesystemForecasts } from './filesystem-forecast.js';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { DiagnosticsConfigSchema, WorkloadsConfigSchema, type DiagnosticSettings, type TelemetryMinute, type TelemetryObject } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { httpError } from './auth.js';
import { telemetryView, type TelemetryStream } from './telemetry-store.js';
import { processRollups } from './history-rollups.js';
import { nodeEvent } from './alert-store.js';
const params=Type.Object({id:Type.String({format:'uuid'})});
export function installTelemetryRoutes(app:FastifyInstance,db:DB,now:()=>number) {
  for(const stream of ['diagnostics','workloads'] as const) {
    app.get<{Params:{id:string}}>(`/api/v1/nodes/:id/${stream}`,{schema:{params}},async req=>({...telemetryView(db,req.params.id,stream,now()),...(stream==='diagnostics'?{forecasts:filesystemForecasts(db,req.params.id,now())}:{})}));
    app.get<{Params:{id:string};Querystring:{minutes?:number;object?:string;offset?:number;limit?:number}}>(`/api/v1/nodes/:id/${stream}-history`,{schema:{params,querystring:Type.Object({
      minutes:Type.Optional(Type.Integer({minimum:5,maximum:3*366*1440})),object:Type.Optional(Type.String({maxLength:256})),offset:Type.Optional(Type.Integer({minimum:0,maximum:1e6})),limit:Type.Optional(Type.Integer({minimum:1,maximum:2000})),
    },{additionalProperties:false})}},async req=>telemetryHistory(db,req.params.id,stream,req.query,now()));
  }
  app.put<{Params:{id:string};Body:DiagnosticSettings&{expected_version:number}}>('/api/v1/nodes/:id/diagnostic-settings',{schema:{params,body:Type.Object({
    diagnostics:DiagnosticsConfigSchema,workloads:WorkloadsConfigSchema,expected_version:Type.Integer({minimum:1}),
  },{additionalProperties:false})}},async req=>{
    findNode(db,req.params.id);const {expected_version,...config}=req.body;
    const view=telemetryView(db,req.params.id,'diagnostics',now());
    if(view.config_version!==expected_version)throw httpError(409,'扩展配置已改变，请刷新后重试');
    db.transaction(()=>{
      db.prepare('INSERT INTO diagnostic_settings VALUES(?,?) ON CONFLICT(node_id) DO UPDATE SET config=excluded.config').run(req.params.id,JSON.stringify(config));
      db.prepare('INSERT INTO agent_extensions(node_id,config_version) VALUES(?,2) ON CONFLICT(node_id) DO UPDATE SET config_version=config_version+1,error=NULL').run(req.params.id);
      nodeEvent(db,req.params.id,'diagnostic_config_changed',now(),'诊断与工作负载配置已更新，等待 Agent 确认');
    })();return telemetryView(db,req.params.id,'diagnostics',now());
  });
  app.get('/api/v1/control-diagnostics',async()=>{
    const size=db.pragma('page_count',{simple:true}) as number,pageSize=db.pragma('page_size',{simple:true}) as number;
    return {database_bytes:size*pageSize,...db.prepare('SELECT report_ms,report_max_ms,reports,scheduler_lag_ms,last_tick_at FROM control_diagnostics WHERE id=1').get() as object,
      notification_queue:db.prepare('SELECT status,COUNT(*) count FROM notification_outbox GROUP BY status').all(),rollup_pending:(db.prepare('SELECT COUNT(*) n FROM rollup_dirty').get() as {n:number}).n};
  });
}
export function telemetryHistory(db:DB,node:string,stream:TelemetryStream,query:{minutes?:number;object?:string;offset?:number;limit?:number},now:number) {
  findNode(db,node);const end=Math.floor(now/60)*60+60,start=end-(query.minutes??60)*60;
  const step=(query.minutes??60)>30*1440?86400:(query.minutes??60)>2*1440?3600:60;
  if(step>60)processRollups(db,500);
  const values:unknown[]=[node,stream,start,end];
  const source=step===60?`SELECT t.minute_ts ts,j.value data FROM telemetry_minutes t,json_each(t.data,'$.objects') j WHERE t.node_id=? AND t.stream=? AND t.minute_ts>=? AND t.minute_ts<?`:
    `SELECT bucket ts,data FROM history_rollups WHERE node_id=? AND domain=? AND bucket>=? AND bucket<? AND step=${step}`;
  const filtered=source+(query.object?` AND json_extract(${step===60?'j.value':'data'},'$.object')=?`:'');
  if(query.object)values.push(query.object);
  const total=(db.prepare(`SELECT COUNT(*) n FROM (${filtered})`).get(...values) as {n:number}).n;
  const rows=db.prepare(`${filtered} ORDER BY ts LIMIT ? OFFSET ?`).all(...values,query.limit??1000,query.offset??0) as {ts:number;data:string}[];
  return {start,end:now,step,total,points:rows.map(r=>({ts:r.ts,object:JSON.parse(r.data) as TelemetryObject}))};
}
