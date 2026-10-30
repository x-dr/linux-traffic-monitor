import { readFileSync } from 'node:fs';
import { openDatabase } from './database.js';
import { initializeAdmin } from './auth.js';

async function passwordInput(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  process.stdout.write('设置管理员密码（至少 12 位，输入隐藏）：');
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', input); process.stdout.write('\n'); };
    const input = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === '\u0003') { finish(); reject(new Error('已取消')); return; }
        if (ch === '\r' || ch === '\n') { finish(); resolve(password); return; }
        if (ch === '\u007f') password = password.slice(0, -1); else password += ch;
      }
    };
    process.stdin.on('data', input);
  });
}
const db = openDatabase(process.env.DB_PATH || './data/control.db');
try {
  const idx = process.argv.indexOf('--username');
  const username = idx >= 0 ? process.argv[idx + 1] : 'admin';
  if (!username) throw new Error('--username 需要用户名');
  initializeAdmin(db, username, await passwordInput());
  console.log(`管理员 ${username} 已创建`);
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
finally { db.close(); }
