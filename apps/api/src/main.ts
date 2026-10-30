import { buildApp } from './app.js';

const app = await buildApp({
  dbPath: process.env.DB_PATH || './data/control.db', publicUrl: process.env.PUBLIC_URL,
  secureCookies: process.env.SECURE_COOKIES === undefined ? undefined : process.env.SECURE_COOKIES === 'true',
  webRoot: process.env.WEB_ROOT, logger: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
try { await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8766) }); }
catch (error) { app.log.error(error); process.exit(1); }
