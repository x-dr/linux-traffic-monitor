import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './support.js';
import { emptyAsset, evaluateAssets, saveAsset } from '../src/asset-store.js';
import { csvCell, executeReports, previousReportPeriod, reportJobs, reportRuns, saveReportJob } from '../src/reports.js';
import { monthBounds } from '../src/periods.js';
import { defaultConfig, type ReportJobInput } from '../../../packages/contracts/src/index.js';
import { findNode } from '../src/nodes.js';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { filesystemForecasts } from '../src/filesystem-forecast.js';
import { ingest } from '../src/ingest.js';
const jobInput:ReportJobInput={name:'日报',enabled:true,period:'day',timezone:'Asia/Shanghai',node_ids:[],group:'',channel_ids:[]};
test('asset tiers deduplicate, merge highest tier, reconfigure and sum currencies separately',async()=>{
 const c=await setup();try{const a=await c.create(),b=await c.create();
 saveAsset(c.db,a.node.id,{...emptyAsset(),expires_at:c.now()+.5*86400,price_minor:100,currency:'USD'},0,c.now());evaluateAssets(c.db,c.now());
 assert.equal((c.db.prepare('SELECT COUNT(*) n FROM alert_events').get() as {n:number}).n,1);assert.equal((c.db.prepare('SELECT COUNT(*) n FROM asset_threshold_events').get() as {n:number}).n,3);
 saveAsset(c.db,a.node.id,{...emptyAsset(),expires_at:c.now()+60*86400,price_minor:100,currency:'USD'},1,c.now());assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as {state:string}).state,'closed');
 saveAsset(c.db,b.node.id,{...emptyAsset(),price_minor:200,currency:'CNY'},0,c.now());
 const response=await c.app.inject({url:'/api/v1/assets',headers:c.headers});assert.deepEqual(response.json().totals_minor,{USD:'100',CNY:'200'});
 const race=await c.app.inject({method:'PUT',url:`/api/v1/nodes/${a.node.id}/asset`,headers:c.headers,payload:{asset:emptyAsset(),expected_version:1}});assert.equal(race.statusCode,409);
 }finally{await c.close();}
});
test('registration exchanges private header for independent tokens, retries idempotently and enforces revocation/expiry/uses',async()=>{
 const c=await setup();try{
 const response=await c.app.inject({method:'POST',url:'/api/v1/registration-tokens',headers:c.headers,payload:{name:'batch',group:'new',expires_in:300,max_uses:1}});assert.equal(response.statusCode,200,response.body);const {id,token}=response.json();
 const payload={registration_id:id,request_id:randomUUID(),name:'registered'};const register=()=>c.app.inject({method:'POST',url:'/api/v1/agent/register',headers:{authorization:`Bearer ${token}`},payload});
 const first=await register();assert.equal(first.statusCode,200,first.body);const second=await register();assert.deepEqual(second.json(),first.json());
 assert.notEqual(first.json().token,token);assert.equal(findNode(c.db,first.json().node_id).group_name,'new');
 payload.request_id=randomUUID();assert.equal((await register()).statusCode,409);
 assert.ok(!(await c.app.inject({url:'/api/v1/registration-tokens',headers:c.headers})).body.includes(token));
 await c.app.inject({method:'DELETE',url:`/api/v1/registration-tokens/${id}`,headers:c.headers});assert.equal((await register()).statusCode,401);
 const expired=await c.app.inject({method:'POST',url:'/api/v1/registration-tokens',headers:c.headers,payload:{name:'expire',group:'',expires_in:300,max_uses:1}});c.advance(301);
 assert.equal((await c.app.inject({method:'POST',url:'/api/v1/agent/register',headers:{authorization:`Bearer ${expired.json().token}`},payload:{...payload,registration_id:expired.json().id}})).statusCode,401);
 assert.equal((await c.app.inject({method:'POST',url:'/api/v1/registration-tokens',payload:{name:'unauthorized',group:'',expires_in:300,max_uses:1}})).statusCode,401);
 }finally{await c.close();}
});
test('timezone report periods cover DST and exact per-node billing cycles',async()=>{
 const c=await setup();try{const n=await c.create(),node=findNode(c.db,n.node.id),clock=DateTime.fromISO('2026-03-09T12:00:00Z').toSeconds();
 const [start,end]=previousReportPeriod(clock,{...jobInput,timezone:'America/New_York'},node);assert.equal(end-start,23*3600);
 const [prev,curr]=monthBounds(clock,defaultConfig);assert.deepEqual(previousReportPeriod(clock,{...jobInput,period:'billing'},node),[prev.toSeconds(),curr.toSeconds()]);
 const [ws,we]=previousReportPeriod(clock,{...jobInput,period:'week',timezone:'UTC'},node);assert.equal(DateTime.fromSeconds(ws,{zone:'UTC'}).weekday,1);assert.equal(we-ws,7*86400);
 }finally{await c.close();}
});
test('scheduled reports persist once per period, only catch up latest, safely export and preserve traffic',async()=>{
 const c=await setup();try{const n=await c.create('=SUM(A1:A2)'),job=saveReportJob(c.db,jobInput,c.now());
 executeReports(c.db,c.now());executeReports(c.db,c.now());let runs=reportRuns(c.db);assert.equal(runs.length,1);assert.equal(runs[0].rows[0].availability,null);assert.equal(runs[0].rows[0].downtime_seconds,null);
 c.db.prepare('UPDATE sessions SET expires_at=?').run(c.now()+30*86400);c.advance(5*86400);executeReports(c.db,c.now());runs=reportRuns(c.db);assert.equal(runs.length,2);assert.ok(runs[0].late);
 const csv=await c.app.inject({url:`/api/v1/report-runs/${runs[0].id}/csv`,headers:c.headers});assert.equal(csv.statusCode,200);assert.ok(csv.body.includes("'=SUM"));assert.equal(csvCell('\t@sum(1)'), '"\'\t@sum(1)"');
 assert.equal((await c.app.inject({url:`/api/v1/report-runs/${runs[0].id}/csv`})).statusCode,401);
 saveReportJob(c.db,{...jobInput,enabled:false},c.now(),job.id,job.version);c.advance(86400);executeReports(c.db,c.now());assert.equal(reportRuns(c.db).length,2);
 assert.equal(reportJobs(c.db)[0].enabled,false);assert.equal(findNode(c.db,n.node.id).name,'=SUM(A1:A2)');
 }finally{await c.close();}
});
test('capacity forecasts require three covered days and reset on expansion, identity change or cleanup',async()=>{
 const c=await setup();try{const n=await c.create(),now=c.now(),today=Math.floor(now/86400)*86400,r=c.report();
 c.db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(n.node.id,JSON.stringify({diagnostics:{enabled:true,services:[]},workloads:{enabled:false,docker:false,processes:[]}}));r.capabilities={diagnostics:1};r.applied_extensions_config_version=1;
 const stats=(value:number,seconds=86400)=>({last:value,avg:value,max:value,count:seconds/30,seconds});
 const object={object:'fs:/',identity:'fs-a',observed_at:now,interval_seconds:30,status:'ok',values:{total_bytes:stats(1000,30),used_bytes:stats(400,30)}};
 r.diagnostics=[{minute_ts:Math.floor(now/60)*60,revision:100,config_version:1,objects:[object]}];ingest(c.db,`Bearer ${n.token}`,r,now);
 assert.equal(filesystemForecasts(c.db,n.node.id,now)[0].full_at,null);
 for(let day=3;day>=1;day--){const o={...object,observed_at:today-day*86400,values:{total_bytes:stats(1000),used_bytes:stats(400-day*100)}};c.db.prepare('INSERT INTO history_rollups VALUES(?,?,?,?,?,?)').run(n.node.id,'diagnostics','fs:/@fs-a',86400,today-day*86400,JSON.stringify(o));}
 assert.ok(filesystemForecasts(c.db,n.node.id,now)[0].full_at!>now);
 object.values.used_bytes=stats(10,30);r.diagnostics[0].revision++;ingest(c.db,`Bearer ${n.token}`,r,now);assert.equal(filesystemForecasts(c.db,n.node.id,now)[0].full_at,null);
 }finally{await c.close();}
});
