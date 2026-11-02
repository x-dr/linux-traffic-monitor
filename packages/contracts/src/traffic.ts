import { Type, type Static } from '@sinclair/typebox';

export const TrafficPolicySchema = Type.Object({
  enabled: Type.Boolean(), quota_bytes: Type.String({ pattern: '^[1-9][0-9]{0,29}$' }),
  input_unit: Type.Union((['GB', 'TB', 'GiB', 'TiB'] as const).map(v => Type.Literal(v))),
  direction: Type.Union((['tx', 'rx', 'sum', 'max'] as const).map(v => Type.Literal(v))),
  interfaces: Type.Array(Type.String({ pattern: '^[a-zA-Z0-9_.:-]{1,15}$' }), { minItems: 1, maxItems: 16, uniqueItems: true }),
  thresholds: Type.Array(Type.Integer({ minimum: 1, maximum: 100 }), { minItems: 1, maxItems: 10, uniqueItems: true }),
  channel_ids: Type.Array(Type.String({ format: 'uuid' }), { maxItems: 10, uniqueItems: true }),
}, { additionalProperties: false });
export type TrafficPolicyInput = Static<typeof TrafficPolicySchema>;
export type TrafficPolicy = TrafficPolicyInput & { version: number };
export type QuotaView = {
  policy: TrafficPolicy; start: string; end: string; rx_bytes: string; tx_bytes: string; billed_bytes: string;
  remaining_bytes: string; percent: number; exceeded: boolean; missing_interfaces: string[];
  forecast: { available: boolean; reason: string; days: number; coverage: number; window_start: string | null;
    window_end: string | null; projected_bytes: string | null; exhaustion_at: number | null };
  basis: string; remaining_seconds: number;
};
