import { TelemetryMinuteSchema, SyncHealthSchema } from './diagnostics.js';
export * from './diagnostics.js';
export * from './management.js';
import { Type, type Static } from '@sinclair/typebox';
import { CapabilitiesSchema, ExtensionsConfigSchema, ProbeDropsSchema, ProbeResultSchema, type Capabilities, type ExtensionsConfig } from './probes.js';
export * from './alerts.js';
export * from './traffic.js';
export * from './probes.js';

const NullableNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const BytesSchema = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
export const InterfaceSchema = Type.String({ pattern: '^[a-zA-Z0-9_.:-]{1,15}$' });
export const DeviceSchema = Type.String({ pattern: '^[a-zA-Z0-9_.:-]{1,128}$' });
export const DiskIOSnapshotSchema = Type.Object({
  device: DeviceSchema, read_bps: NullableNumber, write_bps: NullableNumber,
}, { additionalProperties: false });
export const DiskMinuteSchema = Type.Object({
  device: DeviceSchema, minute_ts: Type.Integer({ minimum: 0 }), revision: Type.Integer({ minimum: 1 }),
  read_bytes: BytesSchema, write_bytes: BytesSchema,
  observed_seconds: Type.Number({ exclusiveMinimum: 0, maximum: 60 }),
}, { additionalProperties: false });
export type DiskMinute = Static<typeof DiskMinuteSchema>;
export type DiskIOSnapshot = Static<typeof DiskIOSnapshotSchema>;
export const ConfigSchema = Type.Object({
  interfaces: Type.Union([Type.Literal('auto'), Type.Array(InterfaceSchema, { minItems: 1, maxItems: 16, uniqueItems: true })]),
  month_start_day: Type.Integer({ minimum: 1, maximum: 31 }),
  month_start_time: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
  timezone: Type.String({ minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
export type MonitorConfig = Static<typeof ConfigSchema>;
export const defaultConfig: MonitorConfig = { interfaces: 'auto', month_start_day: 1, month_start_time: '00:00', timezone: 'Asia/Shanghai' };

export const SnapshotSchema = Type.Object({
  observed_at: Type.Number({ minimum: 0 }),
  revision: Type.Integer({ minimum: 0 }),
  hostname: Type.String({ maxLength: 255 }),
  os: Type.String({ maxLength: 255 }),
  arch: Type.String({ maxLength: 64 }),
  kernel: Type.String({ maxLength: 255 }),
  agent_version: Type.String({ maxLength: 64 }),
  cpu_cores: Type.Integer({ minimum: 0, maximum: 65536 }),
  uptime_seconds: Type.Number({ minimum: 0 }),
  cpu_percent: NullableNumber,
  memory_percent: NullableNumber,
  swap_percent: NullableNumber,
  memory_total: BytesSchema,
  memory_available: BytesSchema,
  swap_total: BytesSchema,
  load: Type.Array(NullableNumber, { minItems: 3, maxItems: 3 }),
  rx_bps: Type.Number({ minimum: 0 }),
  tx_bps: Type.Number({ minimum: 0 }),
  interfaces: Type.Array(InterfaceSchema, { maxItems: 512 }),
  selected_interfaces: Type.Array(InterfaceSchema, { maxItems: 16 }),
  readable_interfaces: Type.Array(InterfaceSchema, { maxItems: 16 }),
  disks: Type.Array(Type.Object({
    mount: Type.String({ maxLength: 4096 }), fs: Type.String({ maxLength: 64 }),
    total_bytes: BytesSchema, used_bytes: BytesSchema, free_bytes: BytesSchema,
    used_percent: NullableNumber,
  }), { maxItems: 256 }),
  disk_io: Type.Optional(Type.Array(DiskIOSnapshotSchema, { maxItems: 256 })),
  disk_io_supported: Type.Optional(Type.Boolean()),
  error: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
}, { additionalProperties: false });
export type Snapshot = Static<typeof SnapshotSchema>;

export const MetricStatsSchema = Type.Object({ avg: NullableNumber, max: NullableNumber, count: Type.Integer({ minimum: 0 }) });
const resourceValues = {
  cpu_percent: MetricStatsSchema, memory_percent: MetricStatsSchema, swap_percent: MetricStatsSchema,
  load1: MetricStatsSchema, rx_bps: MetricStatsSchema, tx_bps: MetricStatsSchema,
};
export const ResourceSchema = Type.Object({
  minute_ts: Type.Integer({ minimum: 0 }), revision: Type.Integer({ minimum: 1 }), values: Type.Object(resourceValues, { additionalProperties: false }),
}, { additionalProperties: false });
export type ResourceMinute = Static<typeof ResourceSchema>;
export type MetricKey = keyof ResourceMinute['values'];
export const TrafficSchema = Type.Object({
  interface: InterfaceSchema, minute_ts: Type.Integer({ minimum: 0 }), revision: Type.Integer({ minimum: 1 }),
  rx_bytes: BytesSchema, tx_bytes: BytesSchema,
}, { additionalProperties: false });
export const TotalSchema = Type.Object({
  interface: InterfaceSchema, revision: Type.Integer({ minimum: 1 }), rx_bytes: BytesSchema, tx_bytes: BytesSchema,
}, { additionalProperties: false });
export const ReportSchema = Type.Object({
  protocol_version: Type.Literal(1),
  source_id: Type.String({ pattern: '^[a-f0-9-]{36}$' }),
  snapshot: SnapshotSchema,
  traffic: Type.Array(TrafficSchema, { maxItems: 256 }),
  resources: Type.Array(ResourceSchema, { maxItems: 256 }),
  totals: Type.Array(TotalSchema, { maxItems: 256 }),
  disk_io: Type.Optional(Type.Array(DiskMinuteSchema, { maxItems: 256 })),
  applied_config_version: Type.Integer({ minimum: 0 }),
  config_error: Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]),
  imported_config: Type.Optional(ConfigSchema),
  capabilities: Type.Optional(CapabilitiesSchema),
  probes: Type.Optional(Type.Array(ProbeResultSchema, { maxItems: 256 })),
  diagnostics: Type.Optional(Type.Array(TelemetryMinuteSchema, { maxItems: 256 })),
  workloads: Type.Optional(Type.Array(TelemetryMinuteSchema, { maxItems: 256 })),
  sync_health: Type.Optional(SyncHealthSchema),
  applied_extensions_config_version: Type.Optional(Type.Integer({ minimum: 0 })),
  extensions_config_error: Type.Optional(Type.Union([Type.Literal('invalid_config'), Type.Literal('persist_failed'), Type.Null()])),
  probe_drops: Type.Optional(ProbeDropsSchema),
}, { additionalProperties: false });
export type AgentReport = Static<typeof ReportSchema>;
export type ReportReply = {
  ack: { traffic: number; resources: number; totals: number; disk_io?: number; probes?: number; diagnostics?: number; workloads?: number };
  config: MonitorConfig; config_version: number; received_at: number;
  server_capabilities?: Capabilities; extensions_config?: ExtensionsConfig; extensions_config_version?: number;
};

export type ByteSummary = { rx_bytes: string; tx_bytes: string; total_bytes: string };
export type PeriodSummary = ByteSummary & { start: string; end: string };
export type NodeStatus = 'pending' | 'online' | 'stale' | 'offline' | 'disabled' | 'archived';
export type NodeView = {
  id: string; name: string; group: string; tags: string[]; enabled: boolean; archived: boolean;
  created_at: number; last_received_at: number | null; status: NodeStatus;
  config: MonitorConfig; config_version: number; applied_config_version: number; config_error: string | null;
  source_id: string | null; snapshot: Snapshot | null;
  traffic: { total: ByteSummary; month: PeriodSummary; previous_month: PeriodSummary };
  active_alerts?: number; quota_percent?: number | null;
};
export type Overview = {
  nodes: number; online: number; stale: number; offline: number; pending: number;
  rx_bps: number; tx_bps: number; month: ByteSummary; total: ByteSummary;
  active_alerts?: number; quota_attention?: number;
};
export type DiskHistoryPoint = { read_bytes: string; write_bytes: string; read_bps: number; write_bps: number };
export type HistoryPoint = {
  ts: number; duration_seconds: number; rx_bytes: string | null; tx_bytes: string | null;
  values: ResourceMinute['values'] | null; disk_io: DiskHistoryPoint | null;
};
export type HistoryGranularity = 'auto' | 'hour' | 'day';
export type HistoryFilters = { interface?: string; device?: string; granularity?: HistoryGranularity };
export type History = {
  points: HistoryPoint[]; step: number; minutes: number; start: number; end: number;
  network: { interfaces: string[]; interface: string | null; total: ByteSummary };
  disk_io: { devices: string[]; device: string | null; total: { read_bytes: string | null; write_bytes: string | null } };
};

export const NodeCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  group: Type.Optional(Type.String({ maxLength: 100 })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20, uniqueItems: true })),
}, { additionalProperties: false });
export const NodePatchSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  group: Type.Optional(Type.String({ maxLength: 100 })),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20, uniqueItems: true })),
  enabled: Type.Optional(Type.Boolean()), archived: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
