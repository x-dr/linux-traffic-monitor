import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { AlertRuleSchema, ChannelSchema, MaintenanceSchema, ReportSchema, ScopeSchema, TrafficPolicySchema } from '../../../packages/contracts/src/index.js';

test('monitoring fixtures and exported schemas match contracts; base Agent fields remain compatible', () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../packages/contracts/${name}`, import.meta.url), 'utf8'));
  const fixture = read('fixtures/monitoring.json');
  assert.equal(Value.Check(AlertRuleSchema, fixture.rule), true); assert.equal(Value.Check(TrafficPolicySchema, fixture.policy), true);
  assert.equal(Value.Check(TrafficPolicySchema, { ...fixture.policy, quota_bytes: '0' }), false);
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(read('report.schema.json'), plain({ $schema: 'http://json-schema.org/draft-07/schema#', ...ReportSchema }));
  assert.deepEqual(read('monitoring.schema.json').definitions, plain({ AlertRule: AlertRuleSchema, Channel: ChannelSchema, Maintenance: MaintenanceSchema, Scope: ScopeSchema, TrafficPolicy: TrafficPolicySchema }));
});
