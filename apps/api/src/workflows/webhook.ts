import { createHmac } from 'node:crypto';
import { lookup as dnsLookup, LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * Sending one webhook: signing, the guard against reaching private networks, and the HTTP
 * request itself. No retries here; the runner decides when to try again.
 */

export const SIGNATURE_HEADER = 't2t-signature';

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the same scheme receivers check. */
export function signPayload(secret: string, body: string, at: Date = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Addresses a webhook may never reach unless private networks are allowed (development and tests). */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by their IPv4 address in isPublicAddress;
// listing ::ffff:0:0/96 here would also block every IPv4 address.
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    // An IPv4 address written as IPv6: judge the IPv4 address.
    let v4 = address.slice(7);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v4);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
    if (isIP(v4) === 4) return !blocked.check(v4, 'ipv4');
  }
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class WebhookAddressError extends Error {}

export interface WebhookOptions {
  allowPrivateNetworks: boolean;
  timeoutMs: number;
}

/** Checks an address before it is saved: https (or http when private networks are allowed), no credentials, a host name. */
export function checkWebhookUrl(raw: string, allowPrivateNetworks: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookAddressError('This is not a web address');
  }
  if (url.protocol !== 'https:' && !(allowPrivateNetworks && url.protocol === 'http:')) throw new WebhookAddressError('The address must start with https://');
  if (url.username || url.password) throw new WebhookAddressError('Put no user name or password in the address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateNetworks) {
    if (isIP(host) && !isPublicAddress(host)) throw new WebhookAddressError('The address points to a private network');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new WebhookAddressError('The address points to a private network');
  }
  return url;
}

export interface WebhookResult {
  ok: boolean;
  /** HTTP status, or null when no answer came (network error or timeout). */
  status: number | null;
  durationMs: number;
  /** The first part of the answer, for the run log. */
  responseSnippet: string | null;
  error: string | null;
}

const MAX_SNIPPET = 500;

/**
 * POSTs a JSON body. The host name is resolved here and every address it resolves to is
 * checked, and the connection is made to the checked address, so a name cannot be pointed
 * at a private address between the check and the request. Redirects are not followed.
 */
export async function sendWebhook(rawUrl: string, body: string, headers: Record<string, string>, opts: WebhookOptions): Promise<WebhookResult> {
  const started = Date.now();
  const done = (r: Omit<WebhookResult, 'durationMs'>): WebhookResult => ({ ...r, durationMs: Date.now() - started });
  let url: URL;
  try {
    url = checkWebhookUrl(rawUrl, opts.allowPrivateNetworks);
  } catch (e) {
    return done({ ok: false, status: null, responseSnippet: null, error: (e as Error).message });
  }

  const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!opts.allowPrivateNetworks) {
        const bad = list.find((a) => !isPublicAddress(a.address));
        if (bad) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'T2T_PRIVATE_ADDRESS' }), '', 0);
      }
      if ((options as { all?: boolean }).all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };

  return new Promise<WebhookResult>((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Talk2Tax-Webhooks/1', 'content-length': Buffer.byteLength(body).toString(), ...headers },
        lookup: lookup as never,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (size < MAX_SNIPPET) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const snippet = Buffer.concat(chunks).toString('utf8').slice(0, MAX_SNIPPET) || null;
          const ok = status >= 200 && status < 300;
          const error = ok ? null : status >= 300 && status < 400 ? `Answered ${status} (redirects are not followed)` : `Answered ${status}`;
          resolve(done({ ok, status, responseSnippet: snippet, error }));
        });
        res.on('error', (e) => resolve(done({ ok: false, status: null, responseSnippet: null, error: `The answer was cut off: ${e.message}` })));
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error(`No answer within ${opts.timeoutMs / 1000} seconds`), { code: 'T2T_TIMEOUT' })));
    req.on('error', (e: NodeJS.ErrnoException) => {
      const message = e.code === 'T2T_TIMEOUT' || e.code === 'T2T_PRIVATE_ADDRESS' ? e.message : e.code === 'ENOTFOUND' ? `${url.hostname} was not found` : e.code === 'ECONNREFUSED' ? 'The connection was refused' : e.message || 'The request failed';
      resolve(done({ ok: false, status: null, responseSnippet: null, error: message.slice(0, 300) }));
    });
    req.end(body);
  });
}
