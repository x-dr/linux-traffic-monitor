import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { httpError } from './auth.js';

export type WebhookSecret = { url: string; authorization: string };
export type WebhookPolicy = { allowHttp?: boolean; allowedHosts?: string[]; allowedCidrs?: string[] };
export function loadNotificationKey(path?: string): Buffer | undefined {
  if (!path) return undefined;
  const raw = readFileSync(path), value = raw.toString('utf8').trim();
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : raw;
  if (key.length !== 32) throw new Error('通知密钥文件必须为 32 字节或 64 位十六进制');
  return key;
}
export function encryptSecret(key: Buffer, value: WebhookSecret) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
export function decryptSecret(key: Buffer | undefined, value: string): WebhookSecret {
  if (!key) throw httpError(503, '未配置通知密钥文件');
  try {
    const [iv, tag, body] = value.split('.').map(v => Buffer.from(v, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString());
  } catch { throw httpError(503, '通知配置无法解密，请检查密钥备份'); }
}
function inRanges(ip: string, ranges: string[]) {
  const list = new BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split('/'), family = isIP(address);
    if (!family || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) throw httpError(503, 'Webhook 允许网段配置无效');
    if (prefix === undefined) list.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
    else list.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}
export function allowedAddress(address: string, hostname: string, policy: WebhookPolicy) {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (!isIP(ip)) return false;
  // Metadata and link-local targets remain forbidden even with a private-network allowlist.
  if (inRanges(ip, ['169.254.0.0/16', '100.100.100.200/32', 'fe80::/10', 'fd00:ec2::254/128', '0.0.0.0/8', '::/128', '224.0.0.0/4', 'ff00::/8'])) return false;
  const privateAddress = inRanges(ip, ['10.0.0.0/8', '127.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '192.0.0.0/24', '198.18.0.0/15', '::1/128', 'fc00::/7', '2001:db8::/32']);
  return !privateAddress || !!policy.allowedHosts?.includes(hostname.toLowerCase()) || inRanges(ip, policy.allowedCidrs ?? []);
}
export function parseTarget(value: string, policy: WebhookPolicy) {
  let url: URL;
  try { url = new URL(value); } catch { throw httpError(400, 'Webhook URL 无效'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:'))) throw httpError(400, 'Webhook 需要 HTTPS，禁止 URL 用户信息及片段');
  return url;
}
export async function resolveTarget(value: string, policy: WebhookPolicy) {
  const url = parseTarget(value, policy), hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true }).catch(() => { throw httpError(400, 'Webhook 域名解析失败'); });
  if (!addresses.length || addresses.some(a => !allowedAddress(a.address, hostname, policy))) throw httpError(400, 'Webhook 目标地址不在允许范围');
  return { url, address: addresses[0] };
}
export type WebhookResult = { status: number; retryAfter?: string };
export type WebhookSender = (secret: WebhookSecret, payload: string, key: string, signal: AbortSignal) => Promise<WebhookResult>;
export function webhookSender(policy: WebhookPolicy): WebhookSender {
  return async (secret, payload, key, signal) => {
    signal.throwIfAborted();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error('Webhook 请求超时')); signal.addEventListener('abort', onAbort, { once: true }); });
    const { url, address } = await Promise.race([resolveTarget(secret.url, policy), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', signal, timeout: 10000, family: address.family, agent: false,
        lookup: (_name, _options, callback) => callback(null, address.address, address.family),
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Idempotency-Key': key,
          ...(secret.authorization ? { Authorization: secret.authorization } : {}) },
      }, response => {
        // No redirects and no response bodies are persisted or logged.
        resolve({ status: response.statusCode ?? 0, retryAfter: response.headers['retry-after'] }); response.destroy();
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => reject(new Error('Webhook 网络或 TLS 请求失败')));
      request.end(payload);
    });
  };
}
