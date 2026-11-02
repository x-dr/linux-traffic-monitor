import type { AlertRuleInput, AlertValidity } from '../../../packages/contracts/src/index.js';
import type { DB } from './database.js';
import { telemetryView } from './telemetry-store.js';
const metrics: Record<string,{ object: string; key: string; stream?: 'workloads'; invert?: boolean }> = {
  iowait: { object:'cpu', key:'iowait_percent' }, steal:{ object:'cpu',key:'steal_percent' },
  psi_cpu:{ object:'psi:cpu',key:'some_avg10' }, psi_memory:{ object:'psi:memory',key:'some_avg10' }, psi_io:{ object:'psi:io',key:'some_avg10' },
  inode:{ object:'fs:/',key:'inode_percent' }, read_iops:{ object:'disk:vda',key:'read_iops' }, write_iops:{ object:'disk:vda',key:'write_iops' },
  service_down:{ object:'',key:'running',invert:true }, process_down:{ object:'',key:'running',stream:'workloads',invert:true },
};
export function telemetryReading(db: DB,node: string,rule: AlertRuleInput,now: number) {
  const metric=metrics[rule.metric];if (!metric) return null;
  const view=telemetryView(db,node,metric.stream??'diagnostics',now);
  const o=view.latest.find(o=>o.object===(rule.object||metric.object));
  const base={ observed:o?.observed_at??0, revision:o?.observed_at??0, maxGap:Math.max(15,(o?.interval_seconds??5)*3),identity:o?.identity??'' };
  let validity:AlertValidity='fresh';
  if (!view.supported||!view.enabled||o?.status==='unsupported') validity='unsupported';
  else if (!o || now-o.observed_at>base.maxGap || o.observed_at>now+5 || !['ok','absent'].includes(o.status) || view.applied_version!==view.config_version) validity='unknown';
  const value=o?.values[metric.key]?.last??null;
  if (value===null && validity==='fresh') validity='unknown';
  return {...base,validity,value:validity==='fresh'?(metric.invert?1-value!:value):null};
}
