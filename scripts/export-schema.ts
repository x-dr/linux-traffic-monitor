import { writeFileSync } from 'node:fs';
import { ReportSchema } from '../packages/contracts/src/index.js';

writeFileSync(new URL('../packages/contracts/report.schema.json', import.meta.url), JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', ...ReportSchema }, null, 2) + '\n');
console.log('已导出 Agent 上报 JSON Schema');
