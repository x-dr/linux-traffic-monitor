import { Type, type Static } from '@sinclair/typebox';
const strict = { additionalProperties: false };
const nonnegative = Type.Number({ minimum: 0, maximum: 1e30 });
const nullable = Type.Union([nonnegative, Type.Null()]);
const name = Type.String({ pattern: '^[a-zA-Z0-9_.@:-]{1,100}$' });
export const DiagnosticsConfigSchema = Type.Object({ enabled: Type.Boolean(), services: Type.Array(Type.Object({
  manager: Type.Union([Type.Literal('systemd'), Type.Literal('openrc')]), name,
}, strict), { maxItems: 10, uniqueItems: true }) }, strict);
export const WorkloadsConfigSchema = Type.Object({ enabled: Type.Boolean(), docker: Type.Boolean(),
  processes: Type.Array(name, { maxItems: 20, uniqueItems: true }),
}, strict);
export type DiagnosticsConfig = Static<typeof DiagnosticsConfigSchema>;
export type WorkloadsConfig = Static<typeof WorkloadsConfigSchema>;
export const TelemetryStatsSchema = Type.Object({ last: nullable, avg: nullable, max: nullable,
  count: Type.Integer({ minimum: 0, maximum: 10000 }), seconds: Type.Number({ minimum: 0, maximum: 60 }),
}, strict);
export const TelemetryObjectSchema = Type.Object({
  object: Type.String({ minLength: 1, maxLength: 256 }), identity: Type.String({ minLength: 1, maxLength: 512 }),
  observed_at: nonnegative, interval_seconds: Type.Integer({ minimum: 5, maximum: 60 }),
  status: Type.Union(['ok','unsupported','unreadable','disabled','absent'].map(v => Type.Literal(v))),
  values: Type.Record(Type.String({ pattern: '^[a-z][a-z0-9_]{0,47}$' }), TelemetryStatsSchema, { maxProperties: 24 }),
}, strict);
export const TelemetryMinuteSchema = Type.Object({ minute_ts: Type.Integer({ minimum: 0 }), revision: Type.Integer({ minimum: 1 }),
  config_version: Type.Integer({ minimum: 0 }), objects: Type.Array(TelemetryObjectSchema, { maxItems: 128 }),
}, strict);
export type TelemetryStats = Static<typeof TelemetryStatsSchema>;
export type TelemetryObject = Static<typeof TelemetryObjectSchema>;
export type TelemetryMinute = Static<typeof TelemetryMinuteSchema>;
export const SyncHealthSchema = Type.Object({ streams: Type.Array(Type.Object({
  name: Type.String({ enum: ['traffic','resources','totals','disk_io','probes','diagnostics','workloads'] }),
  pending: Type.Integer({ minimum: 0 }), oldest_at: nullable, cursor: Type.Integer({ minimum: 0 }),
  drops_tracked: Type.Boolean(), dropped: Type.Integer({ minimum: 0 }), dropped_oldest_at: nullable, dropped_newest_at: nullable,
}, strict), { maxItems: 7 }), last_ack_at: nullable }, strict);
export type SyncHealth = Static<typeof SyncHealthSchema>;
export type DiagnosticSettings = { diagnostics: DiagnosticsConfig; workloads: WorkloadsConfig };
export type TelemetryView = { supported: boolean; enabled: boolean; config_version: number; applied_version: number; error: string | null;
  settings: DiagnosticSettings; forecasts?:{object:string;full_at:number|null;days:number;reason:string}[]; latest: (TelemetryObject & { fresh: boolean })[]; sync: SyncHealth | null };
export type TelemetryHistory = { start: number; end: number; step: number; points: { ts: number; object: TelemetryObject }[]; total: number };
