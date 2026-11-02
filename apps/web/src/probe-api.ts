import type { ProbeHistory, ProbePair, ProbeTask, ProbeTaskInput } from '@traffic/contracts';
import { api } from './api';
export const probes = {
  list: () => api<{ tasks: ProbeTask[]; pairs: ProbePair[] }>('/probe-tasks'),
  save: (input: ProbeTaskInput, task?: ProbeTask) => api<ProbeTask>(`/probe-tasks${task ? `/${task.id}` : ''}`, {
    method: task ? 'PATCH' : 'POST', body: JSON.stringify(input), headers: task ? { 'If-Match': String(task.version) } : {},
  }),
  archive: (id: string) => api(`/probe-tasks/${id}`, { method: 'DELETE' }),
  history: (node: string, task: string, minutes: number, offset = 0) => api<ProbeHistory>(`/nodes/${node}/probe-history?task_id=${task}&minutes=${minutes}&offset=${offset}`),
};
export function probeInput(task: ProbeTask): ProbeTaskInput {
  const { name, kind, target, port, family, interval_seconds, timeout_seconds, node_ids, enabled, channel_ids } = task;
  return { name, kind, target, port, family, interval_seconds, timeout_seconds, node_ids, enabled, channel_ids };
}
export const probeStatus = { success: '成功', dns: 'DNS 失败', tcp: 'TCP 失败', tls: 'TLS 失败', http: 'HTTP 状态失败', timeout: '超时', icmp: 'ICMP 失败', unsupported: '不支持 / 权限不足', blocked: '本地目标策略阻止', skipped: '队列已满，未执行' };
