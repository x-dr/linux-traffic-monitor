import { Type, type Static } from '@sinclair/typebox';
import { DiagnosticsConfigSchema, WorkloadsConfigSchema } from './diagnostics.js';

const id = Type.String({ format: 'uuid' });
const integer = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum, maximum });
const nullable = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const CapabilitiesSchema = Type.Object({ probes: Type.Optional(Type.Literal(1)), diagnostics: Type.Optional(Type.Literal(1)), workloads: Type.Optional(Type.Literal(1)) }, { additionalProperties: false });
export type Capabilities = Static<typeof CapabilitiesSchema>;
const execution = {
  kind: Type.Union([Type.Literal('icmp'), Type.Literal('tcp'), Type.Literal('http')]),
  target: Type.String({ minLength: 1, maxLength: 2048 }), port: integer(0, 65535),
  family: Type.Union([Type.Literal('ipv4'), Type.Literal('ipv6')]),
  interval_seconds: integer(15, 3600), timeout_seconds: integer(1, 10),
};
export const ProbeTaskSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }), ...execution,
  node_ids: Type.Array(id, { minItems: 1, maxItems: 50, uniqueItems: true }), enabled: Type.Boolean(),
  channel_ids: Type.Array(id, { maxItems: 10, uniqueItems: true }),
}, { additionalProperties: false });
export type ProbeTaskInput = Static<typeof ProbeTaskSchema>;
export type ProbeTask = ProbeTaskInput & { id: string; version: number; archived: boolean };
export const ProbeAssignmentSchema = Type.Object({
  id, version: integer(1), start_at: Type.Number({ minimum: 0 }), ...execution,
}, { additionalProperties: false });
export type ProbeAssignment = Static<typeof ProbeAssignmentSchema>;
export const ExtensionsConfigSchema = Type.Object({ probes: Type.Array(ProbeAssignmentSchema, { maxItems: 10 }), diagnostics: Type.Optional(DiagnosticsConfigSchema), workloads: Type.Optional(WorkloadsConfigSchema) }, { additionalProperties: false });
export type ExtensionsConfig = Static<typeof ExtensionsConfigSchema>;
export const ProbeResultSchema = Type.Object({
  sample_id: id, task_id: id, task_version: integer(1), revision: integer(1),
  scheduled_at: Type.Number({ minimum: 0 }), started_at: Type.Number({ minimum: 0 }), completed_at: Type.Number({ minimum: 0 }),
  status: Type.Union((['success', 'dns', 'tcp', 'tls', 'http', 'timeout', 'icmp', 'unsupported', 'blocked', 'skipped'] as const).map(v => Type.Literal(v))),
  attempts: integer(0, 1), latency_ms: nullable, http_status: Type.Union([integer(100, 599), Type.Null()]),
  certificate_expires_at: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
}, { additionalProperties: false });
export type ProbeResult = Static<typeof ProbeResultSchema>;
export const ProbeDropsSchema = Type.Object({ count: integer(0), oldest_at: nullable, newest_at: nullable }, { additionalProperties: false });
export type ProbeDrops = Static<typeof ProbeDropsSchema>;
export type AgentExtensionsView = { supported: boolean; config_version: number; applied_version: number; error: string | null; drops: ProbeDrops };
export type ProbePair = { task: ProbeTask; node_id: string; node_name: string; node_active: boolean; extensions: AgentExtensionsView; latest: ProbeResult | null; fresh: boolean };
export type ProbeStats = { expected: number; valid: number; success: number; availability: number | null; coverage: number | null; failure_rate: number | null; p50_ms: number | null; p95_ms: number | null };
export type ProbeHistory = { start: number; end: number; task: ProbeTask; stats: ProbeStats; results: ProbeResult[]; total: number; points: { ts: number; latency_ms: number | null; task_version: number }[] };
