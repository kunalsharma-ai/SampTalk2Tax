/**
 * Browser end-to-end test for salary payments by bank transfer (PAY-017): an owner adds an
 * employee's salary account, a wrong IFSC is refused, the pay run lists who can be paid by
 * transfer and who cannot, and after posting the bank's bulk transfer file of net salaries is
 * downloaded and holds only the employee with an account.
 * Real Next.js app → real API → real MongoDB. Same prerequisites as ledger-flow.test.mjs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const PERIOD = today().slice(0, 7);
const FY = Number(PERIOD.slice(5, 7)) >= 4 ? Number(PERIOD.slice(0, 4)) : Number(PERIOD.slice(0, 4)) - 1;
let browser, page, orgId, base;
const consoleErrors = [];
const shot = (name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined);

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
  page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('salaries are paid from the bank file to employees with a salary account', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Salary Owner');
  await page.getByLabel('Email').fill(`e2e-salary-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.getByLabel('Organisation name').fill('E2E Salary Transfers');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `${WEB}/orgs/${orgId}`;
  const api = `/v1/orgs/${orgId}`;
  assert.equal((await call(`${api}/payroll/settings`, {}, 'PUT')).status, 200);
  const structure = { effectiveFrom: `${FY}-04-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '30000' }] };
  assert.equal((await call(`${api}/payroll/employees`, { code: 'E002', name: 'Kiran Rao (synthetic)', dateOfJoining: `${FY}-04-01`, structure })).status, 201);

  // The salary account is checked when saved.
  await page.goto(`${base}/payroll/employees`);
  await page.getByRole('button', { name: 'New employee' }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Employee code').fill('E001');
  await d.getByLabel('Name', { exact: true }).fill('Asha Kulkarni (synthetic)');
  await d.getByLabel('Date of joining').fill(`${FY}-04-01`);
  await d.getByLabel("Account holder's name").fill('Asha Kulkarni');
  await d.getByLabel('Account number').fill('5010 0012 3456 78');
  await d.getByLabel('IFSC').fill('hdfc1234');
  await d.getByLabel('Monthly amount for component 1').fill('40000');
  await d.getByRole('button', { name: 'Add employee' }).click();
  await d.getByText(/Salary account: An IFSC is 11 characters/).waitFor();
  await d.getByLabel('IFSC').fill('hdfc0001234');
  await d.getByRole('button', { name: 'Add employee' }).click();
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/);
  await page.getByText('XXXXXXXX5678').waitFor();
  await page.getByText('HDFC0001234').waitFor();

  // Before posting, the run lists who can be paid by transfer.
  const run = (await call(`${api}/payroll/runs`, { period: PERIOD, payDate: `${PERIOD}-28` })).body;
  await page.goto(`${base}/payroll/runs/${run.id}`);
  await page.getByText('1 of 2 employees by transfer').click();
  const table = page.getByRole('table', { name: 'Salary transfers' });
  await table.getByRole('row', { name: /Asha Kulkarni/ }).getByText('Yes').waitFor();
  await table.getByRole('row', { name: /Kiran Rao/ }).getByText('No salary account').waitFor();
  await page.getByText('1 employee is not in the file').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Download salary bank file' }).count(), 0);

  await page.getByRole('button', { name: 'Post pay run' }).click();
  await page.getByRole('button', { name: 'Void pay run' }).waitFor();
  await page.getByLabel('Salaries paid from').selectOption({ label: '1120 · Operating Bank Account' });
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download salary bank file' }).click()]);
  assert.match(download.suggestedFilename(), new RegExp(`-salaries-${PERIOD}-28\\.csv$`));
  const csv = await readFile(await download.path(), 'utf8');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`^${PERIOD}-28,1120 Operating Bank Account,Asha Kulkarni,50100012345678,HDFC0001234,\\d+\\.\\d{2},INR,`));
  assert.ok(!csv.includes('Kiran'));
  await page.getByText(/1 transfer totalling/).waitFor();
  await shot('01-salary-transfers');
  // The refused IFSC above is the one expected failed request.
  assert.deepEqual(consoleErrors.filter((m) => !m.includes('status of 422')), []);
  assert.equal(consoleErrors.length, 1);
});
