import { Form, Input, Select } from 'antd';
import type { NodeView } from '@traffic/contracts';

export default function AlertScopeFields({ nodes }: { nodes: NodeView[] }) {
  const form = Form.useFormInstance(), kind = Form.useWatch(['scope', 'kind'], form);
  const ids = Form.useWatch(['scope', 'node_ids'], form) as string[] | undefined;
  const value = Form.useWatch(['scope', 'value'], form) as string | undefined;
  const matched = nodes.filter(n => n.enabled && !n.archived && (kind === 'all' || (kind === 'nodes' && ids?.includes(n.id)) || (kind === 'group' && n.group === value) || (kind === 'tag' && n.tags.includes(value ?? ''))));
  return <>
    <Form.Item name={['scope', 'kind']} label="节点范围" rules={[{ required: true }]}><Select options={[
      { value: 'all', label: '全部启用节点' }, { value: 'nodes', label: '指定节点' }, { value: 'group', label: '分组' }, { value: 'tag', label: '标签' },
    ]} /></Form.Item>
    <Form.Item name={['scope', 'node_ids']} label="指定节点" hidden={kind !== 'nodes'} rules={kind === 'nodes' ? [{ required: true, type: 'array', min: 1 }] : []}><Select mode="multiple" options={nodes.map(n => ({ value: n.id, label: n.name }))} /></Form.Item>
    <Form.Item name={['scope', 'value']} label="分组或标签" hidden={!['group', 'tag'].includes(kind)} rules={['group', 'tag'].includes(kind) ? [{ required: true, whitespace: true }] : []}><Input maxLength={100} /></Form.Item>
    <p className="muted scope-preview" role="status">匹配 {matched.length} 台：{matched.map(n => n.name).join('、') || '无匹配节点'}</p>
  </>;
}
