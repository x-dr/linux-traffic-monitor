import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { AssetSchema, ReportJobSchema, type NodeAsset, type ReportJobInput } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { nodeAsset, saveAsset } from './asset-store.js';
import { executeReports, previousReportPeriod, reportCSV, reportJobs, reportRow, reportRuns, saveReportJob } from './reports.js';
import { httpError } from './auth.js';
import { processRollups } from './history-rollups.js';
const params=Type.Object({id:Type.String({format:'uuid'})});
export function installManagementRoutes(app:FastifyInstance,db:DB,now:()=>number){
  app.get<{Params:{id:string}}>('/api/v1/nodes/:id/asset',{schema:{params}},async req=>nodeAsset(db,req.params.id));
  app.put<{Params:{id:string};Body:{asset:NodeAsset;expected_version:number}}>('/api/v1/nodes/:id/asset',{schema:{params,body:Type.Object({asset:AssetSchema,expected_version:Type.Integer({minimum:0})},{additionalProperties:false})}},async req=>saveAsset(db,req.params.id,req.body.asset,req.body.expected_version,now()));
  app.get('/api/v1/assets',async()=>{
    const rows=db.prepare('SELECT node_id,config FROM node_assets').all() as {node_id:string;config:string}[];const totals:Record<string,string>={};
    for(const row of rows){const node=findNode(db,row.node_id);if(node.archived||!node.enabled)continue;const asset=JSON.parse(row.config) as NodeAsset;totals[asset.currency]=String(BigInt(totals[asset.currency]??0)+BigInt(asset.price_minor));}
    return {assets:rows.map(r=>({node_id:r.node_id,...nodeAsset(db,r.node_id)})),totals_minor:totals};
  });
  app.get('/api/v1/report-jobs',async()=>({jobs:reportJobs(db)}));
  app.post<{Body:ReportJobInput}>('/api/v1/report-jobs',{schema:{body:ReportJobSchema}},async req=>saveReportJob(db,req.body,now()));
  app.put<{Params:{id:string};Body:{job:ReportJobInput;expected_version:number}}>('/api/v1/report-jobs/:id',{schema:{params,body:Type.Object({job:ReportJobSchema,expected_version:Type.Integer({minimum:1})},{additionalProperties:false})}},async req=>{if(!reportJobs(db).some(j=>j.id===req.params.id))throw httpError(404,'报表任务不存在');return saveReportJob(db,req.body.job,now(),req.params.id,req.body.expected_version);});
  app.post('/api/v1/report-jobs/run',{config:{rateLimit:{max:2,timeWindow:'1 minute'}}},async()=>{executeReports(db,now());return {ok:true};});
  app.get<{Querystring:{offset?:number}}>('/api/v1/report-runs',{schema:{querystring:Type.Object({offset:Type.Optional(Type.Integer({minimum:0,maximum:100000}))},{additionalProperties:false})}},async req=>({runs:reportRuns(db,req.query.offset)}));
  app.get<{Params:{id:string}}>('/api/v1/report-runs/:id/csv',{schema:{params}},async(req,reply)=>{
    const row=db.prepare('SELECT data FROM report_runs WHERE id=?').get(req.params.id) as {data:string}|undefined;if(!row)throw httpError(404,'报表不存在');
    return reply.header('Content-Disposition','attachment; filename="monitoring-report.csv"').type('text/csv; charset=utf-8').send(reportCSV(JSON.parse(row.data)));
  });
  app.post<{Body:ReportJobInput}>('/api/v1/reports/preview',{schema:{body:ReportJobSchema}},async req=>{
    const nodes=db.prepare('SELECT id FROM nodes WHERE enabled=1 AND archived=0 ORDER BY id LIMIT 50').all() as {id:string}[];
    const input=req.body;saveTimezone(input.timezone,now());
    return {rows:nodes.map(n=>findNode(db,n.id)).filter(n=>(!input.node_ids.length||input.node_ids.includes(n.id))&&(!input.group||input.group===n.group_name)).map(n=>{const [start,end]=previousReportPeriod(now(),input,n);return reportRow(db,n,start,end,now());})};
  });
  app.get<{Params:{id:string};Querystring:{domain:'resource'|'disk';days?:number;object?:string;offset?:number;granularity?:'hour'|'day'}}> ('/api/v1/nodes/:id/long-history',{schema:{params,querystring:Type.Object({domain:Type.Union([Type.Literal('resource'),Type.Literal('disk')]),days:Type.Optional(Type.Integer({minimum:1,maximum:3*366})),object:Type.Optional(Type.String({maxLength:128})),offset:Type.Optional(Type.Integer({minimum:0,maximum:1000000})),granularity:Type.Optional(Type.Union([Type.Literal('hour'),Type.Literal('day')]))},{additionalProperties:false})}},async req=>{
    findNode(db,req.params.id);processRollups(db,500);const days=req.query.days??365,step=days>366||req.query.granularity==='day'?86400:3600,start=Math.floor((now()-days*86400)/step)*step;
    return {step,start,end:now(),points:db.prepare('SELECT bucket ts,object,data FROM history_rollups WHERE node_id=? AND domain=? AND step=? AND bucket>=? AND (? IS NULL OR object=?) ORDER BY bucket,object LIMIT 2000 OFFSET ?').all(req.params.id,req.query.domain,step,start,req.query.object??null,req.query.object??null,req.query.offset??0).map(row=>{const r=row as {ts:number;object:string;data:string};return {...r,data:JSON.parse(r.data)};})};
  });
}
import { DateTime } from 'luxon';
function saveTimezone(zone:string,now:number){if(!DateTime.fromSeconds(now,{zone}).isValid)throw httpError(400,'IANA 时区无效');}
