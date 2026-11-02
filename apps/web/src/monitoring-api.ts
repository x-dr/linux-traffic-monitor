import type { AlertEvent, AlertRule, AlertRuleInput, ChannelInput, ChannelView, Delivery, Maintenance, NodeEvent, QuotaView, TrafficPolicy, TrafficPolicyInput } from '@traffic/contracts';
import { api } from './api';

const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
export const monitoring = {
  rules: () => api<{ rules: AlertRule[] }>('/alert-rules'),
  saveRule: (input: AlertRuleInput, id?: string) => api<AlertRule>(`/alert-rules${id ? `/${id}` : ''}`, send(id ? 'PATCH' : 'POST', input)),
  archiveRule: (id: string) => api(`/alert-rules/${id}`, { method: 'DELETE' }),
  alerts: (params: URLSearchParams) => api<{ events: AlertEvent[]; total: number }>(`/alerts?${params}`),
  event: (id: string) => api<{ event: AlertEvent; deliveries: Delivery[] }>(`/alerts/${id}`),
  acknowledge: (id: string) => api(`/alerts/${id}/acknowledge`, { method: 'POST' }),
  silence: (id: string) => api(`/alerts/${id}/silence`, send('POST', { until: Date.now() / 1000 + 3600 })),
  windows: () => api<{ windows: Maintenance[] }>('/maintenance-windows'),
  saveWindow: (input: Omit<Maintenance, 'id'>, id?: string) => api(`/maintenance-windows${id ? `/${id}` : ''}`, send(id ? 'PATCH' : 'POST', input)),
  removeWindow: (id: string) => api(`/maintenance-windows/${id}`, { method: 'DELETE' }),
  channels: () => api<{ configured: boolean; channels: ChannelView[] }>('/notification-channels'),
  saveChannel: (input: ChannelInput, id?: string) => api(`/notification-channels${id ? `/${id}` : ''}`, send(id ? 'PATCH' : 'POST', input)),
  disableChannel: (id: string) => api(`/notification-channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: string) => api(`/notification-channels/${id}/test`, { method: 'POST' }),
  deliveries: (event?: string, offset = 0) => api<{ deliveries: Delivery[] }>(`/notification-deliveries?limit=20&offset=${offset}${event ? `&event_id=${event}` : ''}`),
  retry: (id: string) => api(`/notification-deliveries/${id}/retry`, { method: 'POST' }),
  policy: (id: string) => api<{ policy: TrafficPolicy | null; config_version: number }>(`/nodes/${id}/traffic-policy`),
  quota: (id: string) => api<{ quota: QuotaView | null }>(`/nodes/${id}/quota`),
  preview: (id: string, input: TrafficPolicyInput) => api<{ quota: QuotaView; policy_version: number; config_version: number }>(`/nodes/${id}/traffic-policy/preview`, send('POST', input)),
  savePolicy: (id: string, input: TrafficPolicyInput, version: number, configVersion: number) => api(`/nodes/${id}/traffic-policy`, {
    ...send('PUT', input), headers: { 'If-Match': String(version), 'X-Config-Version': String(configVersion) },
  }),
  nodeEvents: (id: string, offset = 0) => api<{ events: NodeEvent[] }>(`/nodes/${id}/events?limit=20&offset=${offset}`),
};
