import { gstinCheckCharacter, openStatus } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

// Months inside the fiscal year created at onboarding (April to March of the current year).
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const APR = `${FY}-04`;
const MAY = `${FY}-05`;
const JUL = `${FY}-07`;
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

interface Item {
  key: string;
  kind: string;
  dueDate: string;
  status: string;
  amount: string | null;
  paid: string | null;
  detail: string;
  evidence: { type: string; id: string; label: string }[];
  filing: { id: string; reference: string; filedOn: string } | null;
}
interface Calendar {
  configured: boolean;
  summary: Record<string, number>;
  overdueBefore: Item[];
  items: Item[];
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Compliance Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

const cal = async (from: string, to: string, auth = owner.auth) => (await ctx.http().get(`${org.base}/compliance/calendar`).query({ from, to }).set(auth).expect(200)).body as Calendar;
const item = (c: Calendar, key: string) => {
  const i = c.items.find((x) => x.key === key);
  if (!i) throw new Error(`${key} not in ${c.items.map((x) => x.key).join(', ')}`);
  return i;
};
const file = (key: string, body: Record<string, unknown> = {}) => ctx.http().post(`${org.base}/compliance/filings`).set(owner.auth).send({ key, filedOn: `${MAY}-18`, reference: 'AA270526123456X', ...body });

describe('calendar from the organisation set-up', () => {
  it('is empty until something applies', async () => {
    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    expect(c).toMatchObject({ configured: false, items: [], overdueBefore: [] });
    await ctx.http().get(`${org.base}/compliance/calendar`).query({ from: `${MAY}-31`, to: `${MAY}-01` }).set(owner.auth).expect(422);
    await ctx.http().get(`${org.base}/compliance/calendar`).query({ from: `${FY}-01-01`, to: `${FY + 2}-01-01` }).set(owner.auth).expect(422);
  });

  it('lists monthly GST returns once GST is registered', async () => {
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZCK0001Z'), effectiveFrom: `${APR}-01` }).expect(200);
    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    expect(c.configured).toBe(true);
    expect(c.items.map((i) => `${i.key}@${i.dueDate}`)).toEqual([`GSTR1:${APR}@${MAY}-11`, `GSTR3B:${APR}@${MAY}-20`]);
    expect(item(c, `GSTR3B:${APR}`)).toMatchObject({ status: openStatus(`${MAY}-20`, t), filing: null, amount: null });
  });

  it('switches to QRMP dates for a quarterly filer in Maharashtra', async () => {
    expect((await ctx.http().put(`${org.base}/compliance/settings`).set(owner.auth).send({ gstReturnFrequency: 'QUARTERLY', advanceTaxFrom: null }).expect(200)).body).toMatchObject({ gstReturnFrequency: 'QUARTERLY', areas: { gst: { stateCode: '27' } } });
    const c = await cal(`${MAY}-01`, `${JUL}-31`);
    expect(c.items.map((i) => `${i.key}@${i.dueDate}`)).toEqual([`GST_PMT06:${APR}@${MAY}-25`, `GST_PMT06:${MAY}@${FY}-06-25`, `GSTR1:Q1 ${FY}-${String((FY + 1) % 100).padStart(2, '0')}@${JUL}-13`, `GSTR3B:Q1 ${FY}-${String((FY + 1) % 100).padStart(2, '0')}@${JUL}-22`]);
    await ctx.http().put(`${org.base}/compliance/settings`).set(owner.auth).send({ gstReturnFrequency: 'MONTHLY', advanceTaxFrom: null }).expect(200);
  });
});

describe('marking returns filed', () => {
  it('records the acknowledgement, once, and only for returns the organisation has', async () => {
    const f = (await file(`GSTR3B:${APR}`).expect(201)).body;
    expect(f).toMatchObject({ filedOn: `${MAY}-18`, reference: 'AA270526123456X' });
    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    expect(item(c, `GSTR3B:${APR}`)).toMatchObject({ status: 'DONE', filing: { id: f.id, reference: 'AA270526123456X' } });
    expect((await file(`GSTR3B:${APR}`).expect(409)).body.error).toBe('ALREADY_FILED');
    expect((await file(`PF:${APR}`).expect(422)).body.error).toBe('SETTLED_BY_RECORDS');
    expect((await file(`GSTR3B:${FY - 3}-04`).expect(422)).body.error).toBe('UNKNOWN_OBLIGATION');
    expect((await file(`TDS_STATEMENT:Q1 ${FY}-${String((FY + 1) % 100).padStart(2, '0')}`).expect(422)).body.error).toBe('UNKNOWN_OBLIGATION');
    expect((await file(`GSTR1:${APR}`, { filedOn: `${FY + 2}-01-01` }).expect(422)).body.error).toBe('INVALID_DATE');
    expect((await file(`GSTR1:${APR}`, { filedOn: `${FY}-03-31` }).expect(422)).body.error).toBe('INVALID_DATE');
    await file(`GSTR1:${APR}`, { reference: '' }).expect(400);
  });

  it('voids a filing record, after which it can be filed again', async () => {
    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    const id = item(c, `GSTR3B:${APR}`).filing!.id;
    await ctx.http().post(`${org.base}/compliance/filings/${id}/void`).set(owner.auth).send({ reason: 'Wrong ARN' }).expect(200);
    await ctx.http().post(`${org.base}/compliance/filings/${id}/void`).set(owner.auth).send({ reason: 'Again' }).expect(409);
    expect(item(await cal(`${MAY}-01`, `${MAY}-31`), `GSTR3B:${APR}`).status).not.toBe('DONE');
    await file(`GSTR3B:${APR}`, { reference: 'AA270526999999Z', filedOn: `${MAY}-21` }).expect(201);
    const after = item(await cal(`${MAY}-01`, `${MAY}-31`), `GSTR3B:${APR}`);
    expect(after).toMatchObject({ status: 'DONE', filing: { reference: 'AA270526999999Z' } });
    expect(after.detail).toBe('Marked filed after the due date');
    const list = (await ctx.http().get(`${org.base}/compliance/filings`).set(owner.auth).expect(200)).body as { status: string; voidReason: string | null }[];
    expect(list.map((x) => x.status).sort()).toEqual(['FILED', 'VOID']);
  });

  it('keeps filing records immutable in the database', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE compliance_filings SET reference = 'X' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM compliance_filings WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
  });
});

describe('payments settled by the books', () => {
  let billId = '';
  let runId = '';

  it('shows TDS from bills and payroll as one monthly deposit, with PF, ESI and professional tax', async () => {
    // TDS: a TAN, the professional fees section and a bill with TDS in April.
    await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'PNEZ12345B' }).expect(200);
    const section = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(iii)(b)' }).expect(201)).body;
    const exempt = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt', rate: '0', kind: 'GST', gstCategory: 'EXEMPT' }).expect(201)).body;
    const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Adv. R. Joshi', isVendor: true, stateCode: '27', pan: 'ZZZPJ0071Z' }).expect(201)).body;
    const bill = await ctx
      .http()
      .post(`${org.base}/purchases/documents`)
      .set(owner.auth)
      .send({ kind: 'BILL', contactId: vendor.id, issueDate: `${APR}-15`, post: true, withholdingSectionId: section.id, lines: [{ accountId: org.acc['6600'], description: 'Legal fees', quantity: '1', unitPrice: '60000.00', taxRateId: exempt.id, hsnCode: '998211' }] })
      .expect(201);
    billId = bill.body.id;
    expect(bill.body.withholding.amount).toBe('6000.00');

    // Payroll: one employee paid for April.
    await ctx.http().put(`${org.base}/payroll/settings`).set(owner.auth).send({}).expect(200);
    await ctx
      .http()
      .post(`${org.base}/payroll/employees`)
      .set(owner.auth)
      .send({ code: 'E1', name: 'Asha', pan: 'ZZZPK1001Z', dateOfJoining: `${APR}-01`, workStateCode: '27', structure: { effectiveFrom: `${APR}-01`, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '60000' }, { code: 'HRA', name: 'HRA', kind: 'EXCLUDED', monthlyAmount: '30000' }, { code: 'SPECIAL', name: 'Special', kind: 'WAGES', monthlyAmount: '20000' }] } })
      .expect(201);
    const run = (await ctx.http().post(`${org.base}/payroll/runs`).set(owner.auth).send({ period: APR, payDate: `${APR}-30` }).expect(201)).body;
    runId = run.id;
    const posted = (await ctx.http().post(`${org.base}/payroll/runs/${run.id}/post`).set(owner.auth).expect(200)).body as { liabilities: { liability: string; amount: string }[] };
    const due = Object.fromEntries(posted.liabilities.map((l) => [l.liability, l.amount]));
    expect(Number(due.TDS)).toBeGreaterThan(0);

    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    expect(c.items.map((i) => i.key)).toEqual([`TDS_DEPOSIT:${APR}`, `TCS_DEPOSIT:${APR}`, `GSTR1:${APR}`, `PF:${APR}`, `ESI:${APR}`, `GSTR3B:${APR}`, `PT:${APR}`]);
    const tds = item(c, `TDS_DEPOSIT:${APR}`);
    expect(tds).toMatchObject({ amount: (6000 + Number(due.TDS)).toFixed(2), paid: '0.00', status: openStatus(`${MAY}-07`, t) });
    expect(item(c, `TCS_DEPOSIT:${APR}`)).toMatchObject({ status: 'NOTHING_DUE', amount: '0.00' });
    expect(item(c, `PF:${APR}`)).toMatchObject({ amount: due.PF, paid: '0.00', evidence: [{ type: 'PAY_RUN', id: run.id }] });
    expect(item(c, `ESI:${APR}`)).toMatchObject({ status: 'NOTHING_DUE' });
    expect(item(c, `PT:${APR}`)).toMatchObject({ amount: '200.00' });
    // Payments are settled by records, never marked filed.
    expect((await file(`TDS_DEPOSIT:${APR}`).expect(422)).body.error).toBe('SETTLED_BY_RECORDS');
  });

  it('is done when the challan and the payroll payment are recorded', async () => {
    await ctx.http().post(`${org.base}/withholding/deposits`).set(owner.auth).send({ kind: 'TDS', depositDate: `${MAY}-06`, bankAccountId: org.acc['1120'], challanReference: 'CIN 0510001-06052026-00011', documentIds: [billId] }).expect(201);
    let tds = item(await cal(`${MAY}-01`, `${MAY}-31`), `TDS_DEPOSIT:${APR}`);
    expect(tds.paid).toBe('6000.00');
    expect(tds.status).not.toBe('DONE');
    expect(tds.detail).toBe('Partly paid');
    for (const liability of ['TDS', 'PF']) {
      await ctx.http().post(`${org.base}/payroll/runs/${runId}/payments`).set(owner.auth).send({ liability, date: `${MAY}-06`, bankAccountId: org.acc['1120'], reference: `CHALLAN-${liability}` }).expect(201);
    }
    const c = await cal(`${MAY}-01`, `${MAY}-31`);
    tds = item(c, `TDS_DEPOSIT:${APR}`);
    expect(tds).toMatchObject({ status: 'DONE', detail: 'Paid in full' });
    expect(tds.evidence.map((e) => e.type)).toEqual(['WITHHOLDING_DEPOSIT', 'PAY_RUN', 'PAYROLL_PAYMENT']);
    expect(item(c, `PF:${APR}`)).toMatchObject({ status: 'DONE' });
    expect(item(c, `PT:${APR}`).status).not.toBe('DONE');
  });

  it('adds advance tax instalments when tracked, marked paid with the challan', async () => {
    await ctx.http().put(`${org.base}/compliance/settings`).set(owner.auth).send({ gstReturnFrequency: 'MONTHLY', advanceTaxFrom: `${APR}-01` }).expect(200);
    const c = await cal(`${FY}-06-15`, `${FY}-06-15`);
    expect(c.items.map((i) => i.key)).toEqual([`PF:${MAY}`, `ESI:${MAY}`, `ADVANCE_TAX:${FY}-06`]);
    // No May pay run was posted, so its PF is open.
    expect(item(c, `PF:${MAY}`).detail).toBe('No pay run posted for this month');
    await file(`ADVANCE_TAX:${FY}-06`, { filedOn: `${FY}-06-12`, reference: 'BSR 0510001 12062026 00042' }).expect(201);
    expect(item(await cal(`${FY}-06-15`, `${FY}-06-15`), `ADVANCE_TAX:${FY}-06`).status).toBe('DONE');
  });

  it('lists what is still overdue from before the window', async () => {
    const after = `${FY + 1}-02-01`;
    const c = await cal(after, `${FY + 1}-02-28`);
    // April's GSTR-1 was never filed, so it carries forward as overdue when the window is later.
    if (after > `${MAY}-11` && t > `${MAY}-11`) expect(c.overdueBefore.map((i) => i.key)).toContain(`GSTR1:${APR}`);
    expect(c.overdueBefore.every((i) => i.status === 'OVERDUE')).toBe(true);
    expect(c.overdueBefore.map((i) => i.key)).not.toContain(`GSTR3B:${APR}`);
  });
});

describe('access', () => {
  it('lets viewers read the calendar but not file, and keeps organisations apart', async () => {
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    await cal(`${MAY}-01`, `${MAY}-31`, viewer.auth);
    await ctx.http().post(`${org.base}/compliance/filings`).set(viewer.auth).send({ key: `GSTR1:${APR}`, filedOn: `${MAY}-11`, reference: 'X' }).expect(403);
    await ctx.http().put(`${org.base}/compliance/settings`).set(viewer.auth).send({ gstReturnFrequency: 'MONTHLY', advanceTaxFrom: null }).expect(403);
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    const filing = item(await cal(`${MAY}-01`, `${MAY}-31`), `GSTR3B:${APR}`).filing!;
    await ctx.http().post(`${otherOrg.base}/compliance/filings/${filing.id}/void`).set(other.auth).send({ reason: 'Not mine' }).expect(404);
    expect((await ctx.http().get(`${otherOrg.base}/compliance/filings`).set(other.auth).expect(200)).body).toEqual([]);
  });
});
