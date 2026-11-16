/**
 * Browser end-to-end test for schedule triggers and email: an owner builds a reminder that
 * emails the customer when an invoice is a day overdue, tests it (the test email comes to
 * the owner only), turns it on, and the running API's own runner sends the real reminder
 * over SMTP. Then the owner builds a weekly digest and sees when it next comes round.
 * Real Next.js app → real API → real PostgreSQL → nodemailer → a local SMTP server run here
 * (test-support/smtp-stand-in.mjs). The API must run with SMTP_URL=smtp://127.0.0.1:4556,
 * EMAIL_FROM set, and WORKFLOW_RUNNER_INTERVAL_SECONDS small (1 in CI).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { startSmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SMTP_PORT = Number(process.env.SMTP_STAND_IN_PORT ?? 4556);
let browser, page, smtp, orgId, base;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
  smtp = await startSmtpStandIn(SMTP_PORT);
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
  await smtp?.close();
});

test('an owner sets up an overdue reminder by email; the runner emails the customer once the invoice is a day overdue', async () => {
  const ownerEmail = `e2e-sched-${randomUUID()}@example.test`;
  const customerEmail = `lotus-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Sched Owner');
  await page.getByLabel('Email').fill(ownerEmail);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Reminders Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  orgId = page.url().split('/').pop();
  base = `/v1/orgs/${orgId}`;
  const accounts = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Lotus Stores', isCustomer: true, email: customerEmail })).body;
  const inv = (await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: addDays(T, -8), dueDate: addDays(T, -1), reference: 'PO-77', post: true, lines: [{ accountId: accounts['4100'], quantity: '1', unitPrice: '64000.00' }] })).body;

  // Build: an invoice is 1 day overdue → email the customer.
  await page.getByRole('link', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New workflow' }).first().click();
  await page.getByRole('heading', { name: 'New workflow' }).waitFor();
  await page.getByLabel('Workflow name').fill('Overdue reminders');
  await page.getByLabel('Trigger').selectOption({ label: 'An invoice is overdue' });
  await page.getByLabel('Days after the due date').fill('1');
  await page.getByRole('group', { name: 'Action 1' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Add an email' }).click();
  const email = page.getByRole('group', { name: 'Action 1' });
  assert.equal(await email.getByLabel('To').inputValue(), 'contact');
  await email.getByLabel('Subject').fill('Invoice {{number}} is overdue');
  await email.getByLabel('Message').fill('Dear {{contactName}},\n\n{{balance}} on invoice {{number}}, due {{dueDate}}, is still to pay.');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByText('An invoice is 1 day overdue').first().waitFor();
  await page.getByText('Email “Invoice {{number}} is overdue” to the customer').waitFor();
  await page.getByText('acts only on times and dates from then on').waitFor();

  // Test: the email is shown, and sent to the owner only.
  await page.getByRole('button', { name: 'Test and email me' }).click();
  const result = page.getByLabel('Test result');
  await result.getByText('the most recently overdue invoice still to be paid').waitFor();
  await result.getByRole('link', { name: `Invoice ${inv.number}` }).waitFor();
  await result.getByText(`Test sent to ${ownerEmail} only`).waitFor();
  await result.getByText(`To Lotus Stores (${customerEmail})`).waitFor();
  assert.equal(smtp.messages.filter((m) => m.to.includes(customerEmail)).length, 0);
  const testMail = smtp.messages.find((m) => m.to.includes(ownerEmail.toLowerCase()));
  assert.equal(testMail.subject, `[Test] Invoice ${inv.number} is overdue`);

  // Turn on: the runner sends the real reminder to the customer.
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'Turn off' }).waitFor();
  const runs = page.getByRole('table', { name: 'Runs' });
  const row = runs.getByRole('row').filter({ has: page.getByRole('link', { name: `Invoice ${inv.number}` }) }).filter({ has: page.getByText('Done', { exact: true }) });
  for (let i = 0; i < 30 && !(await row.count()); i++) {
    await page.waitForTimeout(1000);
    await page.reload();
    await page.getByRole('heading', { name: 'Overdue reminders' }).waitFor();
  }
  await row.getByRole('button', { name: 'Details' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(`To Lotus Stores (${customerEmail})`).waitFor();
  await dialog.getByRole('list', { name: 'Attempts' }).getByText(/answered 250/).waitFor();
  await page.keyboard.press('Escape');
  const sent = smtp.messages.filter((m) => m.to.includes(customerEmail));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, `Invoice ${inv.number} is overdue`);
  const due = new Date(`${addDays(T, -1)}T00:00:00Z`);
  const dueText = `${due.getUTCDate()} ${due.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${due.getUTCFullYear()}`;
  assert.equal(sent[0].text, `Dear Lotus Stores,\n\n₹64,000.00 on invoice ${inv.number}, due ${dueText}, is still to pay.\n\n--\nSent by E2E Reminders Co.`);
  assert.equal(sent[0].headers['auto-submitted'], 'auto-generated');

  // A weekly digest to the owners: the page says when it comes round next.
  await page.getByRole('link', { name: 'All automations' }).click();
  await page.getByRole('button', { name: 'New workflow' }).first().click();
  await page.getByLabel('Workflow name').fill('Monday digest');
  await page.getByLabel('Trigger').selectOption({ label: 'On a schedule' });
  await page.getByLabel('Repeats').selectOption({ label: 'Every week' });
  await page.getByLabel('On', { exact: true }).selectOption({ label: 'Monday' });
  await page.getByLabel('At (India time)').fill('09:00');
  await page.getByRole('button', { name: 'Add a condition' }).click();
  await page.getByLabel('Condition 1 fact').selectOption({ label: 'Overdue receivables' });
  await page.getByLabel('Condition 1 test').selectOption({ label: 'is more than' });
  await page.getByLabel('Condition 1 value').fill('0');
  await page.getByRole('group', { name: 'Action 1' }).getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Add an email' }).click();
  const digest = page.getByRole('group', { name: 'Action 1' });
  await digest.getByLabel('To').selectOption({ label: 'Owners' });
  await digest.getByLabel('Subject').fill('Receivables for {{date}}');
  await digest.getByLabel('Message').fill('Overdue: {{overdueReceivables}} of {{receivablesOutstanding}}');
  await page.getByRole('button', { name: 'Create workflow' }).click();
  await page.waitForURL(/\/automations\/[0-9a-f-]{36}$/);
  await page.getByText('Every Monday at 09:00 India time').first().waitFor();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.getByLabel('Test result').getByText('Test: the conditions hold, so it would act').waitFor();
  await page.getByLabel('Test result').getByText('Overdue: ₹64,000.00 of ₹64,000.00').waitFor();
  await page.getByRole('button', { name: 'Turn on' }).click();
  await page.getByText(/^Next: /).waitFor();
  assert.match(await page.getByText(/^Next: /).innerText(), /^Next: \d{1,2} [A-Z][a-z]{2}, 0?9:00 am$/i);
  assert.deepEqual(consoleErrors, []);
});
