import { useDrawerFocus } from './useDrawerFocus';
import { useState } from 'react';
import { Alert, Button, Drawer, Form, Input, Select, Switch } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NodeView, TrafficPolicyInput } from '@traffic/contracts';
import { monitoring } from './monitoring-api';
import { ErrorState } from './components';
import QuotaSummary from './QuotaSummary';
import './monitoring.css';

const units: Record<string, bigint> = { GB: 1000n ** 3n, TB: 1000n ** 4n, GiB: 1024n ** 3n, TiB: 1024n ** 4n };
type InputValues = Omit<TrafficPolicyInput, 'quota_bytes'> & { amount: string };
function toBytes(amount: string, unit: string) {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('额度须为正数');
  const [integer, fraction = ''] = amount.split('.'), divisor = 10n ** BigInt(fraction.length);
  const numerator = BigInt(integer + fraction) * units[unit];
  if (numerator % divisor !== 0n || numerator <= 0n) throw new Error('额度须能转换为正整数字节');
  const value = String(numerator / divisor); if (value.length > 30) throw new Error('额度超出允许范围'); return value;
}
function fromBytes(value: string, unit: string) {
  const divisor = units[unit], integer = BigInt(value) / divisor; let remainder = BigInt(value) % divisor, fraction = '';
  while (remainder && fraction.length < 40) { remainder *= 10n; fraction += String(remainder / divisor); remainder %= divisor; }
  return `${integer}${fraction ? `.${fraction}` : ''}`;
}
export default function TrafficPolicyPanel({ node }: { node: NodeView }) {
  const [open, setOpen] = useState(false);
  const rememberFocus = useDrawerFocus(open);
  const query = useQuery({ queryKey: ['quota', node.id], queryFn: () => monitoring.quota(node.id), refetchInterval: 15000 });
  return <section className="panel" aria-label="流量套餐"><div className="monitor-toolbar"><div><span className="section-kicker">TRAFFIC PLAN</span><h2>流量套餐</h2></div><Button type="primary" onClick={event => { rememberFocus(event.currentTarget); setOpen(true); }}>编辑套餐</Button></div>
    {query.isError && <ErrorState error={query.error} />}
    {query.data?.quota ? <QuotaSummary quota={query.data.quota} /> : <p className="muted">尚未配置套餐。原节点和全局总流量保持现有口径。</p>}
    <Drawer title="编辑流量套餐" open={open} size="min(560px, 100vw)" onClose={() => setOpen(false)} focusable={{ focusTriggerAfterClose: false }} destroyOnHidden>
      {open && <PolicyEditor node={node} onSaved={() => { setOpen(false); void query.refetch(); }} />}
    </Drawer>
  </section>;
}
function PolicyEditor({ node, onSaved }: { node: NodeView; onSaved: () => void }) {
  const [form] = Form.useForm<InputValues>(), cache = useQueryClient();
  const policyQuery = useQuery({ queryKey: ['policy', node.id], queryFn: () => monitoring.policy(node.id), staleTime: 0 });
  const channels = useQuery({ queryKey: ['channels'], queryFn: monitoring.channels });
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof monitoring.preview>> | null>(null);
  const [input, setInput] = useState<TrafficPolicyInput | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const calculate = async (values: InputValues) => {
    setBusy(true); setError('');
    try {
      const { amount, ...rest } = values;
      const input = { ...rest, quota_bytes: toBytes(amount, values.input_unit) };
      const result = await monitoring.preview(node.id, input); setInput(input); setPreview(result);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview || !input) return;
    setBusy(true); setError('');
    try {
      await monitoring.savePolicy(node.id, input, preview.policy_version, preview.config_version);
      await cache.invalidateQueries({ queryKey: ['policy', node.id] }); await cache.invalidateQueries({ queryKey: ['nodes'] }); onSaved();
    } catch (e) { setError((e as Error).message); setPreview(null); } finally { setBusy(false); }
  };
  if (policyQuery.isError) return <ErrorState error={policyQuery.error} />;
  if (policyQuery.isPending) return <p>正在加载套餐…</p>;
  const policy = policyQuery.data.policy;
  const interfaces = [...new Set([...(node.snapshot?.interfaces ?? []), ...(policy?.interfaces ?? [])])];
  return <Form form={form} layout="vertical" initialValues={policy ? { ...policy, amount: fromBytes(policy.quota_bytes, policy.input_unit) } : {
    enabled: false, amount: '1', input_unit: 'TiB', direction: 'tx', interfaces: node.snapshot?.selected_interfaces ?? [], thresholds: [80, 90, 100], channel_ids: [],
  }} onValuesChange={() => setPreview(null)} onFinish={calculate}>
    {error && <Alert type="error" showIcon title={error} />}
    <Form.Item name="enabled" label="启用套餐" valuePropName="checked"><Switch /></Form.Item>
    <div className="form-grid"><Form.Item name="amount" label="套餐额度" rules={[{ required: true, pattern: /^\d+(\.\d+)?$/, message: '填写正数' }]}><Input inputMode="decimal" maxLength={45} /></Form.Item><Form.Item name="input_unit" label="输入单位"><Select options={Object.keys(units).map(value => ({ value, label: value }))} /></Form.Item></div>
    <Form.Item name="direction" label="计费方向"><Select options={[{ value: 'tx', label: '上传' }, { value: 'rx', label: '下载' }, { value: 'sum', label: '上传 + 下载' }, { value: 'max', label: '周期上传与下载的较大值' }]} /></Form.Item>
    <Form.Item name="interfaces" label="计费网卡" rules={[{ required: true, type: 'array', min: 1 }]} extra="固定列表，Agent 监控网卡变化不会自动修改此套餐。"><Select mode="tags" options={interfaces.map(value => ({ value, label: value }))} /></Form.Item>
    <Form.Item name="thresholds" label="提醒阈值（%）"><Select mode="multiple" options={[80, 90, 100].map(value => ({ value, label: `${value}%` }))} /></Form.Item>
    <Form.Item name="channel_ids" label="额度通知渠道"><Select mode="multiple" options={channels.data?.channels.map(c => ({ value: c.id, label: c.name }))} /></Form.Item>
    <p className="muted">沿用节点月周期与 {node.config.timezone} 时区。保存新版本后最多提醒当前最高档位。</p>
    <Button htmlType="submit" loading={busy}>预览重算</Button>
    {preview && <div className="policy-preview" aria-label="套餐重算预览"><h3>重算预览</h3><QuotaSummary quota={preview.quota} /><Button type="primary" onClick={() => { void save(); }} loading={busy}>确认保存套餐</Button></div>}
  </Form>;
}
