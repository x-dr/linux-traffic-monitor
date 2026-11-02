import type { DiagnosticSettings, NodeAsset, RegistrationView, ReportJob, ReportJobInput, ReportRow, ReportRun, TelemetryHistory, TelemetryView } from '@traffic/contracts';
import { api } from './api';
const json=(method:string,body:unknown)=>({method,body:JSON.stringify(body)});
export const management={
  telemetry:(id:string,stream:string)=>api<TelemetryView>(`/nodes/${id}/${stream}`),
  history:(id:string,stream:string,minutes:number,object:string)=>api<TelemetryHistory>(`/nodes/${id}/${stream}-history?${new URLSearchParams({minutes:String(minutes),object,limit:'2000'})}`),
  settings:(id:string,settings:DiagnosticSettings,version:number)=>api(`/nodes/${id}/diagnostic-settings`,json('PUT',{...settings,expected_version:version})),
  asset:(id:string)=>api<{version:number;asset:NodeAsset}>(`/nodes/${id}/asset`),
  saveAsset:(id:string,asset:NodeAsset,version:number)=>api(`/nodes/${id}/asset`,json('PUT',{asset,expected_version:version})),
  tokens:()=>api<{tokens:RegistrationView[]}>('/registration-tokens'),
  createToken:(input:{name:string;group:string;expires_in:number;max_uses:number})=>api<{id:string;token:string;expires_at:number}>('/registration-tokens',json('POST',input)),
  revokeToken:(id:string)=>api(`/registration-tokens/${id}`,{method:'DELETE'}),
  jobs:()=>api<{jobs:ReportJob[]}>('/report-jobs'),
  saveJob:(job:ReportJobInput,id?:string,expected?:number)=>api(id?`/report-jobs/${id}`:'/report-jobs',json(id?'PUT':'POST',id?{job,expected_version:expected}:job)),
  preview:(job:ReportJobInput)=>api<{rows:ReportRow[]}>('/reports/preview',json('POST',job)),
  runs:(offset=0)=>api<{runs:ReportRun[]}>(`/report-runs?offset=${offset}`),
  run:()=>api('/report-jobs/run',{method:'POST'}),
  control:()=>api<{database_bytes:number;report_ms:number;report_max_ms:number;reports:number;scheduler_lag_ms:number;last_tick_at:number|null;notification_queue:{status:string;count:number}[];rollup_pending:number}>('/control-diagnostics'),
};
