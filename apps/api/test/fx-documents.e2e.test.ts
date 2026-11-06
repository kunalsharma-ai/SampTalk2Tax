import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Invoices, bills, credits and payments in a foreign currency, and realised exchange gains and losses, against the real API. */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let vendor: { id: string };
let usdBank: string;
const d0 = today();
const y = Number(d0.slice(0, 4));
const fyStart = d0.slice(5) >= '04-01' ? `${y}-04-01` : `${y - 1}-04-01`;
const day = (n: number) => { const d = new Date(`${fyStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const tb = async (asOf: string) => {
  const t = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${asOf}`).set(owner.auth).expect(200)).body;
  return (code: string) => t.rows.find((r: { code: string }) => r.code === code)?.balance ?? '0.00';
};
const ageing = async (path: 'sales' | 'purchases', asOf: string) => (await ctx.http().get(`${org.base}/${path}/ageing?asOf=${asOf}`).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'FX Docs Owner');
  org = await createOrg(ctx, owner);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Acme Inc (US)', isCustomer: true, paymentTermsDays: 30 }).expect(201)).body;
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Cloud Host LLC', isVendor: true }).expect(201)).body;
  usdBank = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'USD Bank', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '83' }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('foreign-currency invoices', () => {
  let inv: { id: string; number: string };

  it('take the recorded rate on the issue date, or the one entered, and post in their currency', async () => {
    const draft = (
      await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth)
        .send({ kind: 'INVOICE', contactId: customer.id, issueDate: day(2), currency: 'USD', lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '10', unitPrice: '100.25' }] })
        .expect(201)
    ).body;
    expect(draft).toMatchObject({ currency: 'USD', exchangeRate: '83', total: '1002.50', functionalTotal: '83207.50', functionalCurrency: 'INR' });
    const entered = (
      await ctx.http().put(`${org.base}/sales/documents/${draft.id}`).set(owner.auth)
        .send({ kind: 'INVOICE', contactId: customer.id, issueDate: day(2), currency: 'USD', exchangeRate: '83.5', lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '10', unitPrice: '100' }] })
        .expect(200)
    ).body;
    expect(entered).toMatchObject({ exchangeRate: '83.5', total: '1000.00', functionalTotal: '83500.00' });
    inv = (await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(owner.auth).send({}).expect(200)).body;
    const je = (await ctx.http().get(`${org.base}/journals/${(inv as unknown as { journalEntryId: string }).journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je.lines.map((l: { currency: string; exchangeRate: string; debit: string; credit: string }) => [l.currency, l.exchangeRate, l.debit, l.credit])).toEqual([
      ['USD', '83.5', '1000.00', '0.00'],
      ['USD', '83.5', '0.00', '1000.00'],
    ]);
    const bal = await tb(day(2));
    expect(bal('1200')).toBe('83500.00');
    expect(bal('4100')).toBe('83500.00');
  });

  it('refuse a currency without a rate, a bad rate, an unknown currency and a receipt in another currency', async () => {
    const base = { kind: 'INVOICE', contactId: customer.id, issueDate: day(2), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '10' }] };
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...base, currency: 'EUR' }).expect(422)).body).toMatchObject({ error: 'FX_RATE_MISSING' });
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...base, currency: 'USD', exchangeRate: '-2' }).expect(422)).body.error).toBe('FX_INVALID');
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...base, currency: 'INR', exchangeRate: '2' }).expect(422)).body.message).toMatch(/always 1/);
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...base, currency: 'XYZ' }).expect(422)).body.message).toMatch(/not a supported currency/);
    // Allocations need the same currency.
    const inr = (await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: day(3), bankAccountId: org.acc['1120'], amount: '100.00', allocations: [{ documentId: inv.id, amount: '100.00' }] }).expect(422)).body;
    expect(inr).toMatchObject({ error: 'CURRENCY_MISMATCH' });
  });

  it('realise a gain when paid at a higher rate, in part, and the ageing ties to the books', async () => {
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(20), rate: '84.25' }).expect(200);
    const r = (
      await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth)
        .send({ contactId: customer.id, date: day(20), bankAccountId: usdBank, amount: '600.00', currency: 'USD', allocations: [{ documentId: inv.id, amount: '400.00' }] })
        .expect(201)
    ).body;
    expect(r).toMatchObject({ currency: 'USD', exchangeRate: '84.25', amount: '600.00', functionalAmount: '50550.00', unallocated: '200.00', fxGain: '300.00' });
    expect(r.allocations[0]).toMatchObject({ amount: '400.00', fxGain: '300.00' });
    const bal = await tb(day(20));
    expect(bal('1130')).toBe('50550.00');
    expect(bal('7200')).toBe('-300.00');
    // Receivable: 1000 at 83.5 less 400 at 83.5 = 50,100, less 200 unapplied at 84.25 = 16,850 → 33,250.
    expect(bal('1200')).toBe('33250.00');
    const a = await ageing('sales', day(20));
    expect(a.reconciliation).toMatchObject({ controlAccountBalance: '33250.00', subledgerBalance: '33250.00', difference: '0.00' });
    const row = a.rows.find((x: { contactId: string }) => x.contactId === customer.id);
    expect(row.items.map((i: { type: string; currency: string; open: string; foreignOpen: string }) => [i.type, i.currency, i.open, i.foreignOpen])).toEqual([
      ['charge', 'USD', '50100.00', '600.00'],
      ['payment', 'USD', '16850.00', '200.00'],
    ]);
    // The rest at a lower rate is a loss; the invoice is then paid.
    const r2 = (await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: customer.id, date: day(21), bankAccountId: usdBank, amount: '400.00', currency: 'USD', exchangeRate: '82', allocations: [{ documentId: inv.id, amount: '400.00' }] }).expect(201)).body;
    expect(r2.fxGain).toBe('-600.00');
    await ctx.http().post(`${org.base}/sales/payments/${r.id}/allocate`).set(owner.auth).send({ allocations: [{ documentId: inv.id, amount: '200.00' }] }).expect(200);
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body;
    expect(doc).toMatchObject({ amountDue: '0.00', paymentStatus: 'PAID' });
    const b2 = await tb(day(21));
    // Gains 300 + 150 on the second allocation, loss 600: a net loss of 150. The receivable is cleared.
    expect(b2('7200')).toBe('150.00');
    expect(b2('1200')).toBe('0.00');
    expect((await ageing('sales', day(21))).reconciliation.difference).toBe('0.00');
    // Audit trail names the exchange journal.
    const ev = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'allocation.created' } });
    expect(ev.filter((e) => (e.data as { fxJournalEntryId?: string }).fxJournalEntryId)).toHaveLength(3);
  });

  it('reverse the exchange difference when an allocation is removed', async () => {
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body;
    const last = doc.allocations.find((a: { fxGain: string | null; amount: string }) => a.fxGain === '-600.00');
    const removed = (await ctx.http().post(`${org.base}/sales/allocations/${last.id}/remove`).set(owner.auth).expect(200)).body;
    const al = await ctx.prisma.allocation.findUniqueOrThrow({ where: { id: last.id } });
    expect(al.fxReversalJournalEntryId).toBeTruthy();
    const bal = await tb(removed.removedOn);
    expect(bal('7200')).toBe('-450.00');
    const a = await ageing('sales', removed.removedOn);
    expect(a.reconciliation.difference).toBe('0.00');
    await expect(ctx.prisma.allocation.update({ where: { id: last.id }, data: { fxGain: '1' } })).rejects.toThrow(/immutable/);
  });

  it('give a statement in each currency', async () => {
    const s = (await ctx.http().get(`${org.base}/contacts/${customer.id}/statement?ledger=SALES&from=${day(0)}&to=${day(30)}&currency=USD`).set(owner.auth).expect(200)).body;
    expect(s.currency).toBe('USD');
    expect(s.currencies).toEqual(['INR', 'USD']);
    expect(s.lines.map((l: { number: string; charge: string | null; credit: string | null }) => l.charge ?? `-${l.credit}`)).toEqual(['1000.00', '-600.00', '-400.00']);
    expect(s.closingBalance).toBe('0.00');
    const inr = (await ctx.http().get(`${org.base}/contacts/${customer.id}/statement?ledger=SALES&from=${day(0)}&to=${day(30)}`).set(owner.auth).expect(200)).body;
    expect(inr.lines).toEqual([]);
  });
});

describe('foreign-currency bills, vendor credits and payments', () => {
  it('realise a loss when a bill is paid at a higher rate, and a credit at another rate settles the rest', async () => {
    const bill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth)
      .send({ kind: 'BILL', contactId: vendor.id, issueDate: day(5), currency: 'USD', exchangeRate: '83', reference: 'CH-1', lines: [{ accountId: org.acc['6300'], quantity: '1', unitPrice: '500.00' }] }).expect(201)).body;
    const b = (await ctx.http().post(`${org.base}/purchases/documents/${bill.id}/post`).set(owner.auth).send({}).expect(200)).body;
    const p = (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth)
      .send({ contactId: vendor.id, date: day(25), bankAccountId: usdBank, amount: '300.00', currency: 'USD', exchangeRate: '84', allocations: [{ documentId: b.id, amount: '300.00' }] }).expect(201)).body;
    expect(p.fxGain).toBe('-300.00');
    const vcDraft = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth)
      .send({ kind: 'VENDOR_CREDIT', contactId: vendor.id, issueDate: day(26), currency: 'USD', exchangeRate: '82.5', lines: [{ accountId: org.acc['6300'], quantity: '1', unitPrice: '200.00' }] }).expect(201)).body;
    const vc = (await ctx.http().post(`${org.base}/purchases/documents/${vcDraft.id}/post`).set(owner.auth).send({}).expect(200)).body;
    const applied = (await ctx.http().post(`${org.base}/purchases/documents/${b.id}/apply-credit`).set(owner.auth).send({ creditDocumentId: vc.id, amount: '200.00' }).expect(200)).body;
    // The credit at 82.5 settles 200 carried at 83: a gain of 100.
    expect(applied.allocations.map((a: { fxGain: string | null }) => a.fxGain)).toEqual(['-300.00', '100.00']);
    expect(applied.paymentStatus).toBe('PAID');
    const a = await ageing('purchases', day(26));
    expect(a.reconciliation.difference).toBe('0.00');
    expect(a.reconciliation.subledgerBalance).toBe('0.00');
  });

  it('do not mix currencies, and keep rates on posted records', async () => {
    const inrBill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth)
      .send({ kind: 'BILL', contactId: vendor.id, issueDate: day(5), lines: [{ accountId: org.acc['6300'], quantity: '1', unitPrice: '50.00' }] }).expect(201)).body;
    const posted = (await ctx.http().post(`${org.base}/purchases/documents/${inrBill.id}/post`).set(owner.auth).send({}).expect(200)).body;
    expect(posted).toMatchObject({ currency: 'INR', exchangeRate: '1' });
    const usdPay = (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor.id, date: day(25), bankAccountId: usdBank, amount: '1.00', currency: 'USD', exchangeRate: '84' }).expect(201)).body;
    expect((await ctx.http().post(`${org.base}/purchases/payments/${usdPay.id}/allocate`).set(owner.auth).send({ allocations: [{ documentId: inrBill.id, amount: '1.00' }] }).expect(422)).body.error).toBe('CURRENCY_MISMATCH');
    await expect(ctx.prisma.payment.update({ where: { id: usdPay.id }, data: { exchangeRate: '90' } })).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.document.update({ where: { id: posted.id }, data: { exchangeRate: '2' } })).rejects.toThrow(/immutable/);
  });
});
