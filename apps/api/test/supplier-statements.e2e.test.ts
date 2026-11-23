import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Supplier statement reconciliation (AP-011) against the real API and database: a supplier's
 * statement matched to bills by their invoice numbers (whatever the separators and zeros), to a
 * bill and a payment by amount and date, with a bill not entered yet, a payment they have not
 * received, a price difference and a statement that does not add up; marked reconciled with a
 * note; permissions, audit and tenants.
 */
const T = today();
const day = (n: number) => addDays(T, n);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const ids: Record<string, string> = {};
const url = (p = '') => `${org.base}/purchases/supplier-statements${p}`;
const LINES = [
  { date: day(-30), reference: 'PM-26-27-0101', kind: 'INVOICE', amount: '11800.00' },
  { date: day(-22), reference: 'PM/26-27/108', kind: 'INVOICE', amount: '5900.00' },
  { date: day(-13), reference: 'PM/26-27/115', kind: 'INVOICE', amount: '2400.00' },
  { date: day(-15), reference: 'NEFT 1111', kind: 'PAYMENT', amount: '11800.00' },
  { date: day(-5), reference: 'PM/26-27/121', kind: 'INVOICE', amount: '1180.00', description: 'Toner' },
];
const statement = (o: Record<string, unknown> = {}) => ({ contactId: c.vendor, from: day(-35), to: day(-1), theirOpening: '1000.00', theirClosing: '10480.00', lines: LINES, ...o });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Statement Owner');
  viewer = await registerUser(ctx, 'Statement Viewer');
  org = await createOrg(ctx, owner, { name: 'Reconciling Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const d of [day(-60), T]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(d, 4) });
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  c.vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Paper Mart (synthetic)', isVendor: true }).expect(201)).body.id;
  c.customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Only A Customer', isCustomer: true }).expect(201)).body.id;
  const bill = async (k: string, date: string, amount: string, reference?: string) =>
    (ids[k] = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c.vendor, issueDate: date, dueDate: date, reference, post: true, lines: [{ accountId: org.acc['6600'], description: 'Stationery', quantity: '1', unitPrice: amount }] }).expect(201)).body.id);
  const pay = async (k: string, date: string, amount: string, reference?: string) =>
    (ids[k] = (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: c.vendor, date, bankAccountId: org.acc['1120'], amount, reference }).expect(201)).body.id);
  await bill('before', day(-60), '1000.00', 'PM/26-27/090');
  await bill('b1', day(-30), '11800.00', 'PM/26-27/101');
  await bill('b2', day(-23), '5900.00');
  await bill('b3', day(-13), '2360.00', 'PM/26-27/115');
  await pay('p1', day(-18), '11800.00', 'UTR1111');
  await pay('p2', day(-3), '3000.00');
});
afterAll(async () => ctx?.app.close());

describe('supplier statements', () => {
  it('matches the statement to the books and accounts for every rupee of the difference', async () => {
    await ctx.http().post(url()).set(viewer.auth).send(statement()).expect(403);
    const s = (await ctx.http().post(url()).set(owner.auth).send(statement()).expect(201)).body;
    ids.statement = s.id;
    expect(s).toMatchObject({ contact: { name: 'Paper Mart (synthetic)' }, currency: 'INR', status: 'OPEN', statementAddsUp: true, agrees: false, canReconcile: true, createdBy: 'Statement Owner' });
    expect(s.balances).toEqual({ theirOpening: '1000.00', ourOpening: '1000.00', theirClosing: '10480.00', ourClosing: '6260.00', difference: '4220.00' });
    expect(s.matches.map((m: { line: number; itemId: string; by: string; difference: string }) => [m.line, m.itemId, m.by, m.difference])).toEqual([
      [0, ids.b1, 'REFERENCE', '0.00'],
      [2, ids.b3, 'REFERENCE', '40.00'],
      [1, ids.b2, 'AMOUNT_AND_DATE', '0.00'],
      [3, ids.p1, 'AMOUNT_AND_DATE', '0.00'],
    ]);
    expect(s.onlyOnStatement).toMatchObject([{ reference: 'PM/26-27/121', effect: '1180.00', action: expect.stringMatching(/^Not in your books/) }]);
    expect(s.onlyInBooks).toMatchObject([{ id: ids.p2, kind: 'PAYMENT', effect: '-3000.00', action: expect.stringMatching(/payment still on its way/) }]);
    expect(s.explained).toEqual({ opening: '0.00', onlyOnStatement: '1180.00', onlyInBooks: '3000.00', amountDifferences: '40.00', statementArithmetic: '0.00' });
    expect(s.lines[4]).toMatchObject({ description: 'Toner' });

    const list = (await ctx.http().get(url()).set(viewer.auth).expect(200)).body;
    expect(list).toEqual([expect.objectContaining({ id: s.id, difference: '4220.00', statementAddsUp: true, agrees: false, lines: 5 })]);
  });

  it('checks the statement as entered', async () => {
    const bad = await ctx.http().post(url()).set(owner.auth).send(statement({ contactId: c.customer, to: day(2), lines: [LINES[0]] })).expect(422);
    expect(bad.body.details.issues).toEqual(['Only A Customer is not a vendor', 'A statement cannot end in the future']);
    const outside = await ctx.http().post(url()).set(owner.auth).send(statement({ lines: [{ ...LINES[0], date: day(-40) }] })).expect(422);
    expect(outside.body.details.issues).toEqual([`Line 1 (PM-26-27-0101) is dated ${day(-40)}, outside the statement's period`]);
    await ctx.http().post(url()).set(owner.auth).send(statement({ lines: [{ ...LINES[0], amount: '0.00' }] })).expect(400);
    await ctx.http().post(url()).set(owner.auth).send(statement({ lines: [{ ...LINES[0], kind: 'REFUND' }] })).expect(400);
  });

  it('will not reconcile a statement that does not add up, and needs a note while differences remain', async () => {
    const off = (await ctx.http().put(url(`/${ids.statement}`)).set(owner.auth).send(statement({ theirClosing: '10500.00' })).expect(200)).body;
    expect(off).toMatchObject({ statementAddsUp: false, canReconcile: false, explained: { statementArithmetic: '20.00' } });
    expect((await ctx.http().post(url(`/${ids.statement}/reconcile`)).set(owner.auth).send({}).expect(422)).body.error).toBe('STATEMENT_DOES_NOT_ADD_UP');
    await ctx.http().put(url(`/${ids.statement}`)).set(owner.auth).send(statement()).expect(200);
    expect((await ctx.http().post(url(`/${ids.statement}/reconcile`)).set(owner.auth).send({}).expect(422)).body.error).toBe('NOTE_REQUIRED');
    await ctx.http().post(url(`/${ids.statement}/reconcile`)).set(viewer.auth).send({ note: 'x' }).expect(403);
    const done = (await ctx.http().post(url(`/${ids.statement}/reconcile`)).set(owner.auth).send({ note: 'Asked Paper Mart for invoice 121 and a credit of 40.00; payment of 3,000 sent on its way.' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'RECONCILED', reconciledBy: 'Statement Owner', canReconcile: false, note: expect.stringMatching(/^Asked Paper Mart/) });
    expect((await ctx.http().put(url(`/${ids.statement}`)).set(owner.auth).send(statement()).expect(409)).body.error).toBe('STATEMENT_RECONCILED');
    await ctx.http().post(url(`/${ids.statement}/reconcile`)).set(owner.auth).send({ note: 'again' }).expect(409);
  });

  it('is audited and kept to its organisation', async () => {
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'supplier_statement' }).sort({ _id: 1 }).toArray();
    expect(events.map((e) => [e.action, e.data.difference, e.data.addsUp ?? null])).toEqual([
      ['supplier_statement.created', '4220.00', true],
      ['supplier_statement.updated', '4240.00', false],
      ['supplier_statement.updated', '4220.00', true],
      ['supplier_statement.reconciled', '4220.00', null],
    ]);
    await ctx.http().get(url('/00000000-0000-4000-8000-000000000000')).set(owner.auth).expect(404);
    const outsider = await registerUser(ctx, 'Statement Outsider');
    await ctx.http().get(url(`/${ids.statement}`)).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Other Reconciling Ltd' });
    await ctx.http().get(`${other.base}/purchases/supplier-statements/${ids.statement}`).set(owner.auth).expect(404);
    await ctx.http().post(`${other.base}/purchases/supplier-statements`).set(owner.auth).send(statement()).expect(404);
  });
});
