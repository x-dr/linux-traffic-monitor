import { Type, type Static } from '@sinclair/typebox';
const strict = { additionalProperties: false };
export const AssetSchema = Type.Object({
  provider: Type.String({ maxLength: 100 }), region: Type.String({ maxLength: 100 }), ip: Type.String({ maxLength: 100 }),
  note: Type.String({ maxLength: 2000 }), price_minor: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }), billing_months: Type.Integer({ minimum: 1, maximum: 120 }),
  expires_at: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), bandwidth_mbps: Type.Union([Type.Number({ minimum: 0, maximum: 1e7 }), Type.Null()]),
  channel_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true }),
}, strict);
export type NodeAsset = Static<typeof AssetSchema>;
export const RegistrationSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), group: Type.String({ maxLength: 100 }),
  expires_in: Type.Integer({ minimum: 300, maximum: 86400 }), max_uses: Type.Integer({ minimum: 1, maximum: 50 }),
}, strict);
export const EnrollmentSchema = Type.Object({ registration_id: Type.String({ format: 'uuid' }), name: Type.String({ minLength: 1, maxLength: 100 }),
  request_id: Type.String({ format: 'uuid' }),
}, strict);
export const ReportJobSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }), enabled: Type.Boolean(),
  period: Type.Union(['day','week','month','billing'].map(v => Type.Literal(v))), timezone: Type.String({ minLength: 1, maxLength: 64 }),
  node_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 50, uniqueItems: true }), group: Type.String({ maxLength: 100 }),
  channel_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true }),
}, strict);
export type ReportJobInput = Static<typeof ReportJobSchema>;
export type ReportJob = ReportJobInput & { id: string; version: number };
export type RegistrationView = { id: string; name: string; group: string; expires_at: number; max_uses: number; uses: number; revoked: number };
export type ReportRow = { node_id: string; name: string; start: number; end: number; rx_bytes: string; tx_bytes: string;
  availability: number | null; observed_seconds: number; downtime_seconds: number | null; cpu_avg: number | null; cpu_max: number | null;
  capacity_used_percent: number | null };
export type ReportRun = { id: string; job_id: string; period_key: string; created_at: number; late: boolean; rows: ReportRow[] };
