/**
 * A local OpenID Connect provider and DNS server for tests only (SEC-006). The API's real single
 * sign-on code (discovery, the authorization code flow with PKCE, ID token checks) runs against
 * it when the API runs with SSO_ALLOW_PRIVATE_NETWORKS=true, and checks domains' TXT records
 * against the DNS server when SSO_DNS_SERVERS points to it.
 *
 *   const idp = await startOidcStandIn(4558, { dnsPort: 4559 });
 *   idp.issuer, idp.clientId, idp.clientSecret
 *   idp.txt.set('_talk2tax-verification.example.test', ['talk2tax-verification=…']);
 *   idp.next = { emailVerified: false } | { wrongKey: true } | { email: 'x@y' } | { nonce: 'other' }   // the next ID token only
 *   await idp.approve(authorizationUrl, 'someone@example.test')   // as if they signed in: the redirect back
 *
 * Its sign-in page (GET /authorize) has an email field and Sign in and Cancel buttons.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';

const b64url = (b) => Buffer.from(b).toString('base64url');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function signJwt(claims, privateKey, kid) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(claims));
  const s = createSign('RSA-SHA256');
  s.update(`${head}.${body}`);
  return `${head}.${body}.${s.sign(privateKey).toString('base64url')}`;
}

/** A DNS server that answers TXT questions from a map; everything else is NXDOMAIN. */
function startDns(port, txt) {
  const sock = createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 12) return;
    let i = 12;
    const labels = [];
    while (i < msg.length && msg[i] !== 0) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString('ascii'));
      i += msg[i] + 1;
    }
    const qEnd = i + 5;
    const qtype = msg.readUInt16BE(i + 1);
    const name = labels.join('.').toLowerCase();
    const values = qtype === 16 ? txt.get(name) : undefined;
    const answers = (values ?? []).map((v) => {
      const data = Buffer.from(v, 'utf8');
      const chunks = [];
      for (let o = 0; o < data.length; o += 255) {
        const part = data.subarray(o, o + 255);
        chunks.push(Buffer.from([part.length]), part);
      }
      const rdata = Buffer.concat(chunks);
      const rr = Buffer.alloc(12);
      rr.writeUInt16BE(0xc00c, 0);
      rr.writeUInt16BE(16, 2);
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(60, 6);
      rr.writeUInt16BE(rdata.length, 10);
      return Buffer.concat([rr, rdata]);
    });
    const head = Buffer.alloc(12);
    msg.copy(head, 0, 0, 2);
    const known = txt.has(name);
    head.writeUInt16BE(0x8180 | (known ? 0 : 3), 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(answers.length, 6);
    sock.send(Buffer.concat([head, msg.subarray(12, qEnd), ...answers]), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => sock.bind(port, '127.0.0.1', () => resolve(sock)));
}

export async function startOidcStandIn(port = 4558, opts = {}) {
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `k-${randomBytes(4).toString('hex')}`;
  const state = {
    issuer,
    clientId: opts.clientId ?? `t2t-${randomBytes(4).toString('hex')}`,
    clientSecret: opts.clientSecret ?? randomBytes(18).toString('base64url'),
    codes: new Map(),
    txt: new Map(),
    next: null,
    tokens: [],
    requests: [],
  };

  const issueCode = (q, email) => {
    const code = randomBytes(18).toString('base64url');
    state.codes.set(code, { clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), email, at: Date.now() });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    return back.toString();
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    const json = (status, v) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== state.clientId) return json(400, { error: 'invalid_client' });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(400, { error: 'invalid_request', error_description: 'PKCE is required' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      const hidden = [...q.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
      return res.end(`<!doctype html><title>Stand-in identity provider</title><h1>Stand-in identity provider</h1>
<form method="get" action="/authorize/approve">${hidden}<label>Email <input name="email" value="${esc(q.get('login_hint') ?? '')}"></label><button>Sign in</button></form>
<form method="get" action="/authorize/deny">${hidden}<button>Cancel</button></form>`);
    }
    if (url.pathname === '/authorize/approve' || url.pathname === '/authorize/deny') {
      const q = url.searchParams;
      if (url.pathname === '/authorize/deny') {
        const back = new URL(q.get('redirect_uri'));
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user cancelled the sign-in');
        back.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      res.writeHead(302, { location: issueCode(q, q.get('email')) });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      let id = form.get('client_id');
      let secret = form.get('client_secret');
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
      if (basic) [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent);
      if (id !== state.clientId || secret !== state.clientSecret) return json(401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      const c = state.codes.get(form.get('code') ?? '');
      state.codes.delete(form.get('code') ?? '');
      if (!c || c.clientId !== id || c.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant', error_description: 'The code is not valid' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const n = state.next ?? {};
      state.next = null;
      const now = Math.floor(Date.now() / 1000);
      const email = n.email ?? c.email;
      const claims = { iss: issuer, sub: `sub-${createHash('sha256').update(email).digest('hex').slice(0, 16)}`, aud: n.aud ?? state.clientId, exp: now + 300, iat: now, nonce: n.nonce ?? c.nonce, email, email_verified: n.emailVerified ?? true, name: n.name ?? email.split('@')[0].replace(/[._]/g, ' ') };
      const idToken = signJwt(claims, n.wrongKey ? other.privateKey : privateKey, kid);
      state.tokens.push(claims);
      return json(200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const dns = opts.dnsPort ? await startDns(opts.dnsPort, state.txt) : null;

  return Object.assign(state, {
    /** As if the person signed in on the provider's page: the address the provider sends the browser back to. */
    async approve(authorizationUrl, email) {
      const q = new URL(authorizationUrl).searchParams;
      if (q.get('client_id') !== state.clientId) throw new Error('Another client');
      return issueCode(q, email);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      dns?.close();
    },
  });
}
