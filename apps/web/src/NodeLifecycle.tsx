import { useState } from 'react';
import { Alert, App, Button, Modal, Popconfirm, Space } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { NodeView } from '@traffic/contracts';
import { client } from './api';

export default function NodeLifecycle({ node, onChange }: { node: NodeView; onChange: (node: NodeView) => void }) {
  const cache = useQueryClient(), navigate = useNavigate(), { message } = App.useApp();
  const [open, setOpen] = useState(false), [deleting, setDeleting] = useState(false), [error, setError] = useState('');
  const patch = async (data: { enabled?: boolean; archived?: boolean }) => {
    try { onChange(await client.patchNode(node.id, data)); message.success('节点状态已更新'); }
    catch (e) { message.error((e as Error).message); }
  };
  const remove = async () => {
    if (deleting) return;
    setDeleting(true); setError('');
    try {
      await client.deleteNode(node.id);
      await cache.cancelQueries({ predicate: query => query.queryKey.includes(node.id) });
      cache.setQueryData<{ nodes: NodeView[] }>(['nodes'], previous => previous ? { nodes: previous.nodes.filter(n => n.id !== node.id) } : previous);
      navigate('/nodes', { replace: true });
      cache.removeQueries({ predicate: query => query.queryKey.includes(node.id) });
      void cache.invalidateQueries({ predicate: query => !query.queryKey.includes(node.id) });
      message.success('节点已删除');
    } catch (e) { setError((e as Error).message); }
    finally { setDeleting(false); }
  };
  return <section className="panel node-lifecycle">
    <span className="section-kicker">LIFECYCLE</span><h2>节点状态管理</h2>
    <p className="muted">停用后暂停中心接收，归档后移出默认列表。两种操作都保留历史记录。</p>
    <Space wrap>
      <Popconfirm title={node.enabled ? '停用此节点？' : '启用此节点？'} description="历史记录会保留。" onConfirm={() => patch({ enabled: !node.enabled })}>
        <Button disabled={deleting}>{node.enabled ? '停用节点' : '启用节点'}</Button>
      </Popconfirm>
      <Popconfirm title={node.archived ? '恢复此归档节点？' : '归档此节点？'} description="可在列表中筛选归档节点并恢复。" onConfirm={() => patch({ archived: !node.archived })}>
        <Button danger={!node.archived} disabled={deleting}>{node.archived ? '恢复节点' : '归档节点'}</Button>
      </Popconfirm>
    </Space>
    <div className="retention-note">
      <p>永久删除会清除中心端节点及关联数据，无法恢复。</p>
      <Button danger disabled={deleting} onClick={() => { setError(''); setOpen(true); }}>删除节点</Button>
    </div>
    <div className="retention-note">节点 ID<br /><span className="mono small">{node.id}</span></div>
    <Modal title="永久删除节点？" open={open} onCancel={() => setOpen(false)} onOk={remove}
      okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} confirmLoading={deleting}
      cancelButtonProps={{ disabled: deleting }} closable={!deleting} keyboard={!deleting} mask={{ closable: false }}>
      <p>即将永久删除节点「{node.name}」。</p>
      <p>该节点的历史记录、告警、通知、资产和探测记录将被清除，历史报表中的该节点数据也会移除。此操作无法恢复。</p>
      <p>原 Agent 令牌立即失效。请自行停止或卸载该服务器上的 Agent。</p>
      {error && <Alert type="error" showIcon title={`删除失败：${error}`} />}
    </Modal>
  </section>;
}
