import { writeFileSync } from 'node:fs';
import { AlertRuleSchema, CapabilitiesSchema, ChannelSchema, ExtensionsConfigSchema, MaintenanceSchema, ProbeResultSchema, ProbeTaskSchema, ReportSchema, ScopeSchema, TrafficPolicySchema } from '../packages/contracts/src/index.js';

writeFileSync(new URL('../packages/contracts/report.schema.json', import.meta.url), JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...ReportSchema }, null, 2) + '\n');
console.log('已导出 Agent 上报 JSON Schema');
writeFileSync(new URL('../packages/contracts/monitoring.schema.json', import.meta.url), JSON.stringify({
  $schema: 'http://json-schema.org/draft-07/schema#', definitions: { AlertRule: AlertRuleSchema, Channel: ChannelSchema,
    Maintenance: MaintenanceSchema, Scope: ScopeSchema, TrafficPolicy: TrafficPolicySchema },
}, null, 2) + '\n');
console.log('已导出中心监控管理 JSON Schema');
writeFileSync(new URL('../packages/contracts/probes.schema.json', import.meta.url), JSON.stringify({
  $schema: 'http://json-schema.org/draft-07/schema#', definitions: { Capabilities: CapabilitiesSchema, ExtensionsConfig: ExtensionsConfigSchema, ProbeTask: ProbeTaskSchema, ProbeResult: ProbeResultSchema },
}, null, 2) + '\n');
console.log('已导出探测扩展 JSON Schema');
