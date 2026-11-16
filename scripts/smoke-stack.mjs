#!/usr/bin/env node
/**
 * Smoke test for a running stack (containers or a deployment), through the web app only, the way
 * a browser reaches it: sign up, create an organisation, post a balanced journal, read it back in
 * the trial balance, and check the API's health, request ids and service status.
 *
 *   node scripts/smoke-stack.mjs [web url]      default http://localhost:3000
 *
 * It creates a throwaway account and organisation; do not point it at a production database
 * unless that is acceptable.
 */
import { randomUUID } from 'node:crypto';

const WEB = (process.argv[2] ?? process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
let cookies = '';
const step = (name) => console.log(`✓ ${name}`);
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

async function call(path, init = {}) {
  const r = await fetch(`${WEB}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1', cookie: cookies, ...(init.headers ?? {}) } });
  const set = r.headers.getSetCookie?.() ?? [];
  if (set.length) cookies = set.map((c) => c.split(';')[0]).join('; ');
  const body = await r.json().catch(() => null);
  return { status: r.status, body, headers: r.headers };
}

for (let i = 0; ; i++) {
  const r = await fetch(`${WEB}/login`).catch(() => null);
  if (r?.ok) break;
  if (i > 60) fail(`${WEB}/login did not answer within a minute`);
  await new Promise((res) => setTimeout(res, 1000));
}
step(`web app answers at ${WEB}`);

const status = await call('/api/status');
if (status.status !== 200 || !('maintenance' in (status.body ?? {}))) fail(`service status: ${status.status} ${JSON.stringify(status.body)}`);
step(`service status read (maintenance: ${status.body.maintenance ? status.body.maintenance.state : 'none'})`);

const email = `smoke-${randomUUID()}@example.test`;
const reg = await call('/api/session', { method: 'POST', body: JSON.stringify({ mode: 'register', email, password: `smoke-${randomUUID()}`, name: 'Smoke Test' }) });
if (reg.status !== 200 && reg.status !== 201) fail(`register: ${reg.status} ${JSON.stringify(reg.body)}`);
step('account registered and signed in');

const org = await call('/api/t2t/v1/orgs', { method: 'POST', body: JSON.stringify({ name: `Smoke Test Traders ${email.slice(6, 14)}`, countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 4 }) });
if (org.status !== 201) fail(`create organisation: ${org.status} ${JSON.stringify(org.body)}`);
if (!/^[0-9a-f-]{36}$/.test(org.headers.get('x-request-id') ?? '')) fail('no X-Request-Id on API responses');
const orgId = org.body.id;
step(`organisation created (request ${org.headers.get('x-request-id')})`);

const accounts = await call(`/api/t2t/v1/orgs/${orgId}/accounts`);
const acc = Object.fromEntries((accounts.body ?? []).map((a) => [a.code, a.id]));
if (!acc['1120'] || !acc['4100']) fail('the chart of accounts was not seeded');
const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const j = await call(`/api/t2t/v1/orgs/${orgId}/journals`, { method: 'POST', body: JSON.stringify({ date: day, memo: 'Smoke test', post: true, lines: [{ accountId: acc['1120'], debit: '123.45' }, { accountId: acc['4100'], credit: '123.45' }] }) });
if (j.status !== 201) fail(`post journal: ${j.status} ${JSON.stringify(j.body)}`);
step(`journal ${j.body.entryNumber ?? j.body.number ?? j.body.id} posted`);

const tb = await call(`/api/t2t/v1/orgs/${orgId}/reports/trial-balance?asOf=${day}`);
if (tb.status !== 200 || !JSON.stringify(tb.body).includes('123.45')) fail(`trial balance does not show the journal: ${tb.status}`);
step('trial balance shows it');

const bad = await call(`/api/t2t/v1/orgs/${orgId}/journals`, { method: 'POST', body: JSON.stringify({ date: day, memo: 'Unbalanced', post: true, lines: [{ accountId: acc['1120'], debit: '1' }, { accountId: acc['4100'], credit: '2' }] }) });
if (bad.status < 400 || bad.status >= 500) fail(`an unbalanced journal was not refused: ${bad.status}`);
step('an unbalanced journal is refused');
console.log('Smoke test passed.');
