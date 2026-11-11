import { layoutFromPreset } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Invoice templates and e-signatures against the real API and database: templates from country
 * presets, saving a customised layout, HTML templates and their safety checks, logos, the default
 * template, archiving, printing an invoice (data and the HTML page), changing a posted invoice's
 * template, signatures (save, sign, verify, withdraw), permissions, tenant isolation and the
 * database guards.
 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let approver: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let T: string;
let customer: { id: string };
let invoiceId: string;
let draftId: string;
const tpl: Record<string, string> = {};

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Template Owner');
  accountant = await registerUser(ctx, 'Asha Accountant');
  viewer = await registerUser(ctx, 'Template Viewer');
  approver = await registerUser(ctx, 'Dev Approver');
  outsider = await registerUser(ctx, 'Template Outsider');
  org = await createOrg(ctx, owner, { name: 'Printworks Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Co' });
  T = `${org.base}/invoice-templates`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [approver, 'APPROVER']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  customer = (
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Bluebird <Retail>', isCustomer: true, email: 'ap@bluebird.test', address: '12 MG Road', city: 'Pune', pincode: '411001' }).expect(201)
  ).body;
  const tax = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
  const inv = (
    await ctx
      .http()
      .post(`${org.base}/sales/documents`)
      .set(owner.auth)
      .send({ kind: 'INVOICE', contactId: customer.id, issueDate: today(), reference: 'PO-77', post: true, lines: [{ accountId: org.acc['4100'], description: 'Widgets', quantity: '10', unitPrice: '1250.00', taxRateId: tax.id }] })
      .expect(201)
  ).body;
  invoiceId = inv.id;
  draftId = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer.id, issueDate: today(), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '100' }] }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('invoice templates', () => {
  it('prints with a built-in template from the country before any template exists', async () => {
    const list = (await ctx.http().get(T).set(viewer.auth).expect(200)).body;
    expect(list).toEqual({ suggestedPresetId: 'IN_GST', items: [] });
    const p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(viewer.auth).expect(200)).body;
    expect(p.template).toMatchObject({ id: null, builtIn: true, presetId: 'IN_GST', engine: 'LAYOUT' });
    expect(p.template.layout.title).toBe('Tax Invoice');
    expect(p.source).toMatchObject({ kind: 'INVOICE', status: 'POSTED', currency: 'INR', subtotal: '12500.00', taxTotal: '2250.00', total: '14750.00', paid: '0.00', signature: null });
    expect(p.source.buyer).toMatchObject({ name: 'Bluebird <Retail>', address: '12 MG Road', city: 'Pune', pincode: '411001' });
    expect(p.source.lines).toEqual([expect.objectContaining({ description: 'Widgets', quantity: '10', unitPrice: '1250', taxRate: '18', netAmount: '12500.00', taxAmount: '2250.00' })]);
    expect(p.signature).toMatchObject({ current: null, verification: null, history: [] });
  });

  it('creates templates from presets; the first becomes the default', async () => {
    const india = (await ctx.http().post(T).set(accountant.auth).send({ name: 'India GST', presetId: 'IN_GST' }).expect(201)).body;
    tpl.india = india.id;
    expect(india).toMatchObject({ name: 'India GST', presetId: 'IN_GST', engine: 'LAYOUT', theme: 'CLASSIC', isDefault: true, title: 'Tax Invoice', hasLogo: false, warnings: [] });
    expect(india.layout.sections).toHaveLength(13);
    const uae = (await ctx.http().post(T).set(owner.auth).send({ name: 'UAE export', presetId: 'AE_VAT', theme: 'BOLD', paletteId: 'ocean' }).expect(201)).body;
    tpl.uae = uae.id;
    expect(uae).toMatchObject({ isDefault: false, theme: 'BOLD', palette: { primary: '#075985' } });
    const html = (await ctx.http().post(T).set(owner.auth).send({ name: 'Custom HTML', presetId: 'US_SALES', engine: 'HTML' }).expect(201)).body;
    tpl.html = html.id;
    expect(html.engine).toBe('HTML');
    expect(html.html).toContain('{{#lines}}');
    await ctx.http().post(T).set(owner.auth).send({ name: 'india gst', presetId: 'GENERIC' }).expect(409);
    await ctx.http().post(T).set(owner.auth).send({ name: 'X', presetId: 'MARS' }).expect(400);
  });

  it('saves a customised layout and warns about country rules it breaks', async () => {
    const layout = layoutFromPreset('IN_GST', { theme: 'ELEGANT' });
    layout.title = 'Invoice';
    layout.palette.primary = '#123456';
    layout.sections.reverse();
    const lines = layout.sections.find((s) => s.key === 'LINES')!;
    lines.columns!.find((c) => c.key === 'HSN')!.visible = false;
    lines.columns!.find((c) => c.key === 'UNIT_PRICE')!.label = 'Price each';
    layout.sections.find((s) => s.key === 'TERMS')!.text = 'Pay {{buyer.name}} within 15 days';
    const saved = (await ctx.http().put(`${T}/${tpl.india}`).set(accountant.auth).send({ name: 'India GST', engine: 'LAYOUT', layout }).expect(200)).body;
    expect(saved.layout.theme).toBe('ELEGANT');
    expect(saved.layout.sections[0].key).toBe('FOOTER');
    expect(saved.layout.palette.primary).toBe('#123456');
    expect(saved.warnings).toHaveLength(2);
    expect(saved.warnings.join(' ')).toMatch(/Tax Invoice/);
    expect(saved.warnings.join(' ')).toMatch(/HSN/);
    // The rules are the engine's: a bad colour or a broken placeholder is refused with a reason.
    const bad = structuredClone(layout);
    bad.palette.text = 'black';
    const r1 = await ctx.http().put(`${T}/${tpl.india}`).set(accountant.auth).send({ name: 'India GST', engine: 'LAYOUT', layout: bad }).expect(422);
    expect(r1.body.message).toMatch(/hex colour/);
    const bad2 = structuredClone(layout);
    bad2.sections[0].text = '{{#lines}}';
    expect((await ctx.http().put(`${T}/${tpl.india}`).set(accountant.auth).send({ name: 'India GST', engine: 'LAYOUT', layout: bad2 }).expect(422)).body.message).toMatch(/never closed/);
  });

  it('saves HTML templates and refuses unsafe ones', async () => {
    const t = (await ctx.http().get(`${T}/${tpl.html}`).set(viewer.auth).expect(200)).body;
    const html = `${t.html}<p class="x">Ref {{doc.reference}} {{doc.nmuber}}</p>`;
    const saved = (await ctx.http().put(`${T}/${tpl.html}`).set(owner.auth).send({ name: 'Custom HTML', engine: 'HTML', layout: t.layout, html }).expect(200)).body;
    expect(saved.warnings).toEqual(['{{doc.nmuber}} is not a known placeholder and will print empty.']);
    for (const [bad, re] of [
      ['<script>fetch("/x")</script>', /<script>/],
      ['<img src="data:image/png;base64,AA" onerror="x()">', /onerror/],
      ['<img src="https://tracker.example/p.png">', /network/],
      ['<a href="javascript:alert(1)">pay</a>', /javascript/],
    ] as const) {
      const r = await ctx.http().put(`${T}/${tpl.html}`).set(owner.auth).send({ name: 'Custom HTML', engine: 'HTML', layout: t.layout, html: bad }).expect(422);
      expect(r.body.message, bad).toMatch(re);
    }
  });

  it('adds a logo (PNG, JPEG or WebP only) and copies it with the template', async () => {
    await ctx.http().put(`${T}/${tpl.uae}/logo`).set(owner.auth).send({ imageBase64: SVG }).expect(422);
    await ctx.http().put(`${T}/${tpl.uae}/logo`).set(owner.auth).send({ imageBase64: 'not base64!' }).expect(422);
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(600_000)]).toString('base64');
    await ctx.http().put(`${T}/${tpl.uae}/logo`).set(owner.auth).send({ imageBase64: big }).expect(413);
    const withLogo = (await ctx.http().put(`${T}/${tpl.uae}/logo`).set(owner.auth).send({ imageBase64: `data:image/png;base64,${PNG}` }).expect(200)).body;
    expect(withLogo.hasLogo).toBe(true);
    expect(withLogo.logoDataUrl).toBe(`data:image/png;base64,${PNG}`);
    const copy = (await ctx.http().post(`${T}/${tpl.uae}/duplicate`).set(owner.auth).send({}).expect(201)).body;
    expect(copy).toMatchObject({ name: 'UAE export (copy)', hasLogo: true, isDefault: false, theme: 'BOLD' });
    tpl.copy = copy.id;
    expect((await ctx.http().post(`${T}/${tpl.uae}/duplicate`).set(owner.auth).send({}).expect(201)).body.name).toBe('UAE export (copy 2)');
    expect((await ctx.http().delete(`${T}/${copy.id}/logo`).set(owner.auth).expect(200)).body.hasLogo).toBe(false);
  });

  it('moves the default and refuses to archive the default or a template in use', async () => {
    await ctx.http().post(`${T}/${tpl.uae}/default`).set(owner.auth).expect(200);
    const list = (await ctx.http().get(T).set(viewer.auth).expect(200)).body.items;
    expect(list.filter((t: { isDefault: boolean }) => t.isDefault).map((t: { id: string }) => t.id)).toEqual([tpl.uae]);
    expect(list[0].id).toBe(tpl.uae);
    expect((await ctx.http().post(`${T}/${tpl.uae}/archive`).set(owner.auth).send({ archived: true }).expect(409)).body.error).toBe('TEMPLATE_IS_DEFAULT');
    const archived = (await ctx.http().post(`${T}/${tpl.copy}/archive`).set(owner.auth).send({ archived: true }).expect(200)).body;
    expect(archived.archived).toBe(true);
    expect((await ctx.http().get(T).set(viewer.auth).expect(200)).body.items.map((t: { id: string }) => t.id)).not.toContain(tpl.copy);
    expect((await ctx.http().get(`${T}?archived=1`).set(viewer.auth).expect(200)).body.items.map((t: { id: string }) => t.id)).toContain(tpl.copy);
    await ctx.http().put(`${T}/${tpl.copy}`).set(owner.auth).send({ name: 'x', engine: 'LAYOUT', layout: archived.layout }).expect(409);
    await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(owner.auth).send({ templateId: tpl.copy }).expect(409);
    await ctx.http().post(`${T}/${tpl.copy}/archive`).set(owner.auth).send({ archived: false }).expect(200);
  });
});

describe('printing', () => {
  it('prints with the default, a chosen template, and the template set on the invoice (even when posted)', async () => {
    let p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(viewer.auth).expect(200)).body;
    expect(p.template).toMatchObject({ id: tpl.uae, builtIn: false, logoDataUrl: `data:image/png;base64,${PNG}` });
    expect(p.source.logoDataUrl).toBe(`data:image/png;base64,${PNG}`);
    expect(p.templates[0]).toMatchObject({ id: tpl.uae, isDefault: true });
    expect(p.templates.map((t: { name: string }) => t.name).sort()).toEqual(['Custom HTML', 'India GST', 'UAE export', 'UAE export (copy 2)', 'UAE export (copy)']);
    p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}?templateId=${tpl.india}`).set(viewer.auth).expect(200)).body;
    expect(p.template.id).toBe(tpl.india);
    expect(p.document.templateId).toBeNull();
    await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(viewer.auth).send({ templateId: tpl.india }).expect(403);
    p = (await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(accountant.auth).send({ templateId: tpl.india }).expect(200)).body;
    expect(p.document.templateId).toBe(tpl.india);
    expect(p.template.id).toBe(tpl.india);
    // A template used by an invoice cannot be archived.
    expect((await ctx.http().post(`${T}/${tpl.india}/archive`).set(owner.auth).send({ archived: true }).expect(409)).body.error).toBe('TEMPLATE_IN_USE');
  });

  it('serves the invoice as a self-contained page with a strict policy', async () => {
    const r = await ctx.http().get(`${org.base}/invoice-print/${invoiceId}/html`).set(viewer.auth).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect(r.headers['content-disposition']).toMatch(/^inline/);
    expect(r.text).toContain('Bluebird &lt;Retail&gt;');
    expect(r.text).toContain('Pay Bluebird &lt;Retail&gt; within 15 days');
    expect(r.text).toContain('Price each');
    expect(r.text).toContain('14,750.00');
    expect(r.text).not.toMatch(/<script/i);
    const d = await ctx.http().get(`${org.base}/invoice-print/${invoiceId}/html?templateId=${tpl.html}&download=1`).set(viewer.auth).expect(200);
    expect(d.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''INV-/);
    expect(d.text).toContain('Ref PO-77');
  });

  it('keeps purchases, other organisations and unknown templates out', async () => {
    const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite', isVendor: true }).expect(201)).body;
    const bill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor.id, issueDate: today(), lines: [{ accountId: org.acc['5100'] ?? org.acc['6100'], quantity: '1', unitPrice: '10' }] }).expect(201)).body;
    await ctx.http().get(`${org.base}/invoice-print/${bill.id}`).set(owner.auth).expect(404);
    await ctx.http().get(`${other.base}/invoice-print/${invoiceId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/invoice-templates/${tpl.india}`).set(outsider.auth).expect(404);
    const foreign = (await ctx.http().post(`${other.base}/invoice-templates`).set(outsider.auth).send({ name: 'Theirs', presetId: 'GENERIC' }).expect(201)).body;
    await ctx.http().get(`${org.base}/invoice-print/${invoiceId}?templateId=${foreign.id}`).set(owner.auth).expect(404);
    await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(owner.auth).send({ templateId: foreign.id }).expect(404);
  });

  it('lets only template managers design templates', async () => {
    await ctx.http().post(T).set(viewer.auth).send({ name: 'Nope', presetId: 'GENERIC' }).expect(403);
    await ctx.http().post(T).set(approver.auth).send({ name: 'Nope', presetId: 'GENERIC' }).expect(403);
    await ctx.http().post(`${T}/${tpl.india}/default`).set(viewer.auth).expect(403);
    await ctx.http().put(`${T}/${tpl.india}/logo`).set(viewer.auth).send({ imageBase64: PNG }).expect(403);
  });
});

describe('e-signatures', () => {
  it('saves, replaces and shows my signature', async () => {
    await ctx.http().get(`${org.base}/signatures/me`).set(viewer.auth).expect(403);
    expect((await ctx.http().get(`${org.base}/signatures/me`).set(accountant.auth).expect(200)).body).toEqual({ signature: null, documentsSigned: 0 });
    await ctx.http().put(`${org.base}/signatures/me`).set(accountant.auth).send({ kind: 'UPLOADED', signerName: 'Asha', imageBase64: SVG }).expect(422);
    await ctx.http().put(`${org.base}/signatures/me`).set(accountant.auth).send({ kind: 'TYPED', signerName: 'Asha R', imageBase64: PNG }).expect(200);
    const mine = (await ctx.http().put(`${org.base}/signatures/me`).set(accountant.auth).send({ kind: 'DRAWN', signerName: 'Asha Rao', designation: 'Finance Manager', imageBase64: PNG }).expect(200)).body;
    expect(mine.signature).toMatchObject({ kind: 'DRAWN', signerName: 'Asha Rao', designation: 'Finance Manager', imageDataUrl: `data:image/png;base64,${PNG}` });
  });

  it('signs a posted invoice only, records what was signed, and shows it on the page', async () => {
    expect((await ctx.http().post(`${org.base}/invoice-print/${draftId}/signature`).set(accountant.auth).expect(409)).body.error).toBe('DOCUMENT_NOT_POSTED');
    expect((await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature`).set(approver.auth).expect(409)).body.error).toBe('NO_SIGNATURE');
    await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature`).set(viewer.auth).expect(403);
    const p = (await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature`).set(accountant.auth).expect(200)).body;
    expect(p.signature.current).toMatchObject({ signerName: 'Asha Rao', designation: 'Finance Manager', signedByName: 'Asha Accountant' });
    expect(p.signature.current.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.signature.current.contentHash).toBe(p.signature.currentHash);
    expect(p.signature.verification).toEqual({ status: 'VALID', message: 'The invoice is unchanged since it was signed.' });
    expect(p.source.signature).toMatchObject({ signerName: 'Asha Rao', imageDataUrl: `data:image/png;base64,${PNG}` });
    expect((await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature`).set(accountant.auth).expect(409)).body.error).toBe('ALREADY_SIGNED');
    const page = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}/html`).set(viewer.auth).expect(200)).text;
    expect(page).toContain('Asha Rao, Finance Manager');
    expect(page).toContain(`Content hash ${p.signature.current.contentHash.slice(0, 16)}`);
    // Changing the template afterwards does not touch the signature.
    const again = (await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(accountant.auth).send({ templateId: tpl.uae }).expect(200)).body;
    expect(again.signature.verification.status).toBe('VALID');
    expect((await ctx.http().get(`${org.base}/signatures/me`).set(accountant.auth).expect(200)).body.documentsSigned).toBe(1);
  });

  it('keeps the signed copy when the signer replaces their signature', async () => {
    const NEW_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await ctx.http().put(`${org.base}/signatures/me`).set(accountant.auth).send({ kind: 'DRAWN', signerName: 'Asha Rao', imageBase64: NEW_PNG }).expect(200);
    let p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(viewer.auth).expect(200)).body;
    expect(p.signature.current.imageDataUrl).toBe(`data:image/png;base64,${PNG}`);
    p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(viewer.auth).expect(200)).body;
    expect(p.signature.verification.status).toBe('VALID');
  });

  it('withdraws a signature with a reason; only the signer or an owner can', async () => {
    await ctx.http().put(`${org.base}/signatures/me`).set(approver.auth).send({ kind: 'TYPED', signerName: 'Dev', imageBase64: PNG }).expect(200);
    expect((await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature/withdraw`).set(approver.auth).send({ reason: 'Not mine to withdraw' }).expect(403)).body.error).toBe('NOT_YOUR_SIGNATURE');
    await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature/withdraw`).set(accountant.auth).send({ reason: 'x' }).expect(400);
    const p = (await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature/withdraw`).set(accountant.auth).send({ reason: 'Signed the wrong copy' }).expect(200)).body;
    expect(p.signature.current).toBeNull();
    expect(p.signature.history).toEqual([expect.objectContaining({ signerName: 'Asha Rao', withdrawnByName: 'Asha Accountant', withdrawReason: 'Signed the wrong copy' })]);
    // Another signer can now sign.
    const s = (await ctx.http().post(`${org.base}/invoice-print/${invoiceId}/signature`).set(approver.auth).expect(200)).body;
    expect(s.signature.current.signerName).toBe('Dev');
    expect(s.signature.history).toHaveLength(2);
  });

  it('shows a voided invoice as voided after signing', async () => {
    await ctx.http().post(`${org.base}/sales/documents/${invoiceId}/void`).set(owner.auth).send({ date: today(), reason: 'Issued in error' }).expect(200);
    const p = (await ctx.http().get(`${org.base}/invoice-print/${invoiceId}`).set(viewer.auth).expect(200)).body;
    expect(p.signature.verification.status).toBe('VOIDED');
    expect(p.source.status).toBe('VOID');
    expect((await ctx.http().get(`${org.base}/invoice-print/${invoiceId}/html`).set(viewer.auth).expect(200)).text).toContain('class="stamp">VOID');
    await ctx.http().put(`${org.base}/invoice-print/${invoiceId}/template`).set(owner.auth).send({ templateId: null }).expect(409);
  });

  it('removes my signature', async () => {
    const r = (await ctx.http().delete(`${org.base}/signatures/me`).set(approver.auth).expect(200)).body;
    expect(r.signature).toBeNull();
    await ctx.http().delete(`${org.base}/signatures/me`).set(approver.auth).expect(404);
  });
});

describe('database guards', () => {
  it('keeps signatures and posted documents as they were', async () => {
    await expect(raw(`DELETE FROM document_signatures WHERE document_id = $1::uuid`, invoiceId)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE document_signatures SET signer_name = 'Someone else' WHERE document_id = $1::uuid`, invoiceId)).rejects.toThrow(/only to be withdrawn/);
    await expect(raw(`UPDATE user_signatures SET signer_name = 'X' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/only to be revoked/);
    await expect(raw(`DELETE FROM user_signatures WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/never deleted/);
    // Drafts cannot be signed even by writing to the table directly.
    await expect(
      raw(
        `INSERT INTO document_signatures (id, org_id, document_id, signature_id, signed_by_id, signer_name, image, image_type, content_hash)
         SELECT gen_random_uuid(), org_id, $1::uuid, id, user_id, signer_name, image, image_type, repeat('a', 64) FROM user_signatures WHERE org_id = $2::uuid AND revoked_at IS NULL LIMIT 1`,
        draftId,
        org.orgId,
      ),
    ).rejects.toThrow(/Only posted invoices/);
    // A posted document still changes only its template, nothing else.
    const posted = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer.id, issueDate: today(), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '100' }] }).expect(201)).body;
    await raw(`UPDATE documents SET template_id = $1::uuid WHERE id = $2::uuid`, tpl.india, posted.id);
    await expect(raw(`UPDATE documents SET memo = 'changed', template_id = NULL WHERE id = $1::uuid`, posted.id)).rejects.toThrow(/immutable/);
    await expect(raw(`UPDATE invoice_templates SET archived_at = now() WHERE id = $1::uuid`, tpl.india)).rejects.toThrow(/used by documents/);
    await expect(raw(`UPDATE invoice_templates SET is_default = true WHERE id = $1::uuid`, tpl.html)).rejects.toThrow(/Unique constraint|unique/i);
    await expect(raw(`UPDATE invoice_templates SET engine = 'HTML', html = NULL WHERE id = $1::uuid`, tpl.india)).rejects.toThrow(/invoice_templates_html_chk/);
  });
});
