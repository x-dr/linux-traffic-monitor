import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/database.js';
import { buildApp } from '../src/app.js';
import { initializeAdmin } from '../src/auth.js';
import type { AgentReport } from '../../../packages/contracts/src/index.js';

export const TEST_PASSWORD = 'test-only-password-2026';
export const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/report.json', import.meta.url), 'utf8')) as AgentReport;
export async function setup() {
  const db = openDatabase(':memory:');
  let clock = 1793380020;
  initializeAdmin(db, 'admin', TEST_PASSWORD);
  const app = await buildApp({ db, now: () => clock, publicUrl: 'http://localhost' });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: TEST_PASSWORD } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = { cookie, 'x-csrf-token': login.json().csrf, origin: 'http://localhost' };
  const create = async (name = '测试节点') => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/nodes', headers, payload: { name, group: '测试分组', tags: ['test'] } });
    return response.json() as { node: { id: string }; token: string };
  };
  const report = (source = randomUUID()): AgentReport => {
    const value = structuredClone(fixture); value.source_id = source; value.snapshot.observed_at = clock;
    for (const row of [...value.traffic, ...value.resources]) row.minute_ts = Math.floor(clock / 60) * 60;
    return value;
  };
  return { app, db, headers, cookie, create, report, advance: (seconds: number) => { clock += seconds; }, now: () => clock, close: async () => { await app.close(); db.close(); } };
}
