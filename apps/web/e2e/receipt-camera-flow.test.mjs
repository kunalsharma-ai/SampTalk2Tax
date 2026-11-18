/**
 * Browser end-to-end test for EXP-003 (receipt capture on a phone): on a touch screen the
 * attachments card offers *Take a photo*, which opens the camera; a full-size phone photo over
 * the 5 MB limit is redrawn smaller before upload and attached as a legible JPEG. On a desktop the
 * camera button is hidden. Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const SHOTS = process.env.SHOTS_DIR;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
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

before(async () => {
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => browser?.close());

test('a phone photo of a receipt is taken, shrunk under the limit and attached', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Receipt Camera Owner');
  await page.getByLabel('Email').fill(`e2e-receipt-camera-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Receipt Camera Co');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const base = page.url();
  const orgId = base.split('/orgs/')[1];
  const api = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${api}/accounts`)).body.map((a) => [a.code, a.id]));
  const vendor = (await call(`${api}/contacts`, { name: 'Highway Fuels', isVendor: true })).body;
  const bill = await call(`${api}/purchases/documents`, { kind: 'BILL', contactId: vendor.id, issueDate: T, dueDate: T, lines: [{ accountId: acc['6400'], quantity: '1', unitPrice: '2400.00' }] });
  assert.equal(bill.status, 201, JSON.stringify(bill.body));

  // A 4032 × 3024 photo, as a phone camera takes it: well over the 5 MB limit as a PNG.
  const photo = Buffer.from(
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 4032;
      c.height = 3024;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, c.width, c.height);
      g.addColorStop(0, '#f3efe6');
      g.addColorStop(1, '#d9d2c3');
      x.fillStyle = g;
      x.fillRect(0, 0, c.width, c.height);
      const img = x.getImageData(0, 0, c.width, c.height);
      let seed = 7;
      for (let i = 0; i < img.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const n = (seed % 25) - 12;
        img.data[i] += n;
        img.data[i + 1] += n;
        img.data[i + 2] += n;
      }
      x.putImageData(img, 0, 0);
      x.fillStyle = '#111';
      x.font = 'bold 160px sans-serif';
      x.fillText('HIGHWAY FUELS', 400, 600);
      x.fillText('Diesel 24.5 L  Rs 2,400.00', 400, 900);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      return await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1]);
        r.readAsDataURL(blob);
      });
    }),
    'base64',
  );
  assert.ok(photo.length > 5 * 1024 * 1024, `the test photo is ${photo.length} bytes`);

  await page.goto(`${base}/purchases/bills/${bill.body.id}`);
  const camera = page.getByRole('button', { name: 'Take a photo' });
  await camera.waitFor();
  assert.equal(await page.getByLabel('Photo from camera').getAttribute('capture'), 'environment');
  await page.getByLabel('Photo from camera').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: photo });
  const files = page.getByRole('list', { name: 'Attached files' });
  await files.getByText(/^receipt-\d{8}-\d{6}\.jpg$/).waitFor();
  await files.getByText(/^JPEG · /).waitFor();
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await camera.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/receipt-camera-phone.png`, fullPage: false });
  }

  const list = (await call(`${api}/attachments?entityType=DOCUMENT&entityId=${bill.body.id}`)).body;
  assert.equal(list.length, 1);
  assert.equal(list[0].contentType, 'image/jpeg');
  assert.ok(list[0].sizeBytes < 5 * 1024 * 1024, `shrunk to ${list[0].sizeBytes} bytes`);

  // On a desktop (mouse, no touch) the camera button is hidden; Attach files stays.
  const desk = await browser.newPage({ storageState: await context.storageState(), viewport: { width: 1440, height: 900 } });
  await desk.goto(`${base}/purchases/bills/${bill.body.id}`);
  await desk.getByText('Attach files', { exact: true }).waitFor();
  assert.equal(await desk.getByRole('button', { name: 'Take a photo' }).isVisible(), false);
  await desk.close();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
