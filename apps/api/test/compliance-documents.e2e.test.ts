import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Compliance document management (TAX-025) against the real API and database: acknowledgements
 * filed against GSTR-1 returns marked filed, a registration certificate kept for the organisation,
 * the returns still missing their acknowledgement, and void records kept as they were.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const monthOf = (back: number) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
type Doc = { id: string; reference: string; kind: string; obligation: { key: string; name: string; periodLabel: string } | null; title: string; retainUntil: string | null; status: string; files: { fileName: string }[]; canManage?: boolean };
type Gap = { key: string; needs: string; needsLabel: string; emptyRecord: boolean };
const upload = (user: TestUser, id: string, name: string) => ctx.http().post(`${org.base}/attachments?entityType=COMPLIANCE_DOCUMENT&entityId=${id}&fileName=${name}`).set(user.auth).set('content-type', 'application/pdf').send(pdf(name));
const add = async (body: Record<string, unknown>) => (await ctx.http().post(`${org.base}/compliance/documents`).set(owner.auth).send(body).expect(201)).body as Doc;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Docs Owner');
  viewer = await registerUser(ctx, 'Docs Viewer');
  employee = await registerUser(ctx, 'Docs Employee');
  org = await createOrg(ctx, owner, { name: 'Compliance Docs Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  for (const m of [3, 2, 1].map(monthOf)) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: synthetic('29', 'ZZZCD0001Z'), legalName: 'Compliance Docs Pvt Ltd', effectiveFrom: `${monthOf(3)}-01` }).expect(200);
  for (const back of [2, 1]) await ctx.http().post(`${org.base}/compliance/filings`).set(owner.auth).send({ key: `GSTR1:${monthOf(back)}`, filedOn: `${monthOf(back - 1)}-10`, reference: `ARN${back}` }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('compliance documents', () => {
  it('keeps acknowledgements against returns and finds the filed returns missing theirs', async () => {
    const obligations = (await ctx.http().get(`${org.base}/compliance/documents/obligations`).set(owner.auth).expect(200)).body as { key: string; expects: string; status: string }[];
    expect(obligations.find((o) => o.key === `GSTR1:${monthOf(2)}`)).toMatchObject({ expects: 'ACKNOWLEDGEMENT', status: 'DONE' });

    const ack = await add({ kind: 'ACKNOWLEDGEMENT', obligationKey: `GSTR1:${monthOf(2)}`, title: 'GSTR-1 acknowledgement', reference: 'AA2911260000001' });
    expect(ack).toMatchObject({ reference: 'CD-001', obligation: { key: `GSTR1:${monthOf(2)}`, name: expect.stringContaining('GSTR-1') }, status: 'ACTIVE', canManage: true });
    const fyEnd = Number(monthOf(2).slice(5, 7)) >= 4 ? Number(monthOf(2).slice(0, 4)) + 1 : Number(monthOf(2).slice(0, 4));
    expect(ack.retainUntil).toBe(`${fyEnd + 8}-03-31`);
    await upload(owner, ack.id, 'ack.pdf').expect(201);
    const empty = await add({ kind: 'ACKNOWLEDGEMENT', obligationKey: `GSTR1:${monthOf(1)}`, title: 'GSTR-1 acknowledgement (to scan)' });
    const cert = await add({ kind: 'REGISTRATION', title: 'GST registration certificate (REG-06)' });
    expect(cert).toMatchObject({ obligation: null, retainUntil: null });

    const gaps = (await ctx.http().get(`${org.base}/compliance/documents/gaps`).set(viewer.auth).expect(200)).body as { done: number; complete: number; items: Gap[] };
    expect(gaps.items.find((g) => g.key === `GSTR1:${monthOf(2)}`)).toBeUndefined();
    expect(gaps.items.find((g) => g.key === `GSTR1:${monthOf(1)}`)).toMatchObject({ needs: 'ACKNOWLEDGEMENT', needsLabel: 'Acknowledgement', emptyRecord: true });
    expect(gaps.done - gaps.complete).toBe(gaps.items.length);

    await upload(owner, empty.id, 'ack-2.pdf').expect(201);
    const after = (await ctx.http().get(`${org.base}/compliance/documents/gaps`).set(owner.auth).expect(200)).body as { items: Gap[] };
    expect(after.items.find((g) => g.key === `GSTR1:${monthOf(1)}`)).toBeUndefined();

    const list = (await ctx.http().get(`${org.base}/compliance/documents`).set(viewer.auth).expect(200)).body as { canManage: boolean; items: Doc[] };
    expect(list.canManage).toBe(false);
    expect(list.items.map((d) => d.reference)).toEqual(['CD-003', 'CD-002', 'CD-001']);
    expect(list.items.find((d) => d.id === ack.id)!.files.map((f) => f.fileName)).toEqual(['ack.pdf']);
    const byKind = (await ctx.http().get(`${org.base}/compliance/documents`).query({ kind: 'REGISTRATION' }).set(owner.auth).expect(200)).body as { items: Doc[] };
    expect(byKind.items.map((d) => d.id)).toEqual([cert.id]);
    const byKey = (await ctx.http().get(`${org.base}/compliance/documents`).query({ key: `GSTR1:${monthOf(2)}` }).set(owner.auth).expect(200)).body as { items: Doc[] };
    expect(byKey.items.map((d) => d.id)).toEqual([ack.id]);
  });

  it('voids records with a reason and keeps them, with their files fixed', async () => {
    const wrong = await add({ kind: 'CHALLAN', title: 'Wrong upload' });
    const v = (await ctx.http().post(`${org.base}/compliance/documents/${wrong.id}/void`).set(owner.auth).send({ reason: 'Uploaded to the wrong company' }).expect(201)).body as Doc & { voidReason: string };
    expect(v).toMatchObject({ status: 'VOID', voidReason: 'Uploaded to the wrong company', canManage: false });
    expect((await ctx.http().post(`${org.base}/compliance/documents/${wrong.id}/void`).set(owner.auth).send({ reason: 'Again' }).expect(409)).body.error).toBe('ALREADY_VOID');
    expect((await upload(owner, wrong.id, 'late.pdf').expect(409)).body.error).toBe('DOCUMENT_VOID');
    const active = (await ctx.http().get(`${org.base}/compliance/documents`).set(owner.auth).expect(200)).body as { items: Doc[] };
    expect(active.items.some((d) => d.id === wrong.id)).toBe(false);
    const all = (await ctx.http().get(`${org.base}/compliance/documents`).query({ includeVoid: 'true' }).set(owner.auth).expect(200)).body as { items: Doc[] };
    expect(all.items.find((d) => d.id === wrong.id)).toMatchObject({ status: 'VOID' });
  });

  it('checks the link, permissions and country', async () => {
    expect((await ctx.http().post(`${org.base}/compliance/documents`).set(owner.auth).send({ kind: 'REGISTRATION', obligationKey: `GSTR1:${monthOf(2)}`, title: 'X' }).expect(422)).body.error).toBe('REGISTRATION_NOT_LINKED');
    expect((await ctx.http().post(`${org.base}/compliance/documents`).set(owner.auth).send({ kind: 'ACKNOWLEDGEMENT', obligationKey: 'GSTR1:2001-01', title: 'X' }).expect(422)).body.error).toBe('UNKNOWN_OBLIGATION');
    await ctx.http().post(`${org.base}/compliance/documents`).set(owner.auth).send({ kind: 'NOPE', title: 'X' }).expect(400);
    await ctx.http().post(`${org.base}/compliance/documents`).set(viewer.auth).send({ kind: 'OTHER', title: 'X' }).expect(403);
    const any = (await ctx.http().get(`${org.base}/compliance/documents`).set(owner.auth).expect(200)).body.items[0] as Doc;
    expect((await upload(viewer, any.id, 'v.pdf').expect(403)).body.error).toBe('FORBIDDEN');
    await ctx.http().get(`${org.base}/compliance/documents`).set(employee.auth).expect(403);
    const uk = await createOrg(ctx, owner, { name: 'UK Docs Ltd', countryCode: 'GB', functionalCurrency: 'GBP' });
    expect((await ctx.http().get(`${uk.base}/compliance/documents`).set(owner.auth).expect(422)).body.error).toBe('NOT_INDIA');
    await ctx.http().get(`${uk.base}/compliance/documents/${any.id}`).set(owner.auth).expect(422);
  });
});
