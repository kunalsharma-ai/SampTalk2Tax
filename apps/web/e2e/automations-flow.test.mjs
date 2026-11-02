/**
 * Browser end-to-end test for workflow automations and tasks: an owner builds a workflow,
 * tests it on a real invoice, turns it on, and the running API acts on the next invoice by
 * giving a task and sending a signed webhook to a receiver run here. The owner then works
 * the task and changes the workflow. Real Next.js app → real API → real PostgreSQL → the
 * API's own runner. The API must run with WORKFLOW_RUNNER_INTERVAL_SECONDS small (1 in CI)
 * and WEBHOOK_ALLOW_PRIVATE_NETWORKS=true, because the receiver is on localhost.
 */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page, orgId, base, accounts, receiver, hookUrl;
const received = [];
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
  receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${receiver.address().port}/talk2tax`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await new Promise((r) => receiver?.close(r));
});

test('an owner builds, tests and turns on a workflow; the next large invoice gives a task and a signed webhook', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Flow Owner');
  await page.getByLabel('Email').fill(`e2e-flows-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Flows Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Peacock Traders', isCustomer: true })).body;
  const invoice = async (amount, reference) => (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: T, reference, post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: amount }] })).body;
  const first = await invoice('250000.00', 'PO-1');

  // Build the workflow.
  await page.getByRole('link', { name: 'Automations', exact: true }).click();
  await page.getByText('No workflows yet').waitFor();
  await page.getByRole('button', { name: 'New workflow' }).first().click();
  await page.getByRole('heading', { name: 'New workflow' }).waitFor();
  await page.getByLabel('Workflow name').fill('Large invoices');
  await page.getByLabel('Trigger').selectOption({ label: 'An invoice is posted' });
  await page.getByRole('button', { name: 'Add a condition' }).click();
  const cond = page.getByRole('group', { name: 'Condition 1' });
  await cond.getByLabel('Condition 1 fact').selectOption({ label: 'Total' });
  await cond.getByLabel('Condition 1 test').selectOption({ label: 'is at least' });
  await cond.getByLabel('Condition 1 value').fill('100000');
  const task = page.getByRole('group', { name: 'Action 1' });
  await task.getByLabel('Task title').fill('Check {{number}} for {{contactName}}');
  await task.getByLabel('Details (optional)').fill('Reference {{reference}}, total {{total}}');
  await task.getByLabel('For').selectOption({ label: 'Flow Owner' });
  await task.getByLabel('Due').fill('2');
  await page.getByRole('button', { name: 'Add a webhook' }).click();
  // A mistake is explained, and nothing is saved.
  await page.getByRole('group', { name: 'Action 2' }).getByLabel('Address').fill('ftp://nowhere');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.getByText('Action 2: the address must start with https://').waitFor();
  await page.getByRole('group', { name: 'Action 2' }).getByLabel('Address').fill(hookUrl);
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByText('This workflow is off').waitFor();
  await page.getByText('Total is at least 100000').waitFor();

  // Test on the invoice already posted: nothing is created.
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  const result = page.getByLabel('Test result');
  await result.getByText('Test: the conditions hold, so it would act').waitFor();
  await result.getByText(`“Check ${first.number} for Peacock Traders” for Flow Owner, due`).waitFor();
  await result.getByRole('link', { name: `Invoice ${first.number}` }).waitFor();
  assert.equal(received.length, 0);
  assert.equal((await call(`${base}/tasks?scope=all&status=ALL`)).body.tasks.length, 0);

  // Turn it on; the next large invoice gives a task and a webhook; a small one does not.
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'Turn off' }).waitFor();
  const big = await invoice('180000.00', 'PO-2');
  await invoice('900.00', 'PO-3');
  const runs = page.getByRole('table', { name: 'Runs' });
  for (let i = 0; i < 30; i++) {
    await page.reload();
    await page.getByRole('heading', { name: 'Large invoices' }).waitFor();
    if ((await runs.getByRole('row').count()) >= 4) break; // header + two runs + the test
    await page.waitForTimeout(1000);
  }
  const bigRow = runs.getByRole('row').filter({ has: page.getByRole('link', { name: `Invoice ${big.number}` }) });
  await bigRow.getByText('Done', { exact: true }).waitFor();
  await runs.getByRole('row').filter({ hasText: 'Conditions not met' }).waitFor();
  await bigRow.getByRole('button', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Total is at least 100000').waitFor();
  await dialog.getByText('(was 180000.00)').waitFor();
  await dialog.getByRole('list', { name: 'Attempts' }).getByText(/answered 200/).waitFor();
  await page.keyboard.press('Escape');

  // The receiver got one signed delivery, which checks out with the secret shown on the page.
  assert.equal(received.length, 1);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  const secret = await page.getByLabel('Signing secret').innerText();
  const { t, v1 } = Object.fromEntries(received[0].headers['t2t-signature'].split(',').map((p) => p.split('=')));
  assert.equal(createHmac('sha256', secret).update(`${t}.${received[0].body}`).digest('hex'), v1);
  const payload = JSON.parse(received[0].body);
  assert.deepEqual([payload.event, payload.test, payload.data.number, payload.data.total, payload.data.reference], ['INVOICE_POSTED', false, big.number, '180000.00', 'PO-2']);

  // Work the task.
  await page.getByRole('link', { name: 'My tasks' }).click();
  await page.getByRole('heading', { name: 'My tasks' }).waitFor();
  const card = page.getByLabel(`Check ${big.number} for Peacock Traders`);
  await card.getByText('Reference PO-2, total 180000.00').waitFor();
  await card.getByText('From the automation').waitFor();
  await card.getByRole('link', { name: `Invoice ${big.number}` }).waitFor();
  await card.getByRole('button', { name: 'Mark done' }).click();
  await page.getByRole('dialog').getByLabel('Note (optional)').fill('Checked against the PO');
  await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
  await page.getByText('Nothing to do').waitFor();
  await page.getByRole('tab', { name: 'Done' }).click();
  await page.getByText('Done by Flow Owner: Checked against the PO').waitFor();

  // Change the threshold: a new version.
  await page.getByRole('link', { name: 'Automations', exact: true }).click();
  await page.getByRole('table', { name: 'Workflows' }).getByRole('link', { name: 'Large invoices' }).click();
  await page.getByRole('heading', { name: 'Large invoices' }).waitFor();
  await page.getByText('Version 1 · created by Flow Owner').waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('heading', { name: 'Edit Large invoices' }).waitFor();
  await page.getByLabel('Condition 1 value').fill('500000');
  await page.getByLabel('What changed (optional)').fill('Only very large invoices');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByText('Total is at least 500000').waitFor();
  await page.getByRole('table', { name: 'Versions' }).getByText('Only very large invoices').waitFor();
  // The one refused save (the ftp:// address) is the only failed request.
  assert.deepEqual(consoleErrors, ['Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)']);
});
