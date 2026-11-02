import { useState } from 'react';
import { App, Alert, Button, Form, Input, InputNumber, Select, Space, Popconfirm, Tag } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import type { MonitorConfig, NodeView } from '@traffic/contracts';
import { client, api } from './api';
import type { QuotaView } from '@traffic/contracts';

export default function NodeSettings({ node }: { node: NodeView }) {
  const cache = useQueryClient(), { message, modal } = App.useApp();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const update = (updated: NodeView) => { cache.setQueryData(['node', node.id], updated); void cache.invalidateQueries({ queryKey: ['nodes'] }); };
  const save = async (values: { name: string; group: string; tags: string[]; interfaces: string; month_start_day: number; month_start_time: string; timezone: string }) => {
    setBusy(true); setError('');
    const config: MonitorConfig = { interfaces: values.interfaces.trim() === 'auto' ? 'auto' : values.interfaces.split(',').map(n => n.trim()).filter(Boolean), month_start_day: values.month_start_day, month_start_time: values.month_start_time, timezone: values.timezone };
    try {
      const calendarChanged = config.month_start_day !== node.config.month_start_day || config.month_start_time !== node.config.month_start_time || config.timezone !== node.config.timezone;
      if (calendarChanged) {
        const preview = await api<{ before: QuotaView | null; after: QuotaView | null }>(`/nodes/${node.id}/config/preview`, { method: 'POST', body: JSON.stringify(config) });
        if (preview.before && preview.after) {
          const before = preview.before, after = preview.after;
          const confirmed = await new Promise<boolean>(resolve => modal.confirm({ title: '计费周期重算预览',
            content: <div><p>原周期：{before.start} → {before.end}</p><p>原计费：{before.billed_bytes} 字节</p><p>新周期：{after.start} → {after.end}</p><p>新计费：{after.billed_bytes} 字节（{after.percent.toFixed(2)}%）</p><p>保存后套餐版本递增，并按当前最高档位重新提醒。</p></div>,
            okText: '确认修改周期', cancelText: '返回编辑', onOk: () => resolve(true), onCancel: () => resolve(false) }));
          if (!confirmed) return;
        }
      }
      await client.patchNode(node.id, { name: values.name, group: values.group || '', tags: values.tags || [] });
      const updated = await client.configure(node.id, config); update(updated);
      void cache.invalidateQueries({ queryKey: ['history', node.id] });
      message.success('配置已保存，等待 Agent 确认');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const patch = async (data: { enabled?: boolean; archived?: boolean }) => {
    try { update(await client.patchNode(node.id, data)); message.success('节点状态已更新'); }
    catch (e) { message.error((e as Error).message); }
  };
  const applied = node.applied_config_version === node.config_version;
  return <div className="settings-grid"><section className="panel"><div className="panel-heading"><h2>节点与监控配置</h2><Tag color={node.config_error ? 'error' : applied ? 'success' : 'processing'}>{node.config_error ? '应用失败' : applied ? '已应用' : '待应用'} · v{node.config_version}</Tag></div>{error && <Alert type="error" showIcon title={error} />}{node.config_error && <Alert type="warning" showIcon title={node.config_error} />}<Form layout="vertical" onFinish={save} initialValues={{ name: node.name, group: node.group, tags: node.tags, ...node.config, interfaces: node.config.interfaces === 'auto' ? 'auto' : node.config.interfaces.join(',') }}><div className="form-grid"><Form.Item name="name" label="节点名称" rules={[{ required: true, whitespace: true, max: 100 }]}><Input /></Form.Item><Form.Item name="group" label="分组"><Input maxLength={100} placeholder="例如：亚洲节点" /></Form.Item></div><Form.Item name="tags" label="标签"><Select mode="tags" tokenSeparators={[',']} maxCount={20} /></Form.Item><Alert type="info" showIcon title="采集网卡与计费网卡独立" description="修改监控网卡后，请在流量套餐中检查固定计费网卡；套餐不会自动跟随。" /><Form.Item name="interfaces" label="监控网卡" rules={[{ required: true }]} extra={`填写 auto 自动检测，或使用逗号分隔网卡名称。可见网卡：${node.snapshot?.interfaces.join(', ') || '等待 Agent 上报'}。避免同时选择 VPN 与底层物理接口。`}><Input placeholder="auto 或 ens3,eth1" /></Form.Item><div className="form-grid"><Form.Item name="month_start_day" label="每月起始日" rules={[{ required: true }]}><InputNumber min={1} max={31} precision={0} style={{ width: '100%' }} /></Form.Item><Form.Item name="month_start_time" label="起始时间" rules={[{ required: true, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: '使用 HH:MM 格式' }]}><Input type="time" /></Form.Item></div><Form.Item name="timezone" label="统计时区" rules={[{ required: true }]} extra="修改后依据保留的流量分钟记录重新划分周期；短月份自动使用最后一天。"><Input placeholder="Asia/Shanghai" /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>保存配置</Button></Form></section><section className="panel node-lifecycle"><span className="section-kicker">LIFECYCLE</span><h2>节点状态管理</h2><p className="muted">停用后暂停中心接收，归档后移出默认列表。两种操作都保留历史记录。</p><Space wrap><Popconfirm title={node.enabled ? '停用此节点？' : '启用此节点？'} description="历史记录会保留。" onConfirm={() => patch({ enabled: !node.enabled })}><Button>{node.enabled ? '停用节点' : '启用节点'}</Button></Popconfirm><Popconfirm title={node.archived ? '恢复此归档节点？' : '归档此节点？'} description="可在列表中筛选归档节点并恢复。" onConfirm={() => patch({ archived: !node.archived })}><Button danger={!node.archived}>{node.archived ? '恢复节点' : '归档节点'}</Button></Popconfirm></Space><div className="retention-note">节点 ID<br /><span className="mono small">{node.id}</span></div></section></div>;
}
