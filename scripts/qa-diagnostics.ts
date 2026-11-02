import type { DB } from '../apps/api/src/database.js';
import type { AgentReport, TelemetryMinute } from '../packages/contracts/src/index.js';
import { createNode } from '../apps/api/src/nodes.js';
import { ingest } from '../apps/api/src/ingest.js';
import { saveAsset, emptyAsset } from '../apps/api/src/asset-store.js';
import { processRollups } from '../apps/api/src/history-rollups.js';
export function qaDiagnostics(db:DB,fixture:AgentReport){
 const now=Date.now()/1000,node=createNode(db,{name:'诊断验收节点',group:'隔离诊断测试'},now-86400);
 db.prepare('INSERT INTO diagnostic_settings VALUES(?,?)').run(node.id,JSON.stringify({diagnostics:{enabled:true,services:[{manager:'systemd',name:'nginx.service'}]},workloads:{enabled:true,docker:true,processes:['nginx']}}));
 const report=structuredClone(fixture);report.source_id=crypto.randomUUID();report.capabilities={diagnostics:1,workloads:1,probes:1};report.applied_extensions_config_version=1;report.traffic=[];report.resources=[];report.totals=[];
 const stats=(v:number)=>({last:v,avg:v,max:v+1,count:2,seconds:60});
 for(let i=59;i>=0;i--){const at=Math.floor(now/60)*60-i*60,revision=1000-i;report.snapshot.observed_at=at;report.snapshot.revision=revision;report.diagnostics=[{minute_ts:at,revision,config_version:1,objects:[
 {object:'cpu',identity:'boot-a',observed_at:at,interval_seconds:5,status:'ok',values:{iowait_percent:stats(5+Math.sin(i/4)*3),steal_percent:stats(1)}},
 {object:'fs:/',identity:'filesystem-a',observed_at:at,interval_seconds:30,status:'ok',values:{total_bytes:stats(100*1024**3),used_bytes:stats(40*1024**3),used_percent:stats(40),inode_percent:stats(12)}},
 {object:'service:systemd:nginx.service',identity:'systemd:nginx.service',observed_at:at,interval_seconds:30,status:'ok',values:{running:stats(1)}},
 ]}];report.workloads=[{minute_ts:at,revision:revision+2000,config_version:1,objects:[{object:'process:nginx',identity:'nginx',observed_at:at,interval_seconds:30,status:'ok',values:{running:stats(1)}},{object:'container:web',identity:'a'.repeat(64),observed_at:at,interval_seconds:30,status:'ok',values:{cpu_percent:stats(12),memory_bytes:stats(128*1024**2),running:stats(1)}}]}];ingest(db,`Bearer ${node.token}`,report,now);}
 saveAsset(db,node.id,{...emptyAsset(),provider:'本地验收',currency:'CNY',price_minor:1500,expires_at:now+45*86400},0,now);processRollups(db,500);
 return node;
}
