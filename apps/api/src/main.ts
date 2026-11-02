import { buildApp } from './app.js';

const app = await buildApp({
  dbPath: process.env.DB_PATH || './data/control.db', publicUrl: process.env.PUBLIC_URL,
  secureCookies: process.env.SECURE_COOKIES === undefined ? undefined : process.env.SECURE_COOKIES === 'true',
  webRoot: process.env.WEB_ROOT, logger: true,
  notificationKeyFile: process.env.NOTIFICATION_KEY_FILE,
  webhookPolicy: { allowHttp: process.env.WEBHOOK_ALLOW_HTTP === 'true',
    allowedHosts: process.env.WEBHOOK_ALLOWED_HOSTS?.split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    allowedCidrs: process.env.WEBHOOK_ALLOWED_CIDRS?.split(',').map(s => s.trim()).filter(Boolean) },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
try { await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 8766) }); }
catch (error) { app.log.error(error); process.exit(1); }
