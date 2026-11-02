import { useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { management } from './management-api';
import { date } from './format';
import { ErrorState } from './components';
export default function RegistrationSettings(){
  const {message}=App.useApp(),[busy,setBusy]=useState(false),[secret,setSecret]=useState<{id:string;token:string;expires_at:number}|null>(null);
  const query=useQuery({queryKey:['registration-tokens'],queryFn:management.tokens,refetchInterval:10000});
  const create=async(values:{name:string;group:string;expires_in:number;max_uses:number})=>{setBusy(true);try{setSecret(await management.createToken(values));await query.refetch();}catch(e){message.error((e as Error).message);}finally{setBusy(false);}};
  return <section className="panel"><h2>批量接入</h2><p className="muted">短期凭据只用于换取每节点独立凭据。令牌只显示一次，请在安装工具的隐藏提示中输入。</p>
    <Form name="registration-token" layout="vertical" onFinish={create} initialValues={{name:'批量接入',group:'',expires_in:3600,max_uses:10}}><div className="form-grid"><Form.Item label="凭据名称" name="name" rules={[{required:true,whitespace:true}]}><Input maxLength={100}/></Form.Item><Form.Item label="节点分组" name="group"><Input maxLength={100}/></Form.Item><Form.Item label="有效秒数" name="expires_in" rules={[{required:true}]}><InputNumber min={300} max={86400} precision={0}/></Form.Item><Form.Item label="最多节点数" name="max_uses" rules={[{required:true}]}><InputNumber min={1} max={50} precision={0}/></Form.Item></div><Button type="primary" htmlType="submit" loading={busy}>创建短期凭据</Button></Form>
    {secret&&<Alert showIcon type="success" title="请安全保存此次凭据" description={<><p>注册 ID：<code>{secret.id}</code></p><Input.Password value={secret.token} readOnly aria-label="一次性显示注册令牌" autoComplete="off"/><p>到期：{date(secret.expires_at)}</p><Button onClick={()=>setSecret(null)}>隐藏并清除</Button></>}/>}
    <p><a href="/downloads/agent/install-agent.py" download>下载安装脚本</a> 并检查后，填写中心地址与注册 ID 即可预览；脚本自动从中心下载对应架构的 Agent 并校验 SHA256。添加 <code>--apply</code> 安装，已有数据目录会停止安装。</p>
    <pre>{`python3 install-agent.py --server ${window.location.origin} --registration-id ${secret?.id ?? '<注册ID>'}`}</pre>
    {query.isError&&<ErrorState error={query.error}/>}<div className="monitor-cards">{query.data?.tokens.map(token=><article className="monitor-card" key={token.id}><strong>{token.name}</strong><p>{token.group||'未分组'} · {token.uses}/{token.max_uses} 次 · 到期 {date(token.expires_at)}</p><Button disabled={!!token.revoked} onClick={()=>{void management.revokeToken(token.id).then(()=>query.refetch()).catch(e=>message.error((e as Error).message));}}>{token.revoked?'已撤销':'撤销凭据'}</Button></article>)}</div>
  </section>;
}
