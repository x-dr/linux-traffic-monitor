import { useState } from 'react';
import { Alert, Button, Form, Input, InputNumber, Select, Switch } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertRule, AlertRuleInput } from '@traffic/contracts';
import { client } from './api';
import { monitoring } from './monitoring-api';
import AlertScopeFields from './AlertScopeFields';

export const metricLabels = { offline: '节点离线', stale: '数据陈旧', cpu: 'CPU 高占用', memory: '内存高占用', disk_percent: '磁盘容量', disk_free: '磁盘剩余字节', bandwidth: '带宽使用率' };
export const ruleInput = (rule: AlertRule): AlertRuleInput => {
  const { id: _id, matched_nodes: _matched, ...input } = rule; return input;
};
const defaults: AlertRuleInput = { name: '节点离线', enabled: false, scope: { kind: 'all', node_ids: [], value: '' }, metric: 'offline', object: '',
  threshold: 120, duration_seconds: 0, recovery_threshold: 15, recovery_seconds: 30, severity: 'warning', channel_ids: [], repeat_seconds: 0 };
export default function AlertRuleEditor({ rule, onSaved }: { rule?: AlertRule; onSaved: () => void }) {
  const [form] = Form.useForm<AlertRuleInput>(), cache = useQueryClient();
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const nodes = useQuery({ queryKey: ['nodes'], queryFn: client.nodes });
  const channels = useQuery({ queryKey: ['channels'], queryFn: monitoring.channels });
  const metric = Form.useWatch('metric', form);
  const template = (value: AlertRuleInput['metric']) => form.setFieldsValue({ metric: value, name: metricLabels[value], object: value.startsWith('disk') ? '/' : '',
    threshold: ['offline', 'stale'].includes(value) ? 120 : value === 'disk_free' ? 5 * 1024 ** 3 : 90,
    duration_seconds: ['offline', 'stale'].includes(value) ? 0 : 300, recovery_threshold: ['offline', 'stale'].includes(value) ? 15 : value === 'disk_free' ? 6 * 1024 ** 3 : value === 'cpu' ? 80 : 85,
    recovery_seconds: ['offline', 'stale'].includes(value) ? 30 : 120 });
  const save = async (input: AlertRuleInput) => {
    setBusy(true); setError('');
    try { await monitoring.saveRule(input, rule?.id); await cache.invalidateQueries({ queryKey: ['rules'] }); onSaved(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Form form={form} layout="vertical" initialValues={rule ? ruleInput(rule) : defaults} onFinish={save}>
    {error && <Alert showIcon type="error" title={error} />}
    <Form.Item name="metric" label="规则模板" rules={[{ required: true }]}><Select onChange={template} options={Object.entries(metricLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
    <Form.Item name="name" label="规则名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input /></Form.Item>
    <AlertScopeFields nodes={nodes.data?.nodes ?? []} />
    <Form.Item name="object" label="挂载点" hidden={!metric?.startsWith('disk')} rules={metric?.startsWith('disk') ? [{ required: true, pattern: /^\// }] : []}><Input placeholder="/" /></Form.Item>
    <Form.Item name="bandwidth_mbps" label="带宽容量（Mbps）" hidden={metric !== 'bandwidth'} rules={metric === 'bandwidth' ? [{ required: true }] : []}><InputNumber min={.001} max={1000000} style={{ width: '100%' }} /></Form.Item>
    <div className="form-grid">
      <Form.Item name="threshold" label={['offline', 'stale'].includes(metric) ? '无新数据超过（秒）' : metric === 'disk_free' ? '剩余空间少于（字节）' : '使用率超过（%）'} rules={[{ required: true }]}><InputNumber min={0} max={Number.MAX_SAFE_INTEGER} style={{ width: '100%' }} /></Form.Item>
      <Form.Item name="duration_seconds" label="异常持续（秒）" rules={[{ required: true }]}><InputNumber min={0} max={86400} precision={0} style={{ width: '100%' }} /></Form.Item>
      <Form.Item name="recovery_threshold" label={metric === 'disk_free' ? '恢复剩余空间（字节）' : ['offline', 'stale'].includes(metric) ? '恢复数据年龄（1～15 秒）' : '恢复阈值'} rules={[{ required: true }]}><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
      <Form.Item name="recovery_seconds" label="恢复持续（秒）" rules={[{ required: true }]}><InputNumber min={0} max={86400} precision={0} style={{ width: '100%' }} /></Form.Item>
    </div>
    <Form.Item name="severity" label="严重级别"><Select options={[{ value: 'warning', label: '警告' }, { value: 'critical', label: '严重' }]} /></Form.Item>
    <Form.Item name="channel_ids" label="通知渠道" extra="不选渠道仍记录事件。通知渠道在系统设置管理。"><Select mode="multiple" options={channels.data?.channels.map(c => ({ value: c.id, label: c.name }))} /></Form.Item>
    <Form.Item name="repeat_seconds" label="重复提醒间隔（秒，0 为关闭）" rules={[{ required: true }]}><InputNumber min={0} max={604800} precision={0} style={{ width: '100%' }} /></Form.Item>
    <Form.Item name="enabled" label="启用规则" valuePropName="checked"><Switch /></Form.Item>
    <p className="muted">列表状态仍使用 15/45 秒。通知使用上方等待时间；资源缺失不会作为恢复依据。</p>
    <Button htmlType="submit" type="primary" loading={busy}>保存规则</Button>
  </Form>;
}
