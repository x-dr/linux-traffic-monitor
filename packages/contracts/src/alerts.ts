import { Type, type Static } from '@sinclair/typebox';

export const ScopeSchema = Type.Object({
  kind: Type.Union((['all', 'nodes', 'group', 'tag'] as const).map(v => Type.Literal(v))),
  node_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 50, uniqueItems: true }),
  value: Type.String({ maxLength: 100 }),
}, { additionalProperties: false });
export type AlertScope = Static<typeof ScopeSchema>;
export const AlertRuleSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), enabled: Type.Boolean(), scope: ScopeSchema,
  metric: Type.Union((['offline', 'stale', 'cpu', 'memory', 'disk_percent', 'disk_free', 'bandwidth', 'iowait', 'steal', 'psi_cpu', 'psi_memory', 'psi_io', 'inode', 'read_iops', 'write_iops', 'service_down', 'process_down'] as const).map(v => Type.Literal(v))),
  object: Type.String({ maxLength: 4096 }), threshold: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  duration_seconds: Type.Integer({ minimum: 0, maximum: 86400 }),
  recovery_threshold: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  recovery_seconds: Type.Integer({ minimum: 0, maximum: 86400 }),
  severity: Type.Union([Type.Literal('warning'), Type.Literal('critical')]),
  channel_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true }),
  repeat_seconds: Type.Integer({ minimum: 0, maximum: 604800 }),
  bandwidth_mbps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1000000 })),
}, { additionalProperties: false });
export type AlertRuleInput = Static<typeof AlertRuleSchema>;
export type AlertRule = AlertRuleInput & { id: string; matched_nodes: { id: string; name: string }[] };
export type AlertValidity = 'fresh' | 'unknown' | 'unsupported';
export type AlertEvent = {
  id: string; node_id: string; node_name: string; rule_id: string | null; kind: string; title: string;
  severity: 'warning' | 'critical'; object: string; state: 'firing' | 'recovering' | 'resolved' | 'closed';
  validity: AlertValidity; first_anomaly_at: number; fired_at: number; last_anomaly_at: number;
  resolved_at: number | null; close_reason: string | null; value: number | null; threshold: number;
  acknowledged_at: number | null; silenced_until: number | null; detail: string;
};
export const MaintenanceSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), scope: ScopeSchema,
  start_at: Type.Number({ minimum: 0 }), end_at: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
export type Maintenance = Static<typeof MaintenanceSchema> & { id: string };
export const ChannelSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), enabled: Type.Boolean(),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  authorization: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
export type ChannelInput = Static<typeof ChannelSchema>;
export type ChannelView = { id: string; name: string; enabled: boolean; target: string; has_authorization: boolean };
export type Delivery = {
  id: string; event_id: string | null; channel_id: string; channel_name: string; phase: string;
  status: string; attempts: number; next_attempt_at: number; last_error: string | null;
  created_at: number; sent_at: number | null; idempotency_key: string;
};
export type NodeEvent = { id: string; node_id: string; kind: string; created_at: number; detail: string };
