import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Select, Switch } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProbeTask, ProbeTaskInput } from '@traffic/contracts';
import { client } from './api';
import { monitoring } from './monitoring-api';
import { probes, probeInput } from './probe-api';

export default function ProbeEditor({ task, node, onSaved }: { task?: ProbeTask; node?: string; onSaved: () => void }) {
  const [form] = Form.useForm<ProbeTaskInput>(), [busy, setBusy] = useState(false), { message } = App.useApp(), cache = useQueryClient();
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: client.nodes });
  const channels = useQuery({ queryKey: ['channels'], queryFn: monitoring.channels });
  const kind = Form.useWatch('kind', form) ?? task?.kind ?? 'http';
  const submit = async (input: ProbeTaskInput) => {
    setBusy(true);
    try { await probes.save({ ...input, port: input.kind === 'tcp' ? input.port : 0 }, task); await cache.invalidateQueries({ queryKey: ['probes'] }); message.success('探测任务已保存'); onSaved(); }
    catch (e) { message.error((e as Error).message); } finally { setBusy(false); }
  };
  return <Form form={form} layout="vertical" initialValues={task ? probeInput(task) : {
    name: '', kind: 'http', target: '', port: 443, family: 'ipv4', interval_seconds: 60, timeout_seconds: 3, node_ids: node ? [node] : [], enabled: false, channel_ids: [],
  }} onFinish={submit}>
    <Form.Item name="name" label="任务名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item>
    <Form.Item name="node_ids" label="执行节点" rules={[{ required: true, type: 'array', min: 1 }]}><Select mode="multiple" options={nodes.data?.nodes.filter(n => !n.archived).map(n => ({ value: n.id, label: n.name }))} /></Form.Item>
    <Form.Item name="kind" label="探测协议"><Select options={[{ value: 'http', label: 'HTTP / HTTPS' }, { value: 'tcp', label: 'TCP 连接' }, { value: 'icmp', label: 'ICMP Ping' }]} /></Form.Item>
    <Form.Item name="target" label="探测目标" extra={kind === 'http' ? '完整 HTTP(S) URL；不支持查询参数、凭据、请求体或自定义头。' : '填写主机名或 IP，不含端口。'} rules={[{ required: true, whitespace: true }]}><Input maxLength={2048} placeholder={kind === 'http' ? 'https://example.com/health' : 'example.com'} /></Form.Item>
    {kind === 'tcp' && <Form.Item name="port" label="目标端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} precision={0} /></Form.Item>}
    <Form.Item name="family" label="地址族"><Select options={[{ value: 'ipv4', label: 'IPv4' }, { value: 'ipv6', label: 'IPv6' }]} /></Form.Item>
    <div className="probe-form-row"><Form.Item name="interval_seconds" label="探测间隔（秒）" rules={[{ required: true }]}><InputNumber min={15} max={3600} precision={0} /></Form.Item><Form.Item name="timeout_seconds" label="单次超时（秒）" rules={[{ required: true }]}><InputNumber min={1} max={10} precision={0} /></Form.Item></div>
    <Form.Item name="channel_ids" label="探测通知渠道" extra="连续 3 次有效失败触发、2 次成功恢复；证书在 14/7/3 天提醒。留空仍记录事件。"><Select mode="multiple" options={channels.data?.channels.filter(c => c.enabled).map(c => ({ value: c.id, label: c.name }))} /></Form.Item>
    <Form.Item name="enabled" label="启用探测" valuePropName="checked"><Switch /></Form.Item>
    <p className="muted">每节点最多 10 项，并发 2。私网需在 Agent 本地配置允许网段；权限不足不会计为目标故障。</p>
    <Button htmlType="submit" type="primary" loading={busy} block>保存探测任务</Button>
  </Form>;
}
