import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Tax notices (TAX-024): recorded, tracked to the reply deadline, answered, closed, kept with their files. */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let gst: string;
const T = today();
const day = (n: number) => new Date(Date.parse(`${T}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const notices = () => ctx.http().post(`${org.base}/tax-notices`);
const act = (id: string, step: string, body: object, u = accountant) => ctx.http().post(`${org.base}/tax-notices/${id}/${step}`).set(u.auth).send(body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Notice Owner');
  accountant = await registerUser(ctx, 'Notice Accountant');
  viewer = await registerUser(ctx, 'Notice Viewer');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('tax notices', () => {
  it('are recorded by those who keep the books, checked, and unique per authority', async () => {
    const body = { authority: 'GST', reference: 'ZD271125001234X', section: 'ASMT-10', subject: 'Mismatch between GSTR-1 and GSTR-3B (synthetic)', period: '2025-26', receivedOn: day(-10), responseDue: day(5), demand: '48250.00', assigneeId: accountant.id };
    await notices().set(viewer.auth).send(body).expect(403);
    const bad = await notices().set(accountant.auth).send({ ...body, receivedOn: day(2), responseDue: day(1), demand: '1.005' }).expect(422);
    expect(bad.body.details.issues).toEqual(['The notice cannot be received in the future', 'The reply cannot be due before the notice was received', 'The amount demanded has at most 2 decimal places']);
    const n = (await notices().set(accountant.auth).send(body).expect(201)).body;
    gst = n.id;
    expect(n).toMatchObject({ authorityLabel: 'GST', status: 'OPEN', demand: '48250.00', assignee: 'Notice Accountant', urgency: 'DUE_SOON', daysLeft: 5 });
    expect(n.history).toEqual([expect.objectContaining({ kind: 'RECEIVED', on: day(-10), by: 'Notice Accountant' })]);
    expect((await notices().set(accountant.auth).send({ ...body, reference: 'zd271125001234x' }).expect(409)).body.error).toBe('NOTICE_EXISTS');
    // The same number from another authority is a different notice.
    await notices().set(accountant.auth).send({ ...body, authority: 'INCOME_TAX', section: '143(2)', subject: 'Scrutiny (synthetic)', responseDue: day(-1), demand: null, assigneeId: null }).expect(201);
    await notices().set(accountant.auth).send({ authority: 'TDS', reference: 'TDS-SYN-1', subject: 'Short deduction (synthetic)', receivedOn: day(-3) }).expect(201);
  });

  it('are listed by urgency, overdue first, for anyone who reads reports', async () => {
    const l = (await ctx.http().get(`${org.base}/tax-notices`).set(viewer.auth).expect(200)).body;
    expect(l.summary).toEqual({ open: 3, overdue: 1, dueSoon: 1, responded: 0, closed: 0 });
    expect(l.items.map((i: { authority: string; urgency: string }) => [i.authority, i.urgency])).toEqual([['INCOME_TAX', 'OVERDUE'], ['GST', 'DUE_SOON'], ['TDS', 'NO_DEADLINE']]);
  });

  it('keep files, notes, the reply and the outcome in their history', async () => {
    await ctx.http().post(`${org.base}/tax-notices/${gst}/files?fileName=asmt-10.pdf`).set(accountant.auth).set('Content-Type', 'application/pdf').send(PDF).expect(201);
    await ctx.http().post(`${org.base}/tax-notices/${gst}/files?fileName=x.pdf`).set(accountant.auth).set('Content-Type', 'application/octet-stream').send(Buffer.from('not a pdf')).expect(422);
    await act(gst, 'notes', { text: 'Reconciliation sent to the consultant' }).expect(200);
    await act(gst, 'respond', { on: day(1), text: 'Too early' }).expect(422);
    const r = (await act(gst, 'respond', { on: T, text: 'Filed ASMT-11 with reconciliation' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'RESPONDED', urgency: 'DONE' });
    expect((await act(gst, 'respond', { on: T, text: 'Again' }).expect(409)).body.error).toBe('NOTICE_NOT_OPEN');
    const c = (await act(gst, 'close', { outcome: 'DROPPED', text: 'Officer accepted the reply' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CLOSED', outcome: 'DROPPED', outcomeLabel: 'Dropped with no demand' });
    expect(c.history.map((h: { kind: string }) => h.kind)).toEqual(['RECEIVED', 'FILE', 'NOTE', 'RESPONDED', 'CLOSED']);
    expect(c.files).toEqual([expect.objectContaining({ fileName: 'asmt-10.pdf', contentType: 'application/pdf', sizeBytes: PDF.length })]);
    const dl = await ctx.http().get(`${org.base}/tax-notices/${gst}/files/${c.files[0].id}/content`).set(viewer.auth).buffer(true).parse((res, cb) => {
      const parts: Buffer[] = [];
      res.on('data', (x: Buffer) => parts.push(x));
      res.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200);
    expect(Buffer.compare(dl.body as Buffer, PDF)).toBe(0);

    // Closed notices are not changed; reopening takes it back to replied.
    await ctx.http().put(`${org.base}/tax-notices/${gst}`).set(accountant.auth).send({ reference: 'ZD271125001234X', subject: 'Changed', receivedOn: day(-10) }).expect(409);
    const re = (await act(gst, 'reopen', { text: 'Demand order received after all' }).expect(200)).body;
    expect(re).toMatchObject({ status: 'RESPONDED', outcome: null });
    const ed = (await ctx.http().put(`${org.base}/tax-notices/${gst}`).set(accountant.auth).send({ reference: 'ZD271125001234X', section: 'DRC-07', subject: 'Demand order (synthetic)', period: '2025-26', receivedOn: day(-10), responseDue: day(30), demand: '12000', assigneeId: accountant.id }).expect(200)).body;
    expect(ed.history.at(-1)).toMatchObject({ kind: 'UPDATED', text: 'Changed section, subject, responseDue, demand' });
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: { startsWith: 'tax_notice.' } } })).toBe(9);
  });
});
