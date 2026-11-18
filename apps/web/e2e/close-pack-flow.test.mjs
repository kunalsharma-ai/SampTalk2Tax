/**
 * Browser end-to-end test for the month-end report pack (WFLOW-021): an owner closes last month,
 * finds the Report pack card on the close page and downloads the ZIP; its README lists the
 * certification and the month's reports with checksums that match the files.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
let browser, page;
const consoleErrors = [];
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month, by) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (month) => (+month.slice(5, 7) >= 4 ? +month.slice(0, 4) + 1 : +month.slice(0, 4));

async function call(path, body, method = body ? 'POST' : 'GET') {
  return page.evaluate(
    async ([u, b, m]) => {
      const r = await fetch(`/api/t2t${u}`, { method: m, headers: { 'content-type': 'application/json', 'x-t2t-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [path, body, method],
  );
}

/** Entries of a stored ZIP. */
function unzip(buf) {
  const out = new Map();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const n = buf.readUInt16LE(p + 26);
    out.set(buf.subarray(p + 30, p + 30 + n).toString('utf8'), buf.subarray(p + 30 + n, p + 30 + n + size));
    p += 30 + n + size;
  }
  return out;
}

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner downloads the report pack of a closed month', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Pack Owner');
  await page.getByLabel('Email').fill(`e2e-pack-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Report Pack Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const M = shift(T.slice(0, 7), -1);
  const years = new Set((await call(`${base}/periods`)).body.map((p) => p.fiscalYear));
  if (!years.has(fyOf(M))) assert.equal((await call(`${base}/periods/fiscal-years`, { fiscalYear: fyOf(M) })).status, 201);
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const journal = (date, dr, cr, amount, memo) => call(`${base}/journals`, { date, memo, post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }] });
  assert.equal((await journal(`${M}-02`, '1120', '3100', '300000.00', 'Capital')).status, 201);
  assert.equal((await journal(`${M}-12`, '1120', '4100', '90000.00', 'Sales')).status, 201);
  assert.equal((await journal(`${M}-20`, '6200', '1120', '30000.00', 'Office rent')).status, 201);
  const period = (await call(`${base}/close`)).body.periods.find((p) => p.startDate === `${M}-01`);

  await page.goto(`${WEB}/orgs/${orgId}/close/${period.id}`);
  await page.getByRole('heading', { name: `${period.name} close` }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Report pack' }).count(), 0, 'no pack before the month is closed');
  await page.getByRole('button', { name: 'Start close' }).click();
  await page.getByRole('button', { name: `Close and lock ${period.name}` }).waitFor();
  const note = page.getByLabel(/Why closing with \d+ warnings? open is acceptable/);
  if (await note.count()) await note.fill('Earlier months were before we started using the system.');
  await page.getByRole('button', { name: `Close and lock ${period.name}` }).click();
  await page.getByLabel('Closed by Pack Owner').waitFor();

  const card = page.getByRole('region', { name: 'Report pack' });
  await card.waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), card.getByRole('button', { name: 'Download report pack' }).click()]);
  await card.getByText(/Downloaded close-pack-.*\.zip/).waitFor();
  assert.match(download.suggestedFilename(), /^close-pack-.*\.zip$/);
  const files = unzip(await readFile(await download.path()));
  const names = [...files.keys()];
  assert.ok(names[0].startsWith('01-close-certification-'), names.join(', '));
  assert.ok(names.some((n) => n.includes('income-statement')));
  assert.ok(names.some((n) => n.includes('balance-sheet')));
  const readme = files.get('README.txt').toString('utf8');
  for (const [n, b] of files) if (n !== 'README.txt') assert.ok(readme.includes(`${createHash('sha256').update(b).digest('hex')}  ${n}`), n);

  if (SHOTS) {
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/close-report-pack.png` });
  }
  const audit = (await call(`${base}/audit-events?limit=50`)).body;
  assert.ok((audit.items ?? audit).some((e) => e.action === 'close.report_pack_exported'));
  assert.deepEqual(consoleErrors, []);
});
