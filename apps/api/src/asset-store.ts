import type { NodeAsset } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { findNode } from './nodes.js';
import { eventById, newEvent, nodeEvent, validateChannels } from './alert-store.js';
import { enqueue } from './notification-queue.js';
import { httpError } from './auth.js';
export const emptyAsset = ():NodeAsset=>({provider:'',region:'',ip:'',note:'',price_minor:0,currency:'USD',billing_months:1,expires_at:null,bandwidth_mbps:null,channel_ids:[]});
export function nodeAsset(db:DB,node:string){findNode(db,node);const row=db.prepare('SELECT version,config FROM node_assets WHERE node_id=?').get(node) as {version:number;config:string}|undefined;return {version:row?.version??0,asset:row?JSON.parse(row.config) as NodeAsset:emptyAsset()};}
export function saveAsset(db:DB,node:string,asset:NodeAsset,expected:number,now:number){
  validateChannels(db,asset.channel_ids);const old=nodeAsset(db,node);if(old.version!==expected)throw httpError(409,'资产已改变，请刷新后重试');
  db.transaction(()=>{
    db.prepare(`UPDATE notification_outbox SET status='cancelled' WHERE event_id IN (SELECT id FROM alert_events WHERE node_id=? AND kind='asset_expiry') AND status IN ('pending','suppressed','sending')`).run(node);
    db.prepare("UPDATE alert_events SET state='closed',resolved_at=?,close_reason='资产配置变更' WHERE node_id=? AND kind='asset_expiry' AND state='firing'").run(now,node);
    db.prepare('INSERT INTO node_assets VALUES(?,?,?) ON CONFLICT(node_id) DO UPDATE SET version=excluded.version,config=excluded.config').run(node,old.version+1,JSON.stringify(asset));
    nodeEvent(db,node,'asset_changed',now,'资产与到期资料更新');evaluateAssets(db,now,node);
  })();return nodeAsset(db,node);
}
export function evaluateAssets(db:DB,now:number,node?:string){
  const rows=db.prepare('SELECT a.* FROM node_assets a JOIN nodes n ON n.id=a.node_id WHERE n.enabled=1 AND n.archived=0 AND (? IS NULL OR a.node_id=?)').all(node??null,node??null) as {node_id:string;version:number;config:string}[];
  db.transaction(()=>{for(const row of rows){
    const asset=JSON.parse(row.config) as NodeAsset;if(asset.expires_at===null)continue;
    const days=(asset.expires_at-now)/86400;
    const crossed=[30,7,1].filter(t=>days<=t&&!db.prepare('SELECT 1 FROM asset_threshold_events WHERE node_id=? AND version=? AND threshold=?').get(row.node_id,row.version,t));
    if(!crossed.length)continue;const threshold=Math.min(...crossed);
    const event=newEvent(db,{node_id:row.node_id,rule_id:null,kind:'asset_expiry',title:`资产将在 ${Math.max(0,Math.ceil(days))} 天内到期`,severity:threshold===1?'critical':'warning',object:`asset:${row.version}`,state:'firing',validity:'fresh',first_anomaly_at:now,fired_at:now,last_anomaly_at:now,value:Math.max(0,days),threshold,detail:`到期时间 ${new Date(asset.expires_at*1000).toISOString()}；请人工核对续费`});
    for(const tier of crossed)db.prepare('INSERT INTO asset_threshold_events VALUES(?,?,?,?)').run(row.node_id,row.version,tier,event.id);
    enqueue(db,eventById(db,event.id),asset.channel_ids,'trigger',now);
  }})();
}
