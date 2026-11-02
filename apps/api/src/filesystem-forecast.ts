import type { TelemetryObject } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { telemetryView } from './telemetry-store.js';
export function filesystemForecasts(db:DB,node:string,now:number){
 const view=telemetryView(db,node,'diagnostics',now),today=Math.floor(now/86400)*86400;
 return view.latest.filter(o=>o.object.startsWith('fs:')).map(latest=>{
  const base={object:latest.object,full_at:null as number|null,days:0,reason:'至少需要 3 个连续完整日且覆盖率 ≥95% 的同一文件系统数据'};
  if(!view.enabled||!latest.fresh)return {...base,reason:'当前容量样本不可用或陈旧'};
  const rows=db.prepare("SELECT bucket,data FROM history_rollups WHERE node_id=? AND domain='diagnostics' AND step=86400 AND bucket>=? AND bucket<? ORDER BY bucket DESC").all(node,today-7*86400,today) as {bucket:number;data:string}[];
  const days:{ts:number;used:number;total:number}[]=[];let expected=today-86400;
  for(const row of rows){const o=JSON.parse(row.data) as TelemetryObject;if(o.object!==latest.object)continue;
   if(row.bucket!==expected||o.identity!==latest.identity||o.values.used_bytes?.last===null||(o.values.used_bytes?.seconds??0)<.95*86400)break;
   const total=o.values.total_bytes?.last,used=o.values.used_bytes?.last;if(total==null||used==null)break;
   days.push({ts:row.bucket,used,total});expected-=86400;
  }
  days.reverse();
  const total=latest.values.total_bytes?.last,used=latest.values.used_bytes?.last;
  if(total==null||used==null||days.length<3)return base;
  let start=0;for(let i=0;i<days.length;i++)if(days[i].total!==total||(i>0&&days[i].used<days[i-1].used*.95))start=i+1;
  if(used<days.at(-1)!.used*.95)start=days.length;
  const valid=days.slice(start);if(valid.length<3)return {...base,reason:'扩容、更换文件系统或大规模清理后，等待重新建立 3 天趋势'};
  const meanTime=valid.reduce((sum,d)=>sum+d.ts,0)/valid.length,meanUsed=valid.reduce((sum,d)=>sum+d.used,0)/valid.length;
  const slope=valid.reduce((sum,d)=>sum+(d.ts-meanTime)*(d.used-meanUsed),0)/valid.reduce((sum,d)=>sum+(d.ts-meanTime)**2,0);
  if(used>=total)return {...base,full_at:now,days:valid.length,reason:'已达到容量上限'};
  if(slope<=0)return {...base,days:valid.length,reason:'近期没有稳定增长，无法估算写满时间'};
  return {...base,full_at:now+(total-used)/slope,days:valid.length,reason:'基于已收到记录的线性估算；UTC 完整日，不用于自动操作'};
 });
}
