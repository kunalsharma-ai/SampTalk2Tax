/**
 * Browser end-to-end test for report exports: an owner posts an invoice and a bill, then
 * downloads the trial balance, profit and loss, receivables ageing and profit by department as
 * CSV, Excel and PDF from the report pages, and sees a bad date range refused on screen instead
 * of a downloaded error. Real Next.js app → real API → real PostgreSQL. The downloaded files are
 * read back and checked against the figures on screen.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, context, page;
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
async function download(name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name }).click()]);
  const path = join(tmpdir(), `${randomUUID()}-${dl.suggestedFilename()}`);
  await dl.saveAs(path);
  await page.getByRole('status').filter({ hasText: `Downloaded ${dl.suggestedFilename()}` }).waitFor();
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) };
}

before(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner exports reports as CSV, Excel and PDF from the report pages', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Export Owner');
  await page.getByLabel('Email').fill(`e2e-exports-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Export House');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: '@Lotus Retail', isCustomer: true })).body;
  const vendor = (await call(`${base}/contacts`, { name: 'Granite Supplies', isVendor: true })).body;
  const dept = (await call(`${base}/dimensions`, { type: 'DEPARTMENT', code: 'OPS', name: 'Operations' })).body;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  assert.equal((await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: today, post: true, lines: [{ accountId: acc['4100'], description: 'Fittings', quantity: '1', unitPrice: '250000.00', departmentId: dept.id }] })).status, 201);
  assert.equal((await call(`${base}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: today, post: true, lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: '1200.50' }] })).status, 201);

  // Trial balance: CSV matches the screen; Excel is a workbook; PDF is a PDF.
  await page.getByRole('link', { name: 'Trial balance', exact: true }).click();
  await page.getByRole('cell', { name: 'Accounts Receivable' }).waitFor();
  const csv = await download('Export as CSV');
  assert.equal(csv.name, `trial-balance-${today}.csv`);
  const text = csv.bytes.toString('utf8');
  assert.ok(text.startsWith('﻿Trial balance\r\nE2E Export House\r\n'));
  assert.match(text, /\r\n1200,Accounts Receivable,Asset,250000\.00,0\.00,250000\.00,0\.00\r\n/);
  assert.match(text, /\r\n,Total,,251200\.50,251200\.50,/);
  const xlsx = await download('Export as Excel');
  assert.equal(xlsx.name, `trial-balance-${today}.xlsx`);
  assert.equal(xlsx.bytes.readUInt32LE(0), 0x04034b50);
  assert.ok(xlsx.bytes.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  const pdf = await download('Export as PDF');
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');

  // Receivables ageing: a name that starts like a formula stays text.
  await page.getByRole('link', { name: 'Receivables ageing', exact: true }).click();
  await page.getByText('@Lotus Retail').first().waitFor();
  const ageing = (await download('Export as CSV')).bytes.toString('utf8');
  assert.match(ageing, /\r\n'@Lotus Retail,250000\.00,0\.00,0\.00,0\.00,0\.00,0\.00,250000\.00\r\n/);

  // Profit by department and the general ledger.
  await page.goto(`${WEB}/orgs/${orgId}/reports/profit-by-dimension`);
  await page.getByText('Fittings').or(page.getByText('Sales Revenue')).first().waitFor();
  const pd = (await download('Export as CSV')).bytes.toString('utf8');
  assert.match(pd, /Code,Account,OPS,Not assigned,Total/);
  assert.match(pd, /,Net profit,250000\.00,-1200\.50,248799\.50/);
  await page.goto(`${WEB}/orgs/${orgId}/reports/general-ledger`);
  assert.equal(await page.getByRole('button', { name: 'Export as PDF' }).isDisabled(), true);
  await page.getByLabel('Account', { exact: true }).selectOption(acc['1200']);
  await page.getByText(/JE-0000/).first().waitFor();
  const gl = await download('Export as PDF');
  assert.match(gl.name, /^general-ledger-1200-/);

  // A bad range is refused on screen; nothing downloads.
  await page.goto(`${WEB}/orgs/${orgId}/reports/income-statement`);
  await page.getByRole('textbox', { name: 'From' }).fill('2026-12-01');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('2026-11-01');
  let downloaded = false;
  page.once('download', () => (downloaded = true));
  await page.getByRole('button', { name: 'Export as Excel' }).click();
  await page.getByRole('alert').filter({ hasText: 'The start must be on or before the end date' }).waitFor();
  assert.equal(downloaded, false);

  // Every export is in the audit log.
  const events = (await call(`${base}/audit-events?entityType=report&limit=50`)).body;
  const list = Array.isArray(events) ? events : events.items;
  assert.equal(list.filter((e) => e.action === 'report.exported').length, 6);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
