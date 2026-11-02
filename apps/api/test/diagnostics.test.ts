import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { setup } from './support.js';
import { ingest } from '../src/ingest.js';
import { migrateDatabase } from '../src/migrations.js';
import { telemetryView } from '../src/telemetry-store.js';
import { processRollups } from '../src/history-rollups.js';
import { pruneResources } from '../src/database.js';
import { AlertEngine } from '../src/alert-engine.js';
import { cpuRule } from './monitoring-support.js';
import type { TelemetryMinute } from '../../../packages/contracts/src/index.js';
export const minute=(at:number,revision=1,value:number|null=20,object='cpu'):TelemetryMinute=>({minute_ts:Math.floor(at/60)*60,revision,config_version:1,objects:[{object,identity:'boot-a',observed_at:at,interval_seconds:30,status:'ok',values:{iowait_percent:{last:value,avg:value,max:value,count:value===null?0:1,seconds:value===null?0:30}}}]});
test('diagnostic capability, strict schema, exact stream ACK, old versions and duplicate revisions',async()=>{
 const c=await setup();try{
  const n=await c.create(),r=c.report();r.traffic=[];r.resources=[];r.totals=[];
  let reply=ingest(c.db,`Bearer ${n.token}`,r,c.now());assert.equal(reply.server_capabilities?.diagnostics,1);assert.equal(reply.extensions_config,undefined);
  r.diagnostics=[minute(c.now(),50)];assert.throws(()=>ingest(c.db,`Bearer ${n.token}`,r,c.now()),/能力/);
  r.capabilities={diagnostics:1,workloads:1};reply=ingest(c.db,`Bearer ${n.token}`,r,c.now());assert.equal(reply.ack.diagnostics,50);assert.equal(reply.ack.workloads,undefined);assert.deepEqual(reply.extensions_config?.probes,[]);
  r.diagnostics=[minute(c.now(),49,99)];ingest(c.db,`Bearer ${n.token}`,r,c.now());assert.equal(telemetryView(c.db,n.node.id,'diagnostics',c.now()).latest[0].values.iowait_percent.last,20);
  r.diagnostics=[minute(c.now(),51,null)];const response=await c.app.inject({method:'POST',url:'/api/v1/agent/report',headers:{authorization:`Bearer ${n.token}`},payload:r});assert.equal(response.statusCode,200,response.body);
  assert.equal(telemetryView(c.db,n.node.id,'diagnostics',c.now()).latest[0].values.iowait_percent.last,null);
  const invalid=structuredClone(r);invalid.diagnostics![0].objects[0].values.iowait_percent.last='0' as unknown as number;
  assert.equal((await c.app.inject({method:'POST',url:'/api/v1/agent/report',headers:{authorization:`Bearer ${n.token}`},payload:invalid})).statusCode,400);
  r.diagnostics[0].config_version=99;assert.throws(()=>ingest(c.db,`Bearer ${n.token}`,r,c.now()),/版本/);
 }finally{await c.close();}
});
test('diagnostic settings require CSRF, preserve independent probe config and reject version races',async()=>{
 const c=await setup();try{const n=await c.create(),url=`/api/v1/nodes/${n.node.id}/diagnostic-settings`,body={diagnostics:{enabled:true,services:[{manager:'systemd',name:'nginx.service'}]},workloads:{enabled:false,docker:false,processes:[]},expected_version:1};
  assert.equal((await c.app.inject({method:'PUT',url,payload:body})).statusCode,401);
  assert.equal((await c.app.inject({method:'PUT',url,headers:c.headers,payload:body})).statusCode,200);
  assert.equal((await c.app.inject({method:'PUT',url,headers:c.headers,payload:body})).statusCode,409);
  const r=c.report();r.capabilities={probes:1};const reply=ingest(c.db,`Bearer ${n.token}`,r,c.now());assert.equal(reply.extensions_config?.diagnostics,undefined);
  const stopRule={...cpuRule,metric:'service_down',object:'service:systemd:nginx.service',threshold:.5,recovery_threshold:.5};assert.equal((await c.app.inject({method:'POST',url:'/api/v1/alert-rules',headers:c.headers,payload:stopRule})).statusCode,201);
  const bad=structuredClone(body);bad.expected_version=2;bad.diagnostics.services[0].name='nginx; reboot';assert.equal((await c.app.inject({method:'PUT',url,headers:c.headers,payload:bad})).statusCode,400);
 }finally{await c.close();}
});
test('low-frequency alert advances only own new samples, retains unknown, and breaks identity continuity',async()=>{
 const c=await setup();try{const n=await c.create(),rule=randomUUID(),r=c.report();r.traffic=[];r.resources=[];r.totals=[];r.capabilities={diagnostics:1};
 c.db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(n.node.id,JSON.stringify({diagnostics:{enabled:true,services:[]},workloads:{enabled:false,docker:false,processes:[]}}));
 c.db.prepare('INSERT INTO alert_rules(id,config) VALUES(?,?)').run(rule,JSON.stringify({...cpuRule,metric:'iowait',threshold:10,recovery_threshold:5,duration_seconds:30,recovery_seconds:30}));const engine=new AlertEngine(c.db);
 const sample=(value:number|null)=>{r.snapshot.observed_at=c.now();r.snapshot.revision++;r.diagnostics=[minute(c.now(),r.snapshot.revision,value)];r.applied_extensions_config_version=1;ingest(c.db,`Bearer ${n.token}`,r,c.now());engine.tick(c.now());};
 sample(20);c.advance(20);engine.tick(c.now());assert.equal((c.db.prepare('SELECT COUNT(*) n FROM alert_events').get() as {n:number}).n,0);
 c.advance(10);sample(20);assert.equal((c.db.prepare('SELECT COUNT(*) n FROM alert_events').get() as {n:number}).n,1);
 c.advance(91);engine.tick(c.now());assert.equal((c.db.prepare('SELECT validity FROM alert_events').get() as {validity:string}).validity,'unknown');
 sample(0);c.advance(30);sample(0);assert.equal((c.db.prepare('SELECT state FROM alert_events').get() as {state:string}).state,'resolved');
 }finally{await c.close();}
});
test('hour/day rollups weight valid counts, recompute late data and commit before raw cleanup',async()=>{
 const c=await setup();try{const n=await c.create(),r=c.report(),hour=Math.floor(c.now()/3600)*3600;r.traffic=[];r.totals=[];r.resources[0].minute_ts=hour;r.resources[0].values.cpu_percent={avg:10,max:30,count:1};
 ingest(c.db,`Bearer ${n.token}`,r,c.now());r.resources[0].minute_ts=hour+60;r.resources[0].revision++;r.resources[0].values.cpu_percent={avg:30,max:90,count:3};ingest(c.db,`Bearer ${n.token}`,r,c.now());processRollups(c.db);
 const read=()=>JSON.parse((c.db.prepare("SELECT data FROM history_rollups WHERE node_id=? AND domain='resource' AND step=3600 AND bucket=?").get(n.node.id,hour) as {data:string}).data);
 assert.equal(read().cpu_percent.avg,25);assert.equal(read().cpu_percent.max,90);
 r.resources[0].revision++;r.resources[0].values.cpu_percent={avg:50,max:100,count:3};ingest(c.db,`Bearer ${n.token}`,r,c.now());processRollups(c.db);assert.equal(read().cpu_percent.avg,40);
 pruneResources(c.db,c.now()+31*86400);assert.equal((c.db.prepare('SELECT COUNT(*) n FROM resource_minutes').get() as {n:number}).n,0);assert.equal(read().cpu_percent.avg,40);
 assert.ok(c.db.prepare("SELECT 1 FROM history_rollups WHERE step=86400 AND domain='resource'").get());
 }finally{await c.close();}
});
test('v4 to v5 diagnostics migration rolls back and preserves existing credentials and configuration',()=>{
 const db=new Database(':memory:');try{migrateDatabase(db,4);db.exec("INSERT INTO sessions VALUES('keep','csrf',9999999999);CREATE TABLE node_assets(conflict TEXT)");assert.throws(()=>migrateDatabase(db),/already exists/);assert.equal(db.pragma('user_version',{simple:true}),4);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='telemetry_minutes'").get(),undefined);db.exec('DROP TABLE node_assets');migrateDatabase(db,5);assert.equal(db.pragma('user_version',{simple:true}),5);assert.ok(db.prepare("SELECT 1 FROM sessions WHERE token_hash='keep'").get());}finally{db.close();}
});
