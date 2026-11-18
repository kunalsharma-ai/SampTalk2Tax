/**
 * Browser end-to-end test for EXP-022 anomaly checks: after ten ordinary approved claims for a
 * category, an employee claims a receipt about six times the usual; the claim shows it under
 * "Worth a second look" with the reason, it still submits, and the owner sees the same before
 * approving. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const day = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body, method) {
  return page.evaluate(
    async ([p, b, m]) => {
      const r = await fetch(`/api/t2t${p}`, { method: m ?? (b ? 'POST' : 'GET'), headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

async function register(page, name, email) {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
}

before(async () => {
  browser = await chromium.launch();
  owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  employee = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a claim far above the usual is flagged for a second look', async () => {
  await register(owner, 'Anomaly Owner', `e2e-anomaly-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Expense Anomalies Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = owner.url().split('/').pop();
  const api = `/v1/orgs/${orgId}`;
  const employeeEmail = `e2e-anomaly-${randomUUID()}@example.test`;
  await register(employee, 'Travelling Employee', employeeEmail);
  assert.equal((await call(owner, `${api}/members`, { email: employeeEmail, role: 'EMPLOYEE' })).status, 201);
  const acc = Object.fromEntries((await call(owner, `${api}/accounts`)).body.map((a) => [a.code, a.id]));

  for (let i = 0; i < 10; i++) {
    const c = await call(employee, `${api}/expense-claims`, { title: `Local cab ${i + 1}`, lines: [{ date: day(20 + i), accountId: acc['6700'], merchant: 'Synthetic Cabs', amount: String(400 + i * 10) }] });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal((await call(employee, `${api}/expense-claims/${c.body.id}/submit`, {})).status, 200);
    assert.equal((await call(owner, `${api}/expense-claims/${c.body.id}/approve`, {})).status, 200);
  }

  await employee.goto(`${WEB}/orgs/${orgId}/expenses/new`);
  await employee.getByLabel('Title').fill('Airport cab');
  await employee.getByLabel('Category for line 1').selectOption({ label: '6700 · Travel' });
  await employee.getByLabel('Merchant for line 1').fill('Synthetic Premium Cabs');
  await employee.getByLabel('Amount for line 1').fill('2700');
  await employee.getByRole('button', { name: 'Save draft' }).click();
  await employee.waitForURL(/\/expenses\/[0-9a-f-]{36}$/);
  const claimUrl = employee.url();
  const region = employee.getByRole('region', { name: 'Worth a second look' });
  await region.getByText('Unusual amount').waitFor();
  await region.getByText(/Line 1: INR 2700\.00 is about 6 times the usual for 6700 · Travel \(median INR 445\.00 across 10 approved lines/).waitFor();
  await employee.getByRole('button', { name: 'Submit for approval' }).click();
  await employee.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await employee.getByRole('dialog').waitFor({ state: 'detached' });
  await employee.getByText('Waiting for approval').first().waitFor();

  await owner.goto(claimUrl);
  await owner.getByRole('region', { name: 'Worth a second look' }).getByText('Unusual amount').waitFor();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await owner.screenshot({ path: `${SHOTS}/expense-anomaly.png` });
  }
  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
