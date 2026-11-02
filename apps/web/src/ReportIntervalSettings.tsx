import { useState } from 'react';
import { Alert, App, Button, Form, Select, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reportIntervalOptions, type ReportInterval, type ReportingView } from '@traffic/contracts';
import { api } from './api';
import { ErrorState, LoadingState } from './components';

export default function ReportIntervalSettings({ id }: { id: string }) {
  const cache = useQueryClient(), { message } = App.useApp();
  const query = useQuery({ queryKey: ['reporting', id], queryFn: () => api<ReportingView>(`/nodes/${id}/reporting`), refetchInterval: 3000 });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [draft, setDraft] = useState<{ interval: ReportInterval; version: number } | null>(null);
  const view = query.data;
  const save = async () => {
    if (!view) return;
    setBusy(true); setError('');
    try {
      const updated = await api<ReportingView>(`/nodes/${id}/reporting`, { method: 'PUT', body: JSON.stringify({
        interval_seconds: draft?.interval ?? view.interval_seconds, expected_version: draft?.version ?? view.config_version,
      }) });
      cache.setQueryData(['reporting', id], updated); setDraft(null);
      await cache.invalidateQueries({ queryKey: ['nodes'] });
      await cache.invalidateQueries({ queryKey: ['node', id] });
      message.success('上报间隔已保存，等待 Agent 确认');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const status = !view?.supported ? '需升级 Agent' : view.error ? '应用失败' : view.applied_version === view.config_version ? '已应用' : '待应用';
  return <section className="panel" aria-label="Agent 上报设置">
    <div className="panel-heading"><h2>Agent 上报设置</h2><Tag color={!view?.supported ? 'default' : view.error ? 'error' : status === '已应用' ? 'success' : 'processing'}>{status}</Tag></div>
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} /> : view && <>
      {error && <Alert type="error" showIcon title={error} />}
      {view.error && <Alert type="warning" showIcon title="上报设置应用失败，请检查 Agent 配置文件是否可写" />}
      {!view.supported && <Alert type="info" showIcon title="等待支持可配置上报间隔的 Agent 接入" description="配置可先保存，升级后的 Agent 连接后自动应用。旧版 Agent 仍每 5 秒上报。" />}
      <Form name={`reporting-${id}`} layout="vertical" onFinish={save}>
        <Form.Item label="上报间隔" htmlFor={`report-interval-${id}`} extra="网络每 1 秒采样，资源每 5 秒采样；本选项控制数据发送到中心的频率。">
          <Select id={`report-interval-${id}`} value={draft?.interval ?? view.interval_seconds} disabled={busy} virtual={false}
            options={reportIntervalOptions.map(value => ({ value, label: `${value} 秒` }))}
            onChange={interval => setDraft(previous => ({ interval, version: previous?.version ?? view.config_version }))} />
        </Form.Item>
        <Button htmlType="submit" type="primary" loading={busy}>保存上报间隔</Button>
      </Form>
    </>}
  </section>;
}
