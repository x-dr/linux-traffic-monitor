import { useState } from 'react';
import { Alert, App, Button, Form, Input, Select, Steps, Typography } from 'antd';
import { CheckCircleOutlined, CopyOutlined, DownloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { NodeView } from '@traffic/contracts';
import { api } from './api';
import { PageTitle } from './components';

export default function ConnectPage() {
  const [created, setCreated] = useState<{ node: NodeView; token: string }>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cache = useQueryClient(), { message } = App.useApp();
  const create = async (values: { name: string; group?: string; tags?: string[] }) => {
    setBusy(true); setError('');
    try { setCreated(await api('/nodes', { method: 'POST', body: JSON.stringify(values) })); void cache.invalidateQueries({ queryKey: ['nodes'] }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const config = created ? JSON.stringify({ server_url: window.location.origin, token: created.token, data_dir: '/var/lib/trafficmon-agent', settings: created.node.config, applied_config_version: 0 }, null, 2) : '';
  const download = () => {
    const url = URL.createObjectURL(new Blob([config + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'agent.json'; link.click(); URL.revokeObjectURL(url);
  };
  return <><PageTitle eyebrow="CONNECT YOUR INFRASTRUCTURE" title="接入新的 VPS" subtitle="安装轻量 Agent，通过 HTTPS 主动上报，无需开放额外入站端口。" /><Steps current={created ? 1 : 0} items={[{ title: '创建节点' }, { title: '安装 Agent' }, { title: '验证连接' }]} /><div className="connect-grid"><section className="panel">{!created ? <><span className="section-kicker">STEP 01 · IDENTITY</span><h2>定义你的服务器</h2><p className="muted">名称与分组可随时修改，凭据与节点一一对应。</p>{error && <Alert showIcon type="error" title={error} />}<Form layout="vertical" onFinish={create}><Form.Item name="name" label="节点名称" rules={[{ required: true, whitespace: true, max: 100, message: '请输入节点名称（最多 100 字）' }]}><Input placeholder="例如：东京 · 主服务器" size="large" /></Form.Item><Form.Item name="group" label="分组"><Input maxLength={100} placeholder="例如：亚洲节点" /></Form.Item><Form.Item name="tags" label="标签"><Select mode="tags" maxCount={20} tokenSeparators={[',']} placeholder="输入标签后按回车" /></Form.Item><Button type="primary" size="large" htmlType="submit" loading={busy}>创建节点并生成配置</Button></Form></> : <><div className="success-heading"><CheckCircleOutlined /><h2>{created.node.name} 已创建</h2></div><Alert showIcon type="warning" title="请保存节点配置" description="凭据仅在本次创建时展示，离开页面后无法再次查看。配置文件含敏感凭据，请仅保存到对应 VPS。" /><div className="credential-block"><div className="panel-heading"><h3>Agent 配置</h3><Button icon={<DownloadOutlined />} onClick={download}>下载配置</Button></div><pre>{config}</pre><Button icon={<CopyOutlined />} onClick={() => { void navigator.clipboard.writeText(config).then(() => message.success('配置已复制')).catch(() => message.error('复制失败，请下载配置文件')); }}>复制配置</Button></div><div className="connect-actions"><Link to={`/nodes/${created.node.id}`}><Button type="primary">查看节点与连接状态</Button></Link><Button onClick={() => setCreated(undefined)}>继续接入下一台</Button></div></>}</section><section className="panel installation-panel"><span className="section-kicker">DEPLOYMENT GUIDE</span><h2>在 VPS 上启动 Agent</h2><ol><li><strong>准备程序与配置</strong><p>从中心下载 <a href="/downloads/agent/traffic-agent-linux-amd64" download>Linux amd64</a> 或 <a href="/downloads/agent/traffic-agent-linux-arm64" download>Linux arm64</a> 程序，使用 <a href="/downloads/agent/SHA256SUMS" download>SHA256SUMS</a> 校验。将下载的配置保存到 VPS 的 <code>/etc/trafficmon/agent.json</code>。</p></li><li><strong>限制配置权限</strong><pre>chmod 600 /etc/trafficmon/agent.json</pre></li><li><strong>验证一次上报</strong><pre>traffic-agent run --config /etc/trafficmon/agent.json --once</pre></li><li><strong>设为常驻服务</strong><p>按项目部署文档安装 Agent systemd 服务，首次上报后即可在详情页查看数据。</p></li></ol><Alert showIcon icon={<SafetyCertificateOutlined />} type="info" title="部署要求" description="中心地址应使用 HTTPS。迁移旧版时请先停止旧采集服务，通过 migrate 命令将历史复制到新数据目录。" /><Typography.Paragraph className="muted small">详细步骤见项目 docs/operations.md。中心和 Agent 使用独立数据目录，旧历史可完整保留。</Typography.Paragraph></section></div></>;
}
