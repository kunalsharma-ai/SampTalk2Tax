/**
 * Visual regression tests (QA-019): screens that do not depend on today's date are captured and
 * compared pixel by pixel with the reference images in e2e/visual/. A screen that changes by more
 * than 0.5% of its pixels fails, with the new image and a diff (changed pixels in red) written
 * next to the reference so the change can be looked at. To accept a change on purpose, run with
 * UPDATE_VISUAL=1 and commit the new references.
 *
 * Text is drawn in DejaVu Sans, loaded from the machine as a web font, so the system fonts of
 * the machine running the test do not change the picture. Animations are stopped, the caret is
 * hidden, and anything that differs per run (email addresses, dates, ids) is masked.
 * Real Next.js app → real API → real MongoDB.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const DIR = join(dirname(fileURLToPath(import.meta.url)), 'visual');
const UPDATE = process.env.UPDATE_VISUAL === '1';
/** Share of pixels that may differ (anti-aliasing at edges). */
const TOLERANCE = 0.005;
/** How far apart two colours may be (0–255 per channel, summed) and still count as the same pixel. */
const COLOUR_DISTANCE = 48;
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'];
let browser;

before(async () => {
  for (const f of FONTS) assert.ok(existsSync(f), `${f} is needed for visual tests (apt-get install fonts-dejavu-core)`);
  // Text and colour drawn the same way on any Linux machine: no hinting or sub-pixel tricks that
  // follow the machine's font settings, one colour profile, software raster.
  browser = await chromium.launch({ args: ['--font-render-hinting=none', '--disable-lcd-text', '--disable-font-subpixel-positioning', '--force-color-profile=srgb', '--disable-gpu'] });
  mkdirSync(DIR, { recursive: true });
});
after(async () => {
  await browser?.close();
});

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'dark', locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
  // The fonts, served from the machine under a fixed address.
  await ctx.route('https://visual.talk2tax.test/fonts/*', (route) => {
    const name = route.request().url().split('/').pop();
    route.fulfill({ status: 200, contentType: 'font/ttf', body: readFileSync(FONTS.find((f) => f.endsWith(name))) });
  });
  return ctx.newPage();
}

const STYLE = `
@font-face { font-family: 'T2T Visual'; src: url(https://visual.talk2tax.test/fonts/DejaVuSans.ttf); font-weight: 100 500; }
@font-face { font-family: 'T2T Visual'; src: url(https://visual.talk2tax.test/fonts/DejaVuSans-Bold.ttf); font-weight: 600 900; }
@font-face { font-family: 'T2T Visual Mono'; src: url(https://visual.talk2tax.test/fonts/DejaVuSansMono.ttf); }
*, *::before, *::after { font-family: 'T2T Visual', sans-serif !important; animation: none !important; transition: none !important; caret-color: transparent !important; }
code, pre, kbd, .font-mono, .font-mono * { font-family: 'T2T Visual Mono', monospace !important; }
body { background-attachment: scroll !important; }
`;

function close(a, b, i, j) {
  return Math.abs(a.data[i] - b.data[j]) + Math.abs(a.data[i + 1] - b.data[j + 1]) + Math.abs(a.data[i + 2] - b.data[j + 2]) <= COLOUR_DISTANCE;
}

/** Whether the pixel at (x, y) of `img` has a match within one pixel in `other`. */
function near(img, other, x, y) {
  const i = (y * img.width + x) * 4;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
      if (close(img, { data: other }, i, (ny * img.width + nx) * 4)) return true;
    }
  }
  return false;
}

/** Compares the page with its reference image; returns a problem, or null. */
async function compare(page, name, mask = []) {
  await page.addStyleTag({ content: STYLE });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  const shot = await page.screenshot({ fullPage: false, animations: 'disabled', mask, maskColor: '#ff00ff' });
  const ref = join(DIR, `${name}.png`);
  if (UPDATE || !existsSync(ref)) {
    writeFileSync(ref, shot);
    return UPDATE ? null : `${name}: no reference image yet, so one was written (${ref}); commit it`;
  }
  const a = PNG.sync.read(readFileSync(ref));
  const b = PNG.sync.read(shot);
  if (a.width !== b.width || a.height !== b.height) return `${name}: size ${b.width}×${b.height}, reference ${a.width}×${a.height}`;
  const diff = new PNG({ width: a.width, height: a.height });
  const { width, height } = a;
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // A pixel counts as changed when its colour has no match within one pixel in the other
      // picture (checked both ways), so a glyph edge drawn a fraction of a pixel aside is not.
      const same = close(a, b, i, i) || (near(a, b.data, x, y) && near(b, a.data, x, y));
      if (!same) changed++;
      diff.data[i] = same ? b.data[i] * 0.3 : 255;
      diff.data[i + 1] = same ? b.data[i + 1] * 0.3 : 0;
      diff.data[i + 2] = same ? b.data[i + 2] * 0.3 : 0;
      diff.data[i + 3] = 255;
    }
  }
  const share = changed / (a.width * a.height);
  if (share <= TOLERANCE) return null;
  writeFileSync(join(DIR, `${name}.actual.png`), shot);
  writeFileSync(join(DIR, `${name}.diff.png`), PNG.sync.write(diff));
  return `${name}: ${(share * 100).toFixed(2)}% of pixels changed (allowed ${(TOLERANCE * 100).toFixed(1)}%); see ${name}.actual.png and ${name}.diff.png`;
}

test('screens look as they did', async () => {
  const problems = [];
  const page = await newPage();
  for (const [name, path] of [['sign-in', '/login'], ['register', '/register']]) {
    await page.goto(`${WEB}${path}`);
    await page.waitForLoadState('networkidle');
    const p = await compare(page, name);
    if (p) problems.push(p);
  }

  const email = `e2e-visual-${randomUUID().slice(0, 8)}@example.test`;
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Visual Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.waitForLoadState('networkidle');
  {
    const p = await compare(page, 'onboarding', [page.getByText(email)]);
    if (p) problems.push(p);
  }
  await page.getByLabel('Organisation name').fill('Visual Test Pvt Ltd');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgUrl = page.url();

  // Screens whose content is the same on any day: the chart of accounts, empty lists and settings.
  for (const [name, path, mask] of [
    ['chart-of-accounts', '/accounts', []],
    ['tasks-empty', '/tasks', []],
    ['new-invoice', '/sales/invoices/new', ['input[type="date"]']],
    ['access-rules-empty', '/settings/access-rules', ['[aria-label="Your access now"]']],
  ]) {
    await page.goto(`${orgUrl}${path}`);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 15_000 }).catch(() => undefined);
    const p = await compare(page, name, [page.getByText(email), page.getByText('Visual Owner', { exact: false }).filter({ hasText: '@' }), ...mask.map((m) => page.locator(m))]);
    if (p) problems.push(p);
  }
  await page.context().close();
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});
