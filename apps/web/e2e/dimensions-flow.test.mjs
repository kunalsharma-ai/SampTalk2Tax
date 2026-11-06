/**
 * Browser end-to-end test for financial dimensions: an owner adds departments and a project, tags
 * journal lines on the journal form, sees a tagged invoice line on the invoice, reads the profit by
 * department and by project, filters the profit and loss by department, and makes a department
 * inactive so new lines can no longer pick it. Real Next.js app → real API → real PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

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
after(async () => {
  await browser?.close();
});

test('an owner tags lines with departments and projects and reads profit for each', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Dimension Owner');
  await page.getByLabel('Email').fill(`e2e-dimensions-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Dimensions Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));

  // Before any are added, the journal form has no department or project fields.
  await page.goto(`${WEB}/orgs/${orgId}/journals/new`);
  await page.getByLabel('Account for line 1').waitFor();
  assert.equal(await page.getByLabel('Department for line 1').count(), 0);

  await page.getByRole('link', { name: 'Departments and projects', exact: true }).click();
  await page.getByRole('heading', { name: 'Departments and projects', exact: true }).waitFor();
  await page.getByText('No departments yet').waitFor();
  const add = page.getByLabel('Add a department');
  for (const [code, name] of [['sales', 'Sales'], ['OPS', 'Operations']]) {
    await add.getByLabel('Code').fill(code);
    await add.getByLabel('Name', { exact: true }).fill(name);
    await add.getByRole('button', { name: 'Add department' }).click();
    await page.getByRole('table', { name: 'Departments' }).getByText(name, { exact: true }).waitFor();
  }
  await page.getByRole('table', { name: 'Departments' }).getByText('SALES', { exact: true }).waitFor();
  await add.getByLabel('Code').fill('OPS');
  await add.getByLabel('Name', { exact: true }).fill('Ops again');
  await add.getByRole('button', { name: 'Add department' }).click();
  await add.getByText(/already/i).waitFor();
  await add.getByLabel('Code').fill('');
  await add.getByLabel('Name', { exact: true }).fill('');

  const customer = (await call(`${base}/contacts`, { name: 'Asha Traders', isCustomer: true })).body.id;
  await page.getByRole('tab', { name: /Projects/ }).click();
  const addP = page.getByLabel('Add a project');
  await addP.getByLabel('Code').fill('PORTAL');
  await addP.getByLabel('Name', { exact: true }).fill('Sales portal build');
  await addP.getByLabel('Customer (optional)').locator('option', { hasText: 'Asha Traders' }).waitFor({ state: 'attached' });
  await addP.getByLabel('Customer (optional)').selectOption({ label: 'Asha Traders' });
  await addP.getByLabel('Starts (optional)').fill(`${T.slice(0, 7)}-01`);
  await addP.getByRole('button', { name: 'Add project' }).click();
  await page.getByRole('table', { name: 'Projects' }).getByText('Sales portal build').waitFor();
  await page.getByRole('table', { name: 'Projects' }).getByText('Asha Traders').waitFor();

  // A journal tagged on the form.
  await page.goto(`${WEB}/orgs/${orgId}/journals/new`);
  await page.getByLabel('Memo').fill('Sales salaries');
  await page.getByLabel('Account for line 1').selectOption(acc['6100']);
  await page.getByLabel('Debit for line 1').fill('40000');
  await page.getByLabel('Department for line 1').selectOption({ label: 'Sales' });
  await page.getByLabel('Project for line 1').selectOption({ label: 'Sales portal build' });
  await page.getByLabel('Account for line 2').selectOption(acc['1120']);
  await page.getByLabel('Credit for line 2').fill('40000');
  await page.getByRole('button', { name: 'Post journal' }).click();
  await page.waitForURL(/\/journals\/[0-9a-f-]{36}$/);
  const lines = page.getByRole('row', { name: /Salaries and Wages/ });
  await lines.getByText('Sales', { exact: true }).waitFor();
  await lines.getByText('Sales portal build').waitFor();
  const je = (await call(`${base}/journals/${page.url().split('/').pop()}`)).body;
  assert.equal(je.lines[0].departmentId !== null && je.lines[0].projectId !== null, true);
  assert.equal(je.lines[1].departmentId, null);

  const deps = Object.fromEntries((await call(`${base}/dimensions?type=DEPARTMENT`)).body.values.map((v) => [v.code, v.id]));
  const proj = (await call(`${base}/dimensions?type=PROJECT`)).body.values[0].id;
  assert.equal((await call(`${base}/journals`, { date: T, memo: 'Rent and wages', post: true, lines: [
    { accountId: acc['6200'], debit: '30000.00', departmentId: deps.OPS },
    { accountId: acc['6100'], debit: '25000.00', departmentId: deps.OPS },
    { accountId: acc['6300'], debit: '5000.00' },
    { accountId: acc['1120'], credit: '60000.00' },
  ] })).status, 201);
  const inv = await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer, issueDate: T, post: true, lines: [
    { accountId: acc['4200'], description: 'Portal build, phase 1', quantity: '1', unitPrice: '150000', departmentId: deps.SALES, projectId: proj },
    { accountId: acc['4100'], description: 'Hardware', quantity: '2', unitPrice: '10000' },
  ] });
  assert.equal(inv.status, 201);
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${inv.body.id}`);
  const invLine = page.getByRole('row', { name: /Portal build, phase 1/ });
  await invLine.getByText('Sales portal build').waitFor();

  await page.getByRole('link', { name: 'Profit by department', exact: true }).click();
  await page.getByRole('heading', { name: 'Profit by department or project' }).waitFor();
  const t = page.getByRole('table', { name: 'Profit by department or project' });
  await t.getByRole('columnheader', { name: 'Not assigned' }).waitFor();
  const net = t.getByRole('row', { name: /Net profit/ });
  await net.getByText('-₹55,000.00').or(net.getByText('−₹55,000.00')).first().waitFor();
  await net.getByText('₹1,10,000.00').first().waitFor();
  await net.getByText('₹70,000.00').waitFor();
  await t.getByRole('row', { name: /Margin/ }).getByText('73.3%').waitFor();
  await page.getByRole('tab', { name: 'By project' }).click();
  await t.getByRole('columnheader', { name: 'Sales portal build' }).waitFor();
  await t.getByRole('row', { name: /Net profit/ }).getByText('₹1,10,000.00').first().waitFor();

  await page.getByRole('link', { name: 'Profit and loss', exact: true }).click();
  await page.getByRole('heading', { name: 'Profit and loss' }).waitFor();
  await page.getByLabel('Department').selectOption({ label: 'OPS · Operations' });
  await page.getByText(/E2E Dimensions Co · INR · Operations/).waitFor();
  await page.getByRole('row', { name: /Total expenses/ }).getByText('₹55,000.00').waitFor();

  // Made inactive: the line pickers stop offering it, its history stays.
  await page.getByRole('link', { name: 'Departments and projects', exact: true }).click();
  await page.getByRole('button', { name: 'Change SALES' }).click();
  const edit = page.getByRole('form', { name: 'Change SALES' });
  await edit.getByLabel('Active (new lines can use it)').uncheck();
  await edit.getByText('Its 2 tagged lines keep the tag').waitFor();
  await edit.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('table', { name: 'Departments' }).getByRole('row', { name: /SALES/ });
  await row.getByText('Inactive').waitFor();
  await page.goto(`${WEB}/orgs/${orgId}/journals/new`);
  await page.getByLabel('Department for line 1').waitFor();
  const opts = await page.getByLabel('Department for line 1').locator('option').allTextContents();
  assert.deepEqual(opts, ['Department', 'Operations']);

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
