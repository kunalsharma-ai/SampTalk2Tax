/**
 * Browser end-to-end test for the same receipt file claimed twice (EXP-018): an employee attaches
 * one taxi receipt file to two claims. The owner opening the second claim sees the file is also on
 * the first, with a link to it; approving needs a reason, which is kept; and the expense risk view
 * lists it as serious. Real Next.js app, API and MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.E2E_SCREENSHOTS;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const d = (n) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
let browser, owner, employee;
const consoleErrors = [];

async function call(page, path, body) {
  return page.evaluate(
    async ([p, b]) => {
      const r = await fetch(`/api/t2t${p}`, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body],
  );
}
const must = async (p) => { const r = await p; assert.ok(r.status < 300, JSON.stringify(r)); return r.body; };
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
  employee = await (await browser.newContext()).newPage();
  for (const p of [owner, employee]) p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('one receipt file on two claims is caught before it is paid twice', async () => {
  await register(owner, 'Meera Approver', `e2e-samefile-owner-${randomUUID()}@example.test`);
  await owner.getByLabel('Organisation name').fill('E2E Same File Co');
  await owner.getByRole('button', { name: 'Create organisation' }).click();
  await owner.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = owner.url();
  const B = `/v1/orgs/${base.split('/orgs/')[1]}`;
  const acc = Object.fromEntries((await call(owner, `${B}/accounts`)).body.map((a) => [a.code, a.id]));
  const email = `e2e-samefile-emp-${randomUUID()}@example.test`;
  await register(employee, 'Kabir Twice', email);
  await must(call(owner, `${B}/members`, { email, role: 'EMPLOYEE' }));
  const claim = async (title, days, fileName) => {
    const c = await must(call(employee, `${B}/expense-claims`, { title, lines: [{ date: d(days), accountId: acc['6700'], merchant: 'Synthetic Cabs', amount: '1450.00' }] }));
    const r = await employee.evaluate(
      async (u) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-t2t-csrf': '1' }, body: new TextEncoder().encode('%PDF-1.4\n% synthetic airport taxi 7781\n%%EOF\n') })).status,
      `/api/t2t${B}/attachments?entityType=EXPENSE_CLAIM&entityId=${c.id}&fileName=${fileName}`,
    );
    assert.equal(r, 201);
    await must(call(employee, `${B}/expense-claims/${c.id}/submit`, {}));
    return c;
  };
  const first = await claim('Airport taxi', 9, 'taxi.pdf');
  const second = await claim('Client visit cab', 2, 'cab-receipt.pdf');
  consoleErrors.length = 0;

  await owner.goto(`${base}/expenses/${second.id}`);
  const same = owner.getByRole('region', { name: 'Same receipt file elsewhere' });
  await same.getByText('The exact file is also on another claim or a supplier bill: the same receipt may be paid twice.', { exact: false }).waitFor();
  await same.getByRole('link', { name: `${first.number}, Kabir Twice` }).waitFor();
  await owner.evaluate(() => window.scrollTo(0, 0));
  if (SHOTS) await owner.screenshot({ path: `${SHOTS}/same-receipt-file.png`, fullPage: true });

  await owner.getByRole('button', { name: 'Approve…' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByText(`cab-receipt.pdf is also on ${first.number}, Kabir Twice`, { exact: false }).waitFor();
  const why = dialog.getByLabel('Why approve it anyway');
  assert.ok(await why.evaluate((el) => el.required));
  await why.fill('Return leg of the same booking; one receipt covers both');
  await dialog.getByRole('button', { name: 'Approve and post' }).click();
  await dialog.waitFor({ state: 'detached' });
  await owner.getByText('“Return leg of the same booking; one receipt covers both”').waitFor();

  await same.getByRole('link', { name: `${first.number}, Kabir Twice` }).click();
  await owner.waitForURL(new RegExp(`/expenses/${first.id}$`));
  await owner.getByRole('region', { name: 'Same receipt file elsewhere' }).getByRole('link', { name: `${second.number}, Kabir Twice` }).waitFor();

  await owner.goto(`${base}/expenses/risk`);
  await owner.getByText('Same receipt file elsewhere').first().waitFor();
  await owner.getByText(`taxi.pdf is also on ${second.number}, Kabir Twice`).first().waitFor();
  assert.deepEqual(consoleErrors, []);
});
