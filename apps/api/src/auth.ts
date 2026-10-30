import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DB } from './database.js';
import { digest } from './nodes.js';

export type Session = { token_hash: string; csrf: string; expires_at: number };
declare module 'fastify' { interface FastifyRequest { session: Session | null } }
const SESSION_SECONDS = 12 * 3600;
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function initializeAdmin(db: DB, username: string, password: string) {
  if (db.prepare('SELECT 1 FROM admin').get()) throw new Error('管理员已存在，请在后台修改密码');
  if (!username.trim() || username.length > 100 || password.length < 12 || password.length > 256) throw new Error('用户名不能为空；密码须为 12～256 个字符');
  db.prepare('INSERT INTO admin VALUES(1,?,?)').run(username.trim(), hashPassword(password));
}
export const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export function installAuth(app: FastifyInstance, db: DB, options: { publicUrl?: string; secureCookies?: boolean; now: () => number }) {
  app.decorateRequest('session', null);
  const allowedOrigin = options.publicUrl ? new URL(options.publicUrl).origin : undefined;
  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: options.secureCookies ?? allowedOrigin?.startsWith('https:') ?? false };
  const checkOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (origin && origin !== (allowedOrigin || `${request.protocol}://${request.host}`)) throw httpError(403, '请求来源不匹配');
  };
  app.addHook('preHandler', async (req) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/v1/') || path === '/api/v1/agent/report' || path === '/api/v1/auth/login' || path === '/api/v1/auth/setup-status') return;
    const token = req.cookies.sid;
    const session = token ? db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(token), options.now()) as Session | undefined : undefined;
    if (!session) throw httpError(401, '请先登录');
    req.session = session;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      checkOrigin(req);
      const provided = req.headers['x-csrf-token'];
      if (typeof provided !== 'string' || provided !== session.csrf) throw httpError(403, 'CSRF 校验失败，请刷新页面');
    }
  });
  const loginSchema = { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: {
    username: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 1, maxLength: 256 },
  } } };
  app.get('/api/v1/auth/setup-status', async () => ({ initialized: !!db.prepare('SELECT 1 FROM admin').get() }));
  app.post<{ Body: { username: string; password: string } }>('/api/v1/auth/login', {
    schema: loginSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    checkOrigin(req);
    const admin = db.prepare('SELECT * FROM admin WHERE id=1').get() as { username: string; password_hash: string } | undefined;
    if (!admin) throw httpError(503, '请先在中心服务终端运行 npm run admin 初始化管理员');
    // Always run scrypt, even for an unknown username.
    const valid = verifyPassword(req.body.password, admin.password_hash);
    if (!valid || req.body.username !== admin.username) throw httpError(401, '用户名或密码错误');
    if (req.cookies.sid) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(req.cookies.sid));
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), csrf, options.now() + SESSION_SECONDS);
    reply.setCookie('sid', token, { ...cookieOptions, maxAge: SESSION_SECONDS });
    return { username: admin.username, csrf };
  });
  app.get('/api/v1/auth/session', async req => {
    const admin = db.prepare('SELECT username FROM admin WHERE id=1').get() as { username: string };
    return { username: admin.username, csrf: req.session!.csrf };
  });
  app.post('/api/v1/auth/logout', async (req, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session!.token_hash);
    reply.clearCookie('sid', cookieOptions);
    return { ok: true };
  });
  app.post<{ Body: { current_password: string; password: string } }>('/api/v1/auth/password', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['current_password', 'password'], properties: {
      current_password: { type: 'string', maxLength: 256 }, password: { type: 'string', minLength: 12, maxLength: 256 },
    },
  } } }, async (req, reply) => {
    const admin = db.prepare('SELECT password_hash FROM admin WHERE id=1').get() as { password_hash: string };
    if (!verifyPassword(req.body.current_password, admin.password_hash)) throw httpError(400, '当前密码错误');
    const encoded = hashPassword(req.body.password);
    db.transaction(() => { db.prepare('UPDATE admin SET password_hash=? WHERE id=1').run(encoded); db.prepare('DELETE FROM sessions').run(); })();
    reply.clearCookie('sid', cookieOptions);
    return { ok: true };
  });
}
