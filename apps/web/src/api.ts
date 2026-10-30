import type { NodeView, Overview, History, HistoryFilters, MonitorConfig } from '@traffic/contracts';

let csrf = '';
export const setCsrf = (value: string) => { csrf = value; };
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => ({ error: '服务器响应格式错误' }));
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('session-expired'));
    throw new ApiError(response.status, body.error || `请求失败 (${response.status})`);
  }
  return body as T;
}
export const client = {
  nodes: () => api<{ nodes: NodeView[] }>('/nodes'),
  node: (id: string) => api<NodeView>(`/nodes/${id}`),
  overview: () => api<Overview>('/overview'),
  history: (id: string, minutes: number, filters: HistoryFilters = {}) => {
    const params = new URLSearchParams({ minutes: String(minutes) });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return api<History>(`/nodes/${id}/history?${params}`);
  },
  patchNode: (id: string, data: Partial<Pick<NodeView, 'name' | 'group' | 'tags' | 'enabled' | 'archived'>>) => api<NodeView>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  configure: (id: string, data: MonitorConfig) => api<NodeView>(`/nodes/${id}/config`, { method: 'PUT', body: JSON.stringify(data) }),
};
