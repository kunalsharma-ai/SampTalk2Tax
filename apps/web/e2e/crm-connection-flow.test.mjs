/**
 * Browser end-to-end test for connecting an external CRM: an owner makes an API key under
 * Settings → Integrations (shown once), another system uses it through the app's /api/crm
 * address to create a lead (once, by its own id), the owner adds a webhook to a local receiver,
 * sends a test, sees a new lead delivered, and revokes the key. Real Next.js app → real API →
 * real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, receiver, hookUrl;
const consoleErrors = [];
const received = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}
/** Another system calling the CRM API with a key, from outside the browser. */
const crm = async (key, path, body) => {
  const r = await fetch(`${WEB}/api/crm${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail(`Timed out waiting for ${what}`);
};

before(async () => {
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${receiver.address().port}/talk2tax`;
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('dialog', (d) => d.accept());
});
after(async () => {
  await browser?.close();
  await new Promise((r) => receiver.close(r));
});

test('an owner connects an external CRM with an API key and a webhook', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Connector Owner');
  await page.getByLabel('Email').fill(`e2e-crmapi-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Connected Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;

  // The API key, shown once.
  await page.goto(`${base}/settings/integrations`);
  const keys = page.getByRole('region', { name: 'CRM API keys' });
  await keys.getByLabel('Key name').fill('Website form');
  await keys.getByLabel('Can create and change records').check();
  await keys.getByRole('button', { name: 'Make key' }).click();
  const shown = keys.getByRole('status', { name: 'New API key' });
  const key = (await shown.locator('code').innerText()).trim();
  assert.match(key, /^t2t_[a-z0-9]{8}_[A-Za-z0-9]{40}$/);
  await keys.getByRole('table', { name: 'API keys' }).getByRole('cell', { name: 'Website form', exact: true }).waitFor();
  await page.reload();
  assert.equal(await page.getByRole('region', { name: 'CRM API keys' }).getByText(key).count(), 0, 'the key is not shown again');

  // Another system uses it.
  assert.equal((await crm('t2t_badbadba_' + 'x'.repeat(40), '/me')).status, 401);
  const me = await crm(key, '/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.key.scopes, ['crm.read', 'crm.write']);

  // The webhook, its secret shown once, and a test.
  const hooks = page.getByRole('region', { name: 'CRM webhooks' });
  await hooks.getByLabel('Webhook name').fill('Sales CRM');
  await hooks.getByLabel('Address to send to').fill(hookUrl);
  await hooks.getByRole('button', { name: 'Add webhook' }).click();
  const secret = (await hooks.getByRole('status', { name: 'Signing secret' }).locator('code').innerText()).trim();
  assert.match(secret, /^whsec_/);
  const item = hooks.getByRole('listitem', { name: 'Sales CRM' });
  await item.getByRole('button', { name: 'Send test' }).click();
  await item.getByRole('status', { name: 'Test of Sales CRM' }).getByText('Test received').waitFor();
  assert.equal(received.at(-1).json.event, 'ping');

  // A lead from the other system, sent twice with its id, made once and delivered once, signed.
  const lead = await crm(key, '/leads', { name: 'Ravi Kumar', company: 'Kumar Foods', source: 'WEBSITE', externalRef: 'form-42' });
  assert.equal(lead.status, 201);
  assert.equal((await crm(key, '/leads', { name: 'Ravi Kumar', source: 'WEBSITE', externalRef: 'form-42' })).status, 200);
  await until(() => received.some((r) => r.json.event === 'lead.created'), 'the lead.created delivery');
  const delivered = received.find((r) => r.json.event === 'lead.created');
  assert.equal(received.filter((r) => r.json.event === 'lead.created').length, 1);
  assert.equal(delivered.json.object.externalRef, 'form-42');
  const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(delivered.headers['t2t-signature']);
  assert.equal(v1, createHmac('sha256', secret).update(`${t}.${delivered.body}`).digest('hex'));

  await item.getByRole('button', { name: 'Deliveries' }).click();
  const table = item.getByRole('table', { name: 'Deliveries to Sales CRM' });
  await table.getByRole('cell', { name: 'lead.created' }).waitFor();
  assert.equal(await table.getByText('Delivered').count(), 2);

  // The lead is in the app, and the audit trail names the key.
  const leads = await call(`${B}/crm/leads`);
  assert.deepEqual(leads.body.leads.map((l) => l.name), ['Ravi Kumar']);

  // Revoking stops the key at once.
  await page.getByRole('button', { name: 'Revoke Website form' }).click();
  await page.getByRole('region', { name: 'CRM API keys' }).getByText('Revoked').first().waitFor();
  assert.equal((await crm(key, '/me')).status, 401);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
