/**
 * Browser end-to-end test for supplier tax validation (AP-019): two vendors share a GSTIN, one
 * vendor is unregistered, Purchases → Supplier tax checks lists them, and on a vendor's
 * page a GST portal check is recorded as cancelled, which flags the bill dated after it.
 * Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { chromium } from 'playwright';

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const gstin = (state, pan) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('29', 'ZZZCS0301Z');
const STEEL = gstin('29', 'ZZZCS0302Z');
const PAPER = gstin('29', 'ZZZCS0303Z');

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
let browser, page;
const consoleErrors = [];

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('vendor GSTINs are checked against each other, their bills and a recorded portal check', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Supplier Tax Owner');
  await page.getByLabel('Email').fill(`e2e-supplier-tax-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Supplier Tax Traders');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const B = `/v1/orgs/${orgId}`;
  const O = `${WEB}/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${B}/accounts`)).body.map((a) => [a.code, a.id]));
  assert.equal((await call(`${B}/gst/registration`, { gstin: OWN, effectiveFrom: addDays(T, -90) }, 'PUT')).status, 200);
  const g18 = (await call(`${B}/tax-rates`, { name: 'GST 18%', rate: '18', kind: 'GST' })).body;
  const vendor = async (body) => { const r = await call(`${B}/contacts`, { isVendor: true, ...body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const steel = await vendor({ name: 'Tunga Steel Pvt Ltd', gstin: STEEL });
  await vendor({ name: 'Chola Paper Mills', gstin: PAPER });
  await vendor({ name: 'Chola Paper Mills (Hosur)', gstin: PAPER });
  const cash = await vendor({ name: 'Corner Hardware', stateCode: '29' });
  const bill = async (contactId, amount, issueDate) => {
    const r = await call(`${B}/purchases/documents`, { kind: 'BILL', contactId, issueDate, lines: [{ accountId: acc['1300'], description: 'Stock', quantity: '1', unitPrice: amount, taxRateId: g18.id, hsnCode: '7208' }], post: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  await bill(steel.id, '10000.00', addDays(T, -20));
  const late = await bill(steel.id, '5000.00', addDays(T, -4));

  // The report lists the two vendors sharing a GSTIN; the unregistered vendor shows only under All.
  await page.goto(`${O}/purchases/vendors`);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Supplier tax checks' }).click();
  await page.waitForURL(/\/purchases\/supplier-tax$/);
  const list = page.locator('[aria-label="Vendors"]');
  await list.getByRole('row', { name: /Chola Paper Mills \(Hosur\)/ }).getByText(/The same GSTIN is on Chola Paper Mills\./).waitFor();
  await list.getByRole('row', { name: /Tunga Steel/ }).getByText('Not checked').waitFor();
  assert.equal(await list.getByRole('row', { name: /Corner Hardware/ }).count(), 0);
  await list.getByLabel('Which vendors').selectOption('all');
  await list.getByRole('row', { name: /Corner Hardware/ }).getByText('No problems').waitFor();
  await list.getByLabel('Which vendors').selectOption('high');
  await list.getByText('Nothing to look at').waitFor();

  // Record what the portal showed for the steel vendor: cancelled from ten days ago.
  await page.goto(`${O}/purchases/vendors/${steel.id}`);
  const card = page.locator('[aria-label="Tax checks"]');
  await card.getByText('not checked on the portal').waitFor();
  await card.getByText(/Nobody has recorded a check of this GSTIN/).waitFor();
  assert.equal(await card.getByRole('link', { name: 'GST portal search' }).getAttribute('href'), 'https://services.gst.gov.in/services/searchtp');
  await card.getByRole('button', { name: 'Record portal check' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('GSTIN status').selectOption('CANCELLED');
  await dialog.getByLabel('Cancelled from').fill(addDays(T, -10));
  await dialog.getByLabel('Legal name on the portal').fill('TUNGA STEEL PRIVATE LIMITED');
  await dialog.getByLabel('Note').fill('Cancelled suo motu');
  await dialog.getByRole('button', { name: 'Record check' }).click();
  await dialog.waitFor({ state: 'detached' });
  await card.getByText(/the GST portal showed this GSTIN as cancelled/).waitFor();
  await card.getByRole('link', { name: late.number }).waitFor();
  const checks = card.getByRole('table', { name: 'Portal checks' });
  await checks.getByText('Cancelled suo motu').waitFor();
  await checks.getByText('Supplier Tax Owner').waitFor();

  await page.goto(`${O}/purchases/supplier-tax`);
  await list.getByLabel('Which vendors').selectOption('high');
  await list.getByRole('row', { name: /Tunga Steel/ }).getByText('Cancelled').first().waitFor();
  assert.equal(await list.locator('tbody tr').count(), 1);
  assert.deepEqual(consoleErrors.filter((e) => !/40[0-9]|Failed to load resource/.test(e)), []);
});
