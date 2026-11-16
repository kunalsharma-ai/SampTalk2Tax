import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWebhookUrl, isPublicAddress, sendWebhook, signPayload } from '../src/workflows/webhook';

/** The webhook sender on its own: signatures, the private-network guard, timeouts and redirects. */
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 3000);
    if (req.url === '/moved') return void res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

describe('webhook sender', () => {
  it('signs "<t>.<body>" with HMAC-SHA256', () => {
    const at = new Date('2026-11-02T10:00:00Z');
    const sig = signPayload('whsec_test', '{"a":1}', at);
    expect(sig).toBe(`t=${at.getTime() / 1000},v1=${createHmac('sha256', 'whsec_test').update(`${at.getTime() / 1000}.{"a":1}`).digest('hex')}`);
  });

  it('knows private, loopback, link-local and reserved addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'not-an-ip']) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('refuses addresses that are not public https, unless private networks are allowed', () => {
    expect(() => checkWebhookUrl('http://example.com/x', false)).toThrow('must start with https://');
    expect(() => checkWebhookUrl('https://user:pw@example.com/x', false)).toThrow('no user name or password');
    expect(() => checkWebhookUrl('https://127.0.0.1/x', false)).toThrow('private network');
    expect(() => checkWebhookUrl('https://[::1]/x', false)).toThrow('private network');
    expect(() => checkWebhookUrl('https://localhost/x', false)).toThrow('private network');
    expect(() => checkWebhookUrl('https://metadata.internal/x', false)).toThrow('private network');
    expect(() => checkWebhookUrl('nonsense', false)).toThrow('not a web address');
    expect(checkWebhookUrl('https://hooks.example.com/t2t?x=1', false).hostname).toBe('hooks.example.com');
    expect(checkWebhookUrl('http://127.0.0.1:9/x', true).port).toBe('9');
  });

  it('does not send to a private address when private networks are not allowed', async () => {
    const r = await sendWebhook(`https://127.0.0.1:1/x`, '{}', {}, { allowPrivateNetworks: false, timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: null, error: 'The address points to a private network' });
  });

  it('gives up after the timeout, and does not follow redirects', async () => {
    const slow = await sendWebhook(`${base}/slow`, '{}', {}, { allowPrivateNetworks: true, timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, status: null, error: 'No answer within 0.3 seconds' });
    expect(slow.durationMs).toBeLessThan(2000);
    const moved = await sendWebhook(`${base}/moved`, '{}', {}, { allowPrivateNetworks: true, timeoutMs: 1000 });
    expect(moved).toMatchObject({ ok: false, status: 302, error: 'Answered 302 (redirects are not followed)' });
    expect(await sendWebhook(`${base}/fine`, '{}', {}, { allowPrivateNetworks: true, timeoutMs: 1000 })).toMatchObject({ ok: true, status: 200, responseSnippet: 'ok' });
  });
});
