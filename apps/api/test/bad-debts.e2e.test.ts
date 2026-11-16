import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * AR-026 / AR-027 against the real API and database: setting up the accounts; the provision
 * matrix from the ageing with a specific provision; posting only the difference from the
 * allowance in the books (up, nothing, then a release); writing off an invoice against the
 * allowance and part of a foreign-currency one against the expense, at the invoice's rate; the
 * write-off settling the invoice in the ageing, the statement and the control account; reversing
 * it; refusals, permissions, tenant isolation and the database guards.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
const d0 = today();
const y = Number(d0.slice(0, 4));
const fyStart = d0.slice(5) >= '04-01' ? `${y}-04-01` : `${y - 1}-04-01`;
const day = (n: number) => { const d = new Date(`${fyStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const raw = (sql: string) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql);
  });
const invoice = async (date: string, price: string, extra: Record<string, unknown> = {}) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer.id, issueDate: date, lines: [{ accountId: org.acc['4100'], description: 'Goods', quantity: '1', unitPrice: price }], ...extra }).expect(201)).body;
  return (await ctx.http().post(`${org.base}/sales/documents/${d.id}/post`).set(owner.auth).send({}).expect(200)).body as { id: string; number: string };
};
const overview = async (asOf: string) => (await ctx.http().get(`${org.base}/bad-debts?asOf=${asOf}`).set(owner.auth).expect(200)).body;
const journal = async (id: string) => (await ctx.http().get(`${org.base}/journals/${id}`).set(owner.auth).expect(200)).body;
const lines = (je: { lines: { accountCode: string; currency: string; debit: string; credit: string }[] }) => je.lines.map((l) => [l.accountCode, l.currency, l.debit, l.credit]);

let a: { id: string; number: string };
let b: { id: string; number: string };
let c: { id: string; number: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Bad Debt Owner');
  viewer = await registerUser(ctx, 'Bad Debt Viewer');
  outsider = await registerUser(ctx, 'Bad Debt Outsider');
  org = await createOrg(ctx, owner, { name: 'Bad Debt Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Bad Debts' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Slow Payer Pvt Ltd', isCustomer: true, paymentTermsDays: 30 }).expect(201)).body;
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '83' }).expect(200);
  a = await invoice(day(1), '118000');
  b = await invoice(day(100), '50000');
  c = await invoice(day(2), '1000', { currency: 'USD' });
});
afterAll(async () => {
  await ctx.app.close();
});

describe('setting up', () => {
  it('needs the accounts before posting, and makes them on request', async () => {
    expect((await ctx.http().post(`${org.base}/bad-debts/provisions`).set(owner.auth).send({ asOf: day(150) }).expect(409)).body.error).toBe('BAD_DEBT_SETUP');
    const o0 = await overview(day(150));
    expect(o0.settings).toBeNull();
    expect(o0.defaultRates).toMatchObject({ current: '1', over90: '50' });
    await ctx.http().post(`${org.base}/bad-debts/settings/default-accounts`).set(viewer.auth).expect(403);
    const o = (await ctx.http().post(`${org.base}/bad-debts/settings/default-accounts`).set(owner.auth).expect(200)).body;
    expect(o.settings).toMatchObject({ expenseAccount: { code: '6950', name: 'Bad Debts' }, allowanceAccount: { code: '1210', name: 'Allowance for Doubtful Debts' } });
    // Asking again reuses the same accounts.
    const again = (await ctx.http().post(`${org.base}/bad-debts/settings/default-accounts`).set(owner.auth).expect(200)).body;
    expect(again.settings.allowanceAccount.code).toBe('1210');
    const bad = await ctx.http().put(`${org.base}/bad-debts/settings`).set(owner.auth).send({ expenseAccountId: org.acc['6950'] ?? o.settings.expenseAccount.id, allowanceAccountId: org.acc['1200'], rates: o.settings.rates }).expect(422);
    expect(bad.body.message).toMatch(/control account/);
    expect((await ctx.http().put(`${org.base}/bad-debts/settings`).set(owner.auth).send({ expenseAccountId: org.acc['4100'], allowanceAccountId: o.settings.allowanceAccount.id, rates: o.settings.rates }).expect(422)).body.message).toMatch(/not an expense account/);
    expect((await ctx.http().put(`${org.base}/bad-debts/settings`).set(owner.auth).send({ expenseAccountId: o.settings.expenseAccount.id, allowanceAccountId: o.settings.allowanceAccount.id, rates: { ...o.settings.rates, over90: '150' } }).expect(422)).body.error).toBe('BAD_DEBT_RATES');
  });
});

describe('provisions', () => {
  it('work out the allowance from the ageing, with a specific provision', async () => {
    const o = await overview(day(150));
    expect(o.preview.buckets.find((x: { bucket: string }) => x.bucket === 'over90')).toMatchObject({ open: '201000.00', rate: '50', provision: '100500.00', invoices: 2 });
    expect(o.preview.buckets.find((x: { bucket: string }) => x.bucket === 'days1to30')).toMatchObject({ open: '50000.00', provision: '1500.00' });
    expect(o.preview).toMatchObject({ total: '102000.00', carried: '0.00', adjustment: '102000.00' });
    expect(o.invoices.find((i: { id: string }) => i.id === c.id)).toMatchObject({ currency: 'USD', foreignOpen: '1000.00', open: '83000.00', bucket: 'over90' });

    await ctx.http().put(`${org.base}/bad-debts/doubtful/${a.id}`).set(viewer.auth).send({ percent: '100', reason: 'In liquidation' }).expect(403);
    await ctx.http().put(`${org.base}/bad-debts/doubtful/${a.id}`).set(owner.auth).send({ percent: '100', reason: 'Customer filed for insolvency' }).expect(200);
    const o2 = await overview(day(150));
    expect(o2.preview.specific).toEqual({ open: '118000.00', provision: '118000.00', invoices: 1 });
    expect(o2.preview.total).toBe('161000.00');
    expect(o2.invoices.find((i: { id: string }) => i.id === a.id)).toMatchObject({ doubtful: { percent: '100', reason: 'Customer filed for insolvency' }, provision: '118000.00' });
  });

  it('post only the difference from the allowance in the books', async () => {
    await ctx.http().post(`${org.base}/bad-debts/provisions`).set(viewer.auth).send({ asOf: day(150) }).expect(403);
    const p = (await ctx.http().post(`${org.base}/bad-debts/provisions`).set(owner.auth).send({ asOf: day(150), memo: 'Quarter-end review' }).expect(201)).body;
    expect(p).toMatchObject({ reference: 'PV-0001', required: '161000.00', carried: '0.00', adjustment: '161000.00' });
    const je = await journal(p.journalEntryId);
    expect(je).toMatchObject({ source: 'BAD_DEBT', status: 'POSTED', reference: 'PV-0001' });
    expect(lines(je)).toEqual([['6950', 'INR', '161000.00', '0.00'], ['1210', 'INR', '0.00', '161000.00']]);
    // Nothing has changed: nothing is posted.
    const same = (await ctx.http().post(`${org.base}/bad-debts/provisions`).set(owner.auth).send({ asOf: day(150) }).expect(201)).body;
    expect(same).toMatchObject({ reference: 'PV-0002', adjustment: '0.00', journalEntryId: null });
    expect((await overview(day(150))).preview).toMatchObject({ carried: '161000.00', adjustment: '0.00' });
  });
});

describe('write-offs', () => {
  let woC: string;
  it('settle an invoice against the allowance, so it leaves the ageing and the statement', async () => {
    expect((await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(owner.auth).send({ documentId: a.id, date: day(0), amount: '118000', against: 'ALLOWANCE', reason: 'x' }).expect(422)).body.error).toBe('INVALID_DATE');
    expect((await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(owner.auth).send({ documentId: a.id, date: day(151), amount: '118000.01', against: 'ALLOWANCE', reason: 'x' }).expect(422)).body.error).toBe('WRITE_OFF_INVALID');
    await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(viewer.auth).send({ documentId: a.id, date: day(151), amount: '118000', against: 'ALLOWANCE', reason: 'x' }).expect(403);
    const w = (await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(owner.auth).send({ documentId: a.id, date: day(151), amount: '118000', against: 'ALLOWANCE', reason: 'Liquidator confirmed nothing will be paid' }).expect(201)).body;
    expect(w).toMatchObject({ reference: 'WO-0001', status: 'ACTIVE', amount: '118000.00', functionalAmount: '118000.00', account: { code: '1210' }, invoice: { number: a.number } });
    expect(lines(await journal(w.journalEntryId))).toEqual([['1210', 'INR', '118000.00', '0.00'], ['1200', 'INR', '0.00', '118000.00']]);

    const doc = (await ctx.http().get(`${org.base}/sales/documents/${a.id}`).set(owner.auth).expect(200)).body;
    expect(doc.amountDue).toBe('0.00');
    const al = doc.allocations[0];
    expect(al.source).toMatchObject({ type: 'write_off', number: 'WO-0001', kind: 'WRITE_OFF' });
    // Removed only by reversing the write-off; and the invoice cannot be voided while written off.
    expect((await ctx.http().post(`${org.base}/sales/allocations/${al.id}/remove`).set(owner.auth).send({}).expect(409)).body.error).toBe('WRITE_OFF_ALLOCATION');
    expect((await ctx.http().post(`${org.base}/sales/documents/${a.id}/void`).set(owner.auth).send({ date: day(152), reason: 'Entered twice' }).expect(409)).body.error).toBe('HAS_ALLOCATIONS');

    const ageing = (await ctx.http().get(`${org.base}/sales/ageing?asOf=${day(151)}`).set(owner.auth).expect(200)).body;
    expect(ageing.rows[0].items.map((i: { id: string }) => i.id)).not.toContain(a.id);
    expect(ageing.reconciliation.difference).toBe('0.00');
    const st = (await ctx.http().get(`/v1/orgs/${org.orgId}/contacts/${customer.id}/statement?ledger=SALES&from=${day(0)}&to=${day(160)}`).set(owner.auth).expect(200)).body;
    expect(st.lines.find((l: { kind: string }) => l.kind === 'WRITE_OFF')).toMatchObject({ number: 'WO-0001', credit: '118000.00' });
    expect(st.closingBalance).toBe('50000.00');
  });

  it('write off part of a foreign-currency invoice at its own rate, and reverse it', async () => {
    const w = (await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(owner.auth).send({ documentId: c.id, date: day(151), amount: '400', against: 'EXPENSE', reason: 'Disputed and settled for less' }).expect(201)).body;
    woC = w.id;
    expect(w).toMatchObject({ reference: 'WO-0002', currency: 'USD', amount: '400.00', functionalAmount: '33200.00', account: { code: '6950' } });
    expect(lines(await journal(w.journalEntryId))).toEqual([['6950', 'USD', '400.00', '0.00'], ['1200', 'USD', '0.00', '400.00']]);
    expect((await ctx.http().get(`${org.base}/sales/documents/${c.id}`).set(owner.auth).expect(200)).body.amountDue).toBe('600.00');

    // The next provision releases what is no longer needed.
    const p = (await ctx.http().post(`${org.base}/bad-debts/provisions`).set(owner.auth).send({ asOf: day(152) }).expect(201)).body;
    // Required: C 600 USD at 83 = 49,800 at 50% = 24,900; B 50,000 at 3% = 1,500. Carried: 161,000 - 118,000.
    expect(p).toMatchObject({ required: '26400.00', carried: '43000.00', adjustment: '-16600.00' });
    expect(lines(await journal(p.journalEntryId))).toEqual([['1210', 'INR', '16600.00', '0.00'], ['6950', 'INR', '0.00', '16600.00']]);

    expect((await ctx.http().post(`${org.base}/bad-debts/write-offs/${woC}/reverse`).set(owner.auth).send({ date: day(150), reason: 'x' }).expect(422)).body.error).toBe('INVALID_DATE');
    const r = (await ctx.http().post(`${org.base}/bad-debts/write-offs/${woC}/reverse`).set(owner.auth).send({ date: day(153), reason: 'Customer paid after all' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'REVERSED', reversedOn: day(153), reversalReason: 'Customer paid after all' });
    expect(lines(await journal(r.reversalJournalEntryId))).toEqual([['6950', 'USD', '0.00', '400.00'], ['1200', 'USD', '400.00', '0.00']]);
    expect((await ctx.http().get(`${org.base}/sales/documents/${c.id}`).set(owner.auth).expect(200)).body.amountDue).toBe('1000.00');
    expect((await ctx.http().post(`${org.base}/bad-debts/write-offs/${woC}/reverse`).set(owner.auth).send({ date: day(153), reason: 'again' }).expect(409)).body.error).toBe('WRITE_OFF_REVERSED');
    // The allowance (26,400 now) cannot absorb more than it holds.
    expect((await ctx.http().post(`${org.base}/bad-debts/write-offs`).set(owner.auth).send({ documentId: b.id, date: day(153), amount: '50000', against: 'ALLOWANCE', reason: 'Customer closed' }).expect(409)).body.error).toBe('ALLOWANCE_SHORT');
    const o = await overview(day(153));
    expect(o.writeOffs.map((x: { reference: string; status: string }) => [x.reference, x.status])).toEqual([['WO-0002', 'REVERSED'], ['WO-0001', 'ACTIVE']]);
    expect(o.provisions.map((x: { reference: string }) => x.reference)).toEqual(['PV-0003', 'PV-0002', 'PV-0001']);
  });

  it('keep their records as they are in the database', async () => {
    await expect(raw(`UPDATE bad_debt_write_offs SET amount = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/immutable|reversed once/);
    await expect(raw(`DELETE FROM bad_debt_write_offs WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`DELETE FROM bad_debt_provisions WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`UPDATE bad_debt_provisions SET adjustment = 0 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/append-only/);
  });

  it('keep each organisation to its own', async () => {
    await ctx.http().get(`${org.base}/bad-debts`).set(outsider.auth).expect(404);
    const o = (await ctx.http().get(`${other.base}/bad-debts`).set(outsider.auth).expect(200)).body;
    expect(o.writeOffs).toEqual([]);
    expect(o.invoices).toEqual([]);
    await ctx.http().put(`${other.base}/bad-debts/doubtful/${b.id}`).set(outsider.auth).send({ percent: '10', reason: 'x' }).expect(404);
  });
});
