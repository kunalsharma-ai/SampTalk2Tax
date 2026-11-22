/**
 * Browser end-to-end test for business trips (EXP-007): an employee requests a trip with an
 * estimate, the owner approves it, the employee links an approved claim and a draft one, and the
 * trip shows its cost against the estimate with the line dated outside the trip.
 * Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10); // not money
const fiscalYear = (d) => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) + 1 : Number(d.slice(0, 4)));
let browser;
const consoleErrors = [];

before(async () => {
  browser = await chromium.launch();
});
after(async () => browser?.close());

async function register(name) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  const email = `e2e-trips-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  return { page, email };
}

const call = (page, path, body, method) =>
  page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
const must = async (p) => {
  const r = await p;
  assert.ok(r.status < 300, JSON.stringify(r));
  return r.body;
};

test('an employee requests a trip, the owner approves it and claims are linked', async () => {
  const traveller = await register('Tara Traveller');
  const owner = await register('Trip Owner');
  await owner.page.getByLabel('Organisation name').fill('E2E Trips Co');
  await owner.page.getByRole('button', { name: 'Create organisation' }).click();
  await owner.page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.page.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  for (const fy of new Set([day(12), T].map(fiscalYear))) await call(owner.page, `${B}/periods/fiscal-years`, { fiscalYear: fy });
  await must(call(owner.page, `${B}/members`, { email: traveller.email, role: 'EMPLOYEE' }));
  const acc = Object.fromEntries((await must(call(owner.page, `${B}/accounts`))).map((a) => [a.code, a.id]));
  consoleErrors.length = 0; // the refused years log a 409 in the console; only the pages' own errors count below

  // The employee requests the trip.
  const page = traveller.page;
  await page.goto(base);
  await page.getByRole('link', { name: 'My business trips' }).click();
  await page.waitForURL(/\/expenses\/trips$/);
  await page.getByLabel('Purpose').fill('Client workshop');
  await page.getByLabel('Destination').fill('Pune');
  await page.getByLabel('Leaving on').fill(day(10));
  await page.getByLabel('Back on').fill(day(8));
  await page.getByLabel('Travel and transport').fill('12000');
  await page.getByLabel('Hotels and lodging').fill('9000');
  await page.getByLabel('Meals and daily allowance').fill('3000');
  await page.getByRole('button', { name: 'Request trip' }).click();
  await page.waitForURL(/\/expenses\/trips\/[0-9a-f-]{36}$/);
  const tripUrl = page.url();
  await page.getByText('Waiting for approval').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve trip' }).count(), 0);

  // The owner approves it.
  await owner.page.goto(tripUrl.replace(/^.*\/orgs\//, `${WEB}/orgs/`));
  await owner.page.getByLabel('Note').fill('Within budget');
  await Promise.all([owner.page.waitForResponse((r) => r.url().endsWith('/approve') && r.ok()), owner.page.getByRole('button', { name: 'Approve trip' }).click()]);
  await owner.page.getByText('Approved by Trip Owner', { exact: false }).waitFor();

  // Claims: one approved, one draft with a line after the trip.
  const approved = await must(call(page, `${B}/expense-claims`, { title: 'Pune flights and hotel', lines: [{ date: day(10), accountId: acc['6600'], amount: '13000.00' }, { date: day(9), accountId: acc['6200'], amount: '6000.00' }] }));
  await must(call(page, `${B}/expense-claims/${approved.id}/submit`, {}));
  await must(call(owner.page, `${B}/expense-claims/${approved.id}/approve`, {}));
  const draft = await must(call(page, `${B}/expense-claims`, { title: 'Pune taxis', lines: [{ date: day(8), accountId: acc['6200'], amount: '3000.00' }, { date: day(2), accountId: acc['6600'], amount: '7000.00' }] }));

  await page.reload();
  for (const c of [approved, draft]) {
    await page.getByLabel('Link a claim').selectOption(c.id);
    await Promise.all([page.waitForResponse((r) => r.url().endsWith('/claims') && r.ok()), page.getByRole('button', { name: 'Link claim' }).click()]);
    await page.getByRole('table', { name: 'Claims on this trip' }).getByText(c.number).waitFor();
  }
  const claims = await page.getByRole('table', { name: 'Claims on this trip' }).innerText();
  assert.match(claims, /Pune flights and hotel[\s\S]*Approved/);
  assert.match(claims, /Pune taxis[\s\S]*Draft[\s\S]*Unlink/);
  await page.getByText('Claims come to 5000.00 (20.8%) more than the estimate.').waitFor();
  assert.equal(await page.getByText(`${draft.number} line 2`, { exact: false }).count(), 1);
  const cats = await page.getByRole('table', { name: 'Trip costs by category' }).innerText();
  assert.match(cats, /13,000\.00[\s\S]*7,000\.00/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/expense-trip.png`, fullPage: true });

  await page.goto(`${base}/expenses/trips`);
  const list = await page.getByRole('table', { name: 'Trips' }).innerText();
  assert.match(list, /TRIP-0001[\s\S]*Tara Traveller[\s\S]*Client workshop[\s\S]*Pune[\s\S]*Approved[\s\S]*24,000\.00\s+2/);
  assert.deepEqual(consoleErrors, []);
});
