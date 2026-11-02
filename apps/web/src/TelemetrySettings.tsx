import { useState } from 'react';
import { Alert, App, Button, Form, Input, Select, Switch } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { TelemetryView } from '@traffic/contracts';
import { management } from './management-api';
export default function TelemetrySettings({id,view,stream}:{id:string;view:TelemetryView;stream:'diagnostics'|'workloads'}){
  const {message}=App.useApp(),cache=useQueryClient();const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [version,setVersion]=useState(view.config_version);
  const save=async(values:{enabled:boolean;services:string;manager:'systemd'|'openrc';docker:boolean;processes:string})=>{
    setBusy(true);setError('');try{
      const settings=structuredClone(view.settings),names=(value:string)=>(value||'').split(/[\s,]+/).filter(Boolean);
      if(stream==='diagnostics')settings.diagnostics={enabled:values.enabled,services:names(values.services).map(name=>({manager:values.manager,name}))};
      else settings.workloads={enabled:values.enabled,docker:values.docker,processes:names(values.processes)};
      await management.settings(id,settings,version);setVersion(version+1);await cache.invalidateQueries({queryKey:['telemetry',id]});message.success('已保存，等待 Agent 确认');
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  return <section className="panel"><h2>{stream==='diagnostics'?'诊断采集配置':'容器与进程配置'}</h2>
    {error&&<Alert showIcon type="error" title={error}/>}
    <Form name={`telemetry-${id}-${stream}`} layout="vertical" onFinish={save} initialValues={{enabled:view.settings[stream].enabled,services:view.settings.diagnostics.services.map(s=>s.name).join('\n'),manager:view.settings.diagnostics.services[0]?.manager??'systemd',docker:view.settings.workloads.docker,processes:view.settings.workloads.processes.join('\n')}}>
      <Form.Item name="enabled" label="启用采集" valuePropName="checked"><Switch/></Form.Item>
      {stream==='diagnostics'?<><Form.Item name="manager" label="服务管理器"><Select options={[{value:'systemd',label:'systemd'},{value:'openrc',label:'OpenRC'}]}/></Form.Item><Form.Item name="services" label="服务白名单（最多 10 项）" extra="每行一个服务名，例如 nginx.service。只查询运行状态。"><Input.TextArea rows={3} maxLength={1010}/></Form.Item></>:<><Form.Item name="docker" label="Docker 监控" valuePropName="checked" extra="需在 Agent 本地配置 docker_proxy_url，指向受限的本机只读 API 代理。"><Switch/></Form.Item><Form.Item name="processes" label="进程名称白名单（最多 20 项）" extra="每行一个精确名称。展示 RSS 最高的 10 个匹配进程；CPU 可超过 100%。"><Input.TextArea rows={3} maxLength={2020}/></Form.Item></>}
      <Button type="primary" htmlType="submit" loading={busy}>保存采集配置</Button>
    </Form>
  </section>;
}
