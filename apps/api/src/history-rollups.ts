import type { ResourceMinute, TelemetryMinute, TelemetryObject, TelemetryStats } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
type ResourceValues = ResourceMinute['values'];
export function mergeResources(values: ResourceValues[]): ResourceValues | null {
  if (!values.length) return null;
  const result=structuredClone(values[0]);
  for(const row of values.slice(1)) for(const key of Object.keys(result) as (keyof ResourceValues)[]) {
    const a=result[key],b=row[key];const count=a.count+b.count;
    result[key]={ count,avg:count?((a.avg??0)*a.count+(b.avg??0)*b.count)/count:null,max:a.max===null?b.max:b.max===null?a.max:Math.max(a.max,b.max) };
  }
  return result;
}
export function mergeTelemetry(objects: TelemetryObject[]): TelemetryObject | null {
  if (!objects.length) return null;
  const result=structuredClone(objects.at(-1)!);result.values={};
  for(const o of objects) for(const [key,b] of Object.entries(o.values)) {
    const a=result.values[key];if (!a) { result.values[key]=structuredClone(b);continue; }
    const count=a.count+b.count,seconds=a.seconds+b.seconds;
    const weight=seconds>0?seconds:count;
    const aw=seconds>0?a.seconds:a.count,bw=seconds>0?b.seconds:b.count;
    result.values[key]={last:b.last,count,seconds,avg:weight?((a.avg??0)*aw+(b.avg??0)*bw)/weight:null,
      max:a.max===null?b.max:b.max===null?a.max:Math.max(a.max,b.max)};
  }
  return result;
}
type DiskAggregate={read_bytes:string;write_bytes:string;observed_seconds:number};
function mergeDisks(rows: DiskAggregate[]): DiskAggregate {
  return {read_bytes:String(rows.reduce((v,r)=>v+BigInt(r.read_bytes),0n)),write_bytes:String(rows.reduce((v,r)=>v+BigInt(r.write_bytes),0n)),observed_seconds:rows.reduce((v,r)=>v+r.observed_seconds,0)};
}
function saveBucket(db: DB,node: string,domain: string,bucket: number,step: number,objects: Map<string,unknown[]>) {
  db.prepare('DELETE FROM history_rollups WHERE node_id=? AND domain=? AND bucket=? AND step=?').run(node,domain,bucket,step);
  for(const [object,values] of objects) {
    const data=domain==='resource'?mergeResources(values as ResourceValues[]):domain==='disk'?mergeDisks(values as DiskAggregate[]):mergeTelemetry(values as TelemetryObject[]);
    if(data) db.prepare('INSERT INTO history_rollups VALUES(?,?,?,?,?,?)').run(node,domain,object,step,bucket,JSON.stringify(data));
  }
}
export function processRollups(db: DB,limit=100) {
  const dirty=db.prepare('SELECT * FROM rollup_dirty ORDER BY bucket LIMIT ?').all(limit) as {node_id:string;domain:string;bucket:number}[];
  db.transaction(()=>{for(const {node_id:node,domain,bucket} of dirty) {
    const objects=new Map<string,unknown[]>();
    const add=(key:string,v:unknown)=>objects.set(key,[...objects.get(key)??[],v]);
    if(domain==='resource') for(const row of db.prepare('SELECT metrics FROM resource_minutes WHERE node_id=? AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts').all(node,bucket,bucket+3600) as {metrics:string}[]) add('',JSON.parse(row.metrics));
    else if(domain==='disk') for(const row of db.prepare('SELECT device,CAST(read_bytes AS TEXT) read_bytes,CAST(write_bytes AS TEXT) write_bytes,observed_seconds FROM disk_minutes WHERE node_id=? AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts').all(node,bucket,bucket+3600) as (DiskAggregate&{device:string})[]) add(row.device,row);
    else for(const row of db.prepare('SELECT data FROM telemetry_minutes WHERE node_id=? AND stream=? AND minute_ts>=? AND minute_ts<? ORDER BY minute_ts').all(node,domain,bucket,bucket+3600) as {data:string}[]) for(const o of (JSON.parse(row.data) as TelemetryMinute).objects) add(`${o.object}@${o.identity}`,o);
    saveBucket(db,node,domain,bucket,3600,objects);
    const day=Math.floor(bucket/86400)*86400,daily=new Map<string,unknown[]>();
    for(const row of db.prepare('SELECT object,data FROM history_rollups WHERE node_id=? AND domain=? AND step=3600 AND bucket>=? AND bucket<? ORDER BY bucket').all(node,domain,day,day+86400) as {object:string;data:string}[]) daily.set(row.object,[...daily.get(row.object)??[],JSON.parse(row.data)]);
    saveBucket(db,node,domain,day,86400,daily);
    db.prepare('DELETE FROM rollup_dirty WHERE node_id=? AND domain=? AND bucket=?').run(node,domain,bucket);
  }})();return dirty.length;
}
export function pruneRollups(db: DB,now: number) {
  db.prepare('DELETE FROM history_rollups WHERE (step=3600 AND bucket<?) OR (step=86400 AND bucket<?)').run(now-366*86400,now-3*366*86400);
}
export function rollupResources(db: DB,node: string,start:number,end:number,step:number) {
  return db.prepare("SELECT bucket ts,data FROM history_rollups WHERE node_id=? AND domain='resource' AND step=? AND bucket>=? AND bucket<? ORDER BY bucket").all(node,step,start,end) as {ts:number;data:string}[];
}
