import { createHash, createPublicKey, randomBytes, verify as verifySignature, type KeyObject } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { isPublicAddress } from '../workflows/webhook';

/**
 * A small OpenID Connect relying party (SEC-006/007): discovery, the authorization code flow with
 * PKCE, and ID token checks (signature against the provider's published keys, issuer, audience,
 * expiry and nonce). Requests to the provider go only to public https addresses: the host name is
 * resolved and checked here, the connection is made to the checked address, and redirects are not
 * followed, because the provider's address is entered by an organisation's admin.
 */

export class OidcError extends Error {}

/** A public key as the provider publishes it (RFC 7517). */
export type Jwk = { kty?: string; kid?: string; use?: string; alg?: string; [k: string]: unknown };

export interface OidcHttpOptions {
  allowPrivateNetworks: boolean;
  timeoutMs?: number;
}

const MAX_BODY = 256 * 1024;

/** Checks a provider address: https (or http when private networks are allowed), no credentials, not a private host. */
export function checkProviderUrl(raw: string, allowPrivateNetworks: boolean, what = 'The address'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError(`${what} is not a web address`);
  }
  if (url.protocol !== 'https:' && !(allowPrivateNetworks && url.protocol === 'http:')) throw new OidcError(`${what} must start with https://`);
  if (url.username || url.password) throw new OidcError(`Put no user name or password in ${what.toLowerCase()}`);
  if (url.hash) throw new OidcError(`${what} has no #part`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivateNetworks) {
    if (isIP(host) && !isPublicAddress(host)) throw new OidcError(`${what} points to a private network`);
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new OidcError(`${what} points to a private network`);
  }
  return url;
}

/** One request to the provider; the answer's status and body (at most 256 KB). */
export async function providerRequest(rawUrl: string, opts: OidcHttpOptions & { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  const url = checkProviderUrl(rawUrl, opts.allowPrivateNetworks);
  const timeoutMs = opts.timeoutMs ?? 8000;
  const lookup = (hostname: string, options: object, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!opts.allowPrivateNetworks && list.some((a) => !isPublicAddress(a.address))) return cb(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'T2T_PRIVATE_ADDRESS' }), '', 0);
      if ((options as { all?: boolean }).all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'Talk2Tax-SSO/1', ...opts.headers };
    if (opts.body !== undefined) headers['content-length'] = Buffer.byteLength(opts.body).toString();
    const req = client.request(url, { method: opts.method ?? 'GET', headers, lookup: lookup as never, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) return req.destroy(new OidcError(`The answer from ${url.host} is too large`));
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => reject(new OidcError(`The answer from ${url.host} was cut off: ${e.message}`)));
    });
    req.on('timeout', () => req.destroy(new OidcError(`${url.host} did not answer within ${timeoutMs / 1000} seconds`)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e instanceof OidcError) return reject(e);
      const message = e.code === 'T2T_PRIVATE_ADDRESS' ? e.message : e.code === 'ENOTFOUND' ? `${url.hostname} was not found` : e.code === 'ECONNREFUSED' ? `${url.host} refused the connection` : `Could not reach ${url.host}: ${e.message}`;
      reject(new OidcError(message));
    });
    req.end(opts.body);
  });
}

async function getJson(url: string, opts: OidcHttpOptions, what: string): Promise<Record<string, unknown>> {
  const r = await providerRequest(url, opts);
  if (r.status !== 200) throw new OidcError(`${what} answered ${r.status}${r.status >= 300 && r.status < 400 ? ' (redirects are not followed)' : ''}`);
  try {
    const v = JSON.parse(r.body) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new OidcError(`${what} did not answer with JSON`);
  }
}

export interface OidcProvider {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** client_secret_basic unless the provider supports only client_secret_post. */
  tokenAuth: 'client_secret_basic' | 'client_secret_post';
}

/** The issuer as entered: no trailing slash, and the comparison with the provider's own is exact. */
export function normaliseIssuer(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/** Reads the provider's /.well-known/openid-configuration and checks it names the same issuer. */
export async function discover(issuer: string, opts: OidcHttpOptions): Promise<OidcProvider> {
  const iss = normaliseIssuer(issuer);
  checkProviderUrl(iss, opts.allowPrivateNetworks, 'The issuer');
  const doc = await getJson(`${iss}/.well-known/openid-configuration`, opts, 'The provider’s discovery document');
  if (typeof doc.issuer !== 'string' || normaliseIssuer(doc.issuer) !== iss) throw new OidcError(`The provider calls itself ${typeof doc.issuer === 'string' ? doc.issuer : 'nothing'}, not ${iss}`);
  const str = (k: string) => {
    const v = doc[k];
    if (typeof v !== 'string' || !v) throw new OidcError(`The provider’s discovery document has no ${k}`);
    checkProviderUrl(v, opts.allowPrivateNetworks, `The provider’s ${k}`);
    return v;
  };
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? (doc.token_endpoint_auth_methods_supported as unknown[]) : null;
  const tokenAuth = !methods || methods.includes('client_secret_basic') ? 'client_secret_basic' : methods.includes('client_secret_post') ? 'client_secret_post' : null;
  if (!tokenAuth) throw new OidcError('The provider supports neither client_secret_basic nor client_secret_post for the token endpoint');
  const types = doc.response_types_supported;
  if (Array.isArray(types) && !types.includes('code')) throw new OidcError('The provider does not support the authorization code flow');
  return { issuer: doc.issuer as string, authorizationEndpoint: str('authorization_endpoint'), tokenEndpoint: str('token_endpoint'), jwksUri: str('jwks_uri'), tokenAuth };
}

const b64url = (b: Buffer) => b.toString('base64url');

/** A random value for state, nonce or the PKCE verifier. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

export function authorizationUrl(p: OidcProvider, a: { clientId: string; redirectUri: string; state: string; nonce: string; codeVerifier: string; loginHint?: string }): string {
  const u = new URL(p.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', a.clientId);
  u.searchParams.set('redirect_uri', a.redirectUri);
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', a.state);
  u.searchParams.set('nonce', a.nonce);
  u.searchParams.set('code_challenge', pkceChallenge(a.codeVerifier));
  u.searchParams.set('code_challenge_method', 'S256');
  if (a.loginHint) u.searchParams.set('login_hint', a.loginHint);
  return u.toString();
}

/** Swaps the authorization code for tokens; returns the ID token. */
export async function exchangeCode(p: OidcProvider, a: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }, opts: OidcHttpOptions): Promise<string> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri, code_verifier: a.codeVerifier });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (p.tokenAuth === 'client_secret_basic') {
    const enc = (s: string) => encodeURIComponent(s);
    headers.authorization = `Basic ${Buffer.from(`${enc(a.clientId)}:${enc(a.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', a.clientId);
    form.set('client_secret', a.clientSecret);
  }
  const r = await providerRequest(p.tokenEndpoint, { ...opts, method: 'POST', headers, body: form.toString() });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  if (r.status !== 200) {
    const why = typeof body.error_description === 'string' ? body.error_description : typeof body.error === 'string' ? body.error : `answered ${r.status}`;
    throw new OidcError(`The provider refused the sign-in code: ${why.slice(0, 200)}`);
  }
  if (typeof body.id_token !== 'string') throw new OidcError('The provider sent no ID token');
  return body.id_token;
}

const ALGS: Record<string, { hash: string; kty: string; pss?: boolean; dsa?: boolean }> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', dsa: true },
  ES384: { hash: 'sha384', kty: 'EC', dsa: true },
};

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  [k: string]: unknown;
}

function parseJson(part: string, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
    if (!v || typeof v !== 'object') throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new OidcError(`The ID token's ${what} is not valid`);
  }
}

/**
 * Checks an ID token: its signature with one of the provider's keys (by kid, or the only key of
 * the right type), then iss, aud (and azp when there are several audiences), exp, iat and nonce.
 * HS* and "none" are refused: the signature must come from the provider's published keys.
 */
export function verifyIdToken(token: string, keys: readonly Jwk[], expect: { issuer: string; clientId: string; nonce: string; now?: Date; skewSeconds?: number }): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('The ID token is not a signed token');
  const header = parseJson(parts[0]!, 'header');
  const alg = typeof header.alg === 'string' ? header.alg : '';
  const spec = ALGS[alg];
  if (!spec) throw new OidcError(`The ID token is signed with ${alg || 'no algorithm'}, which is not accepted`);
  const candidates = keys.filter((k) => k.kty === spec.kty && (k.use === undefined || k.use === 'sig') && (!k.alg || k.alg === alg));
  const kid = typeof header.kid === 'string' ? header.kid : null;
  const chosen = kid ? candidates.filter((k) => k.kid === kid) : candidates;
  if (chosen.length !== 1) throw new OidcError(kid ? `The provider publishes no key ${kid}` : 'The ID token names no key and the provider publishes more than one');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: chosen[0]! as never, format: 'jwk' });
  } catch {
    throw new OidcError('The provider’s signing key cannot be read');
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
  const signature = Buffer.from(parts[2]!, 'base64url');
  const ok = verifySignature(spec.hash, signed, spec.dsa ? { key, dsaEncoding: 'ieee-p1363' } : spec.pss ? { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 } : key, signature);
  if (!ok) throw new OidcError('The ID token’s signature does not match the provider’s key');

  const c = parseJson(parts[1]!, 'claims') as IdTokenClaims;
  const now = Math.floor((expect.now ?? new Date()).getTime() / 1000);
  const skew = expect.skewSeconds ?? 120;
  if (typeof c.iss !== 'string' || normaliseIssuer(c.iss) !== normaliseIssuer(expect.issuer)) throw new OidcError('The ID token comes from another issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(expect.clientId)) throw new OidcError('The ID token is for another application');
  if (aud.length > 1 && c.azp !== expect.clientId) throw new OidcError('The ID token is for another application');
  if (typeof c.exp !== 'number' || c.exp + skew < now) throw new OidcError('The ID token has expired');
  if (typeof c.iat === 'number' && c.iat - skew > now) throw new OidcError('The ID token is dated in the future');
  if (c.nonce !== expect.nonce) throw new OidcError('The ID token is not for this sign-in');
  if (typeof c.sub !== 'string' || !c.sub) throw new OidcError('The ID token names no user');
  return c;
}

/** The provider's published signing keys. */
export async function fetchKeys(p: OidcProvider, opts: OidcHttpOptions): Promise<Jwk[]> {
  const doc = await getJson(p.jwksUri, opts, 'The provider’s key set');
  if (!Array.isArray(doc.keys)) throw new OidcError('The provider’s key set has no keys');
  return doc.keys as Jwk[];
}

/** A lower-case domain name, or null when it is not one. */
export function normaliseDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/\.$/, '');
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  return d;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}
