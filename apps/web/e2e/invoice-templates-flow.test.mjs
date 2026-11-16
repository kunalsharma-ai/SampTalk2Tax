/**
 * Browser end-to-end test for invoice templates and e-signatures: an owner creates a template
 * from a country preset with a theme and palette, changes colours, section text, a column label
 * and the section order in the designer and saves; writes an HTML template and sees unsafe code
 * refused; draws and saves a signature; then prints a posted invoice with each template, sets
 * one on the invoice, signs it and withdraws the signature. Real Next.js app → real API → real
 * PostgreSQL. The rendered invoice is read inside its sandboxed frame.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
let browser, page;
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
const invoiceFrame = () => page.frameLocator('iframe[title^="Invoice"]');

before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
});
after(async () => {
  await browser?.close();
});

test('an owner designs invoice templates, signs an invoice and prints it with each design', async () => {
  await page.goto(`${WEB}/register`);
  await page.getByLabel('Full name').fill('Template Owner');
  await page.getByLabel('Email').fill(`e2e-templates-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill('e2e-very-long-password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/onboarding|\/orgs/);
  await page.getByLabel('Organisation name').fill('E2E Print House');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/orgs\/[0-9a-f-]{36}$/);
  const orgId = page.url().split('/').pop();
  const base = `/v1/orgs/${orgId}`;
  const acc = Object.fromEntries((await call(`${base}/accounts`)).body.map((a) => [a.code, a.id]));
  const customer = (await call(`${base}/contacts`, { name: 'Lotus <Retail>', isCustomer: true, address: '4 Park Street', city: 'Kolkata', pincode: '700016' })).body;
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const inv = await call(`${base}/sales/documents`, { kind: 'INVOICE', contactId: customer.id, issueDate: today, post: true, reference: 'PO-9', lines: [{ accountId: acc['4100'], description: 'Brass fittings', quantity: '4', unitPrice: '1250.50' }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));

  // A template from the India preset, Modern theme, Emerald palette.
  await page.getByRole('link', { name: 'Invoice templates', exact: true }).click();
  await page.getByText('No templates yet').waitFor();
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Name').fill('Our tax invoice');
  assert.match(await page.getByLabel('Country preset').inputValue(), /IN_GST/);
  await page.getByRole('radio', { name: /Modern/ }).click();
  await page.getByRole('radio', { name: /Emerald/ }).click();
  await page.frameLocator('iframe[title="Template preview"]').getByText('Tax Invoice', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create and open the designer' }).click();
  await page.waitForURL(/invoice-templates\/[0-9a-f-]{36}$/);
  const templateId = page.url().split('/').pop();

  // Designer: colours, section text, a column label, order, save.
  await page.getByLabel('Primary hex').fill('#0b3d2e');
  await page.getByRole('tab', { name: 'Sections' }).click();
  await page.getByLabel('Text').fill('12 Lake Road, Kolkata\nGST helpdesk +91 33 0000 0000');
  await page.getByRole('button', { name: /^Terms and conditions/ }).click();
  await page.getByLabel('Text').fill('Pay {{buyer.name}} by {{doc.dueDate}}.');
  await page.getByRole('button', { name: 'Move Terms and conditions up' }).click();
  await page.getByRole('button', { name: /^Line items/ }).click();
  await page.getByLabel('Label for column UNIT_PRICE').fill('Price each');
  await page.getByLabel('Show column HSN').uncheck();
  await page.getByText(/HSN or SAC code on each line/).waitFor();
  await page.getByLabel('Show column HSN').check();
  await invoiceFrame().getByText('Price each').waitFor();
  await page.getByRole('button', { name: 'Save template' }).click();
  await page.getByText(/Saved at/).waitFor();
  const saved = (await call(`${base}/invoice-templates/${templateId}`)).body;
  assert.equal(saved.isDefault, true);
  assert.equal(saved.layout.theme, 'MODERN');
  assert.equal(saved.layout.palette.primary, '#0b3d2e');
  assert.equal(saved.layout.sections.find((s) => s.key === 'LINES').columns.find((c) => c.key === 'UNIT_PRICE').label, 'Price each');
  const order = saved.layout.sections.map((s) => s.key);
  assert.ok(order.indexOf('TERMS') < order.indexOf('NOTES'));

  // An HTML template: unsafe code is refused before saving, safe code saves.
  const htmlTpl = (await call(`${base}/invoice-templates`, { name: 'Plain HTML', presetId: 'GENERIC', engine: 'HTML' })).body;
  await page.goto(`${WEB}/orgs/${orgId}/settings/invoice-templates/${htmlTpl.id}`);
  const area = page.getByLabel('HTML template');
  await area.fill('<h1 class="t">{{title}} {{doc.number}}</h1><p>For {{buyer.name}}</p><img src="x" onerror="alert(1)">');
  await page.getByText('Fix these before saving').waitFor();
  await page.getByRole('listitem').filter({ hasText: /onerror attribute/ }).waitFor();
  await area.fill('<style>.t{color:#123}</style><h1 class="t">{{title}} {{doc.number}}</h1><p>For {{buyer.name}}</p>{{#lines}}<div>{{description}} {{amount}}</div>{{/lines}}');
  await page.getByText('The template passes the safety checks.').waitFor();
  await page.getByRole('button', { name: 'Save template' }).click();
  await page.getByText(/Saved at/).waitFor();

  // My signature: draw it.
  await page.getByRole('link', { name: 'My signature', exact: true }).click();
  const pad = page.getByRole('img', { name: /Signature pad/ });
  await pad.waitFor();
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(b.x + 40 + i * 20, b.y + b.height / 2 + Math.sin(i) * 25);
  await page.mouse.up();
  await page.getByLabel('Name under the signature').fill('Template Owner');
  await page.getByLabel('Designation').fill('Director');
  await page.getByRole('button', { name: 'Save my signature' }).click();
  await page.getByText('Signature saved.').waitFor();
  await page.getByRole('img', { name: 'Your saved signature' }).waitFor();

  // Print the invoice: the default template, then the HTML one, set on the invoice, signed.
  await page.goto(`${WEB}/orgs/${orgId}/sales/invoices/${inv.body.id}`);
  await page.getByRole('link', { name: 'Print, PDF and sign' }).click();
  await page.waitForURL(/\/print\//);
  await invoiceFrame().getByText('Price each').waitFor();
  await invoiceFrame().getByText('Pay Lotus <Retail> by').waitFor();
  await invoiceFrame().getByText('Rupees Five Thousand Two Only').waitFor();
  await page.getByLabel('Print with').selectOption(htmlTpl.id);
  await invoiceFrame().getByText('For Lotus <Retail>').waitFor();
  await page.getByRole('button', { name: 'Always print this invoice with it' }).click();
  await page.getByText(/is set to print with Plain HTML/).waitFor();
  assert.equal((await call(`${base}/invoice-print/${inv.body.id}`)).body.document.templateId, htmlTpl.id);
  await page.getByRole('button', { name: 'Use the default instead' }).click();
  await invoiceFrame().getByText('Price each').waitFor();

  await page.getByRole('button', { name: 'Sign as Template Owner' }).click();
  await page.getByText('Signature valid').waitFor();
  await invoiceFrame().getByText('Template Owner, Director').waitFor();
  await invoiceFrame().getByText(/E-signed/).waitFor();
  const signed = (await call(`${base}/invoice-print/${inv.body.id}`)).body.signature;
  assert.equal(signed.verification.status, 'VALID');
  await page.getByText(`Hash ${signed.current.contentHash}`).waitFor();

  // Scripts never run inside the frame, even from the page's own markup.
  const sandbox = await page.locator('iframe[title^="Invoice"]').getAttribute('sandbox');
  assert.equal(sandbox.includes('allow-scripts'), false);

  await page.getByRole('button', { name: 'Withdraw…' }).click();
  await page.getByLabel('Why withdraw the signature?').fill('Wrong signatory');
  await page.getByRole('button', { name: 'Withdraw signature' }).click();
  await page.getByRole('button', { name: 'Sign as Template Owner' }).waitFor();
  await page.getByText('Earlier signatures').click();
  await page.getByText(/Wrong signatory/).waitFor();

  assert.deepEqual(consoleErrors.filter((e) => !/favicon|Failed to load resource/.test(e)), []);
});
