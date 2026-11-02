import { useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Select } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeAsset as Asset } from '@traffic/contracts';
import { management } from './management-api';
import { monitoring } from './monitoring-api';
import { ErrorState, LoadingState } from './components';
export default function NodeAsset({id}:{id:string}){
  const query=useQuery({queryKey:['asset',id],queryFn:()=>management.asset(id)});
  if(query.isPending)return <LoadingState/>;if(query.isError)return <ErrorState error={query.error}/>;
  return <AssetForm key={id} id={id} initial={query.data.asset} initialVersion={query.data.version}/>;
}
function AssetForm({id,initial,initialVersion}:{id:string;initial:Asset;initialVersion:number}){
  const {message}=App.useApp(),cache=useQueryClient(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[version,setVersion]=useState(initialVersion);
  const channels=useQuery({queryKey:['channels'],queryFn:monitoring.channels});
  const save=async(value:Omit<Asset,'expires_at'>&{expires_at:string})=>{
    const expires=value.expires_at?Date.parse(value.expires_at)/1000:null;
    if(expires!==null&&!Number.isFinite(expires)){setError('到期时间无效');return;}
    setBusy(true);setError('');try{await management.saveAsset(id,{...value,expires_at:expires,bandwidth_mbps:value.bandwidth_mbps??null},version);setVersion(version+1);await cache.invalidateQueries({queryKey:['asset',id]});message.success('资产已保存，到期提醒已重算');}catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const localInput=initial.expires_at===null?'':new Date(initial.expires_at*1000-new Date(initial.expires_at*1000).getTimezoneOffset()*60000).toISOString().slice(0,16);
  return <section className="panel"><h2>资产与到期</h2>{error&&<Alert type="error" showIcon title={error}/>}<Form name={`asset-${id}`} layout="vertical" onFinish={save} initialValues={{...initial,expires_at:localInput}}>
    <div className="form-grid"><Form.Item label="供应商" name="provider"><Input maxLength={100}/></Form.Item><Form.Item label="地区" name="region"><Input maxLength={100}/></Form.Item><Form.Item label="IP 地址" name="ip"><Input maxLength={100}/></Form.Item><Form.Item label="带宽容量（Mbps）" name="bandwidth_mbps"><InputNumber min={0} max={1e7} style={{width:'100%'}}/></Form.Item>
    <Form.Item label="价格（最小货币单位整数）" name="price_minor" rules={[{required:true}]}><InputNumber min={0} max={Number.MAX_SAFE_INTEGER} precision={0} style={{width:'100%'}}/></Form.Item><Form.Item label="币种（ISO 代码）" name="currency" rules={[{required:true,pattern:/^[A-Z]{3}$/}]}><Input maxLength={3}/></Form.Item><Form.Item label="账期（月）" name="billing_months" rules={[{required:true}]}><InputNumber min={1} max={120} precision={0}/></Form.Item><Form.Item label="到期时间（浏览器本地时区）" name="expires_at"><Input type="datetime-local"/></Form.Item></div>
    <Form.Item name="note" label="备注"><Input.TextArea rows={3} maxLength={2000}/></Form.Item><Form.Item label="到期提醒渠道" name="channel_ids"><Select mode="multiple" options={channels.data?.channels.map(c=>({value:c.id,label:c.name}))}/></Form.Item><p className="muted">到期前 30 / 7 / 1 天去重提醒；修改后重算并合并当前最高档。不同币种分别统计。</p><Button htmlType="submit" type="primary" loading={busy}>保存资产</Button>
  </Form></section>;
}
