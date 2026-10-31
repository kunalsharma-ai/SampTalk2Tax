import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let vendor: { id: string };
let tax18: { id: string };

const cents = (s: string) => Math.round(Number(s) * 100);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  org = await createOrg(ctx, owner);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Bluebird Retail', isCustomer: true, paymentTermsDays: 15 }).expect(201)).body;
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Supplies', isVendor: true }).expect(201)).body;
  tax18 = (
    await ctx
      .http()
      .post(`${org.base}/tax-rates`)
      .set(owner.auth)
      .send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] })
      .expect(201)
  ).body;
});
afterAll(async () => {
  await ctx.app.close();
});

function invoice(extra: Record<string, unknown> = {}) {
  return {
    kind: 'INVOICE',
    contactId: customer.id,
    issueDate: today(),
    lines: [
      { accountId: org.acc['4100'], description: 'Widgets', quantity: '10', unitPrice: '1000.00', taxRateId: tax18.id },
      { accountId: org.acc['4200'], description: 'Installation', quantity: '1', unitPrice: '2500.00' },
    ],
    ...extra,
  };
}

async function tbBalance(code: string) {
  const t = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body;
  return t.rows.find((r: { code: string }) => r.code === code)?.balance ?? '0.00';
}

async function ageing(path: 'sales' | 'purchases', asOf = today()) {
  return (await ctx.http().get(`${org.base}/${path}/ageing?asOf=${asOf}`).set(owner.auth).expect(200)).body;
}

function receipt(amount: string, allocations: { documentId: string; amount: string }[] = [], headers: Record<string, string> = {}) {
  return ctx
    .http()
    .post(`${org.base}/sales/payments`)
    .set({ ...owner.auth, ...headers })
    .send({ contactId: customer.id, date: today(), bankAccountId: org.acc['1120'], amount, allocations });
}

describe('invoices', () => {
  let invId: string;

  it('computes totals on a draft and keeps it out of the ledger', async () => {
    const res = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice()).expect(201);
    expect(res.body).toMatchObject({ status: 'DRAFT', number: null, subtotal: '12500.00', taxTotal: '1800.00', total: '14300.00' });
    // Due date defaults from the customer's payment terms.
    expect(res.body.dueDate > res.body.issueDate).toBe(true);
    expect(await tbBalance('1200')).toBe('0.00');
    invId = res.body.id;
  });

  it('posts through the ledger: receivables debit, revenue and tax credits', async () => {
    const res = await ctx.http().post(`${org.base}/sales/documents/${invId}/post`).set(owner.auth).send({}).expect(200);
    expect(res.body).toMatchObject({ status: 'POSTED', number: 'INV-000001', amountDue: '14300.00', paymentStatus: 'UNPAID' });
    const je = (await ctx.http().get(`${org.base}/journals/${res.body.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ source: 'DOCUMENT', status: 'POSTED', totalDebit: '14300.00', reference: 'INV-000001' });
    expect(await tbBalance('1200')).toBe('14300.00');
    expect(await tbBalance('4100')).toBe('10000.00');
    expect(await tbBalance('2300')).toBe('1800.00');
    await ctx.http().post(`${org.base}/sales/documents/${invId}/post`).set(owner.auth).send({}).expect(409);
    await ctx.http().put(`${org.base}/sales/documents/${invId}`).set(owner.auth).send(invoice()).expect(409);
    await ctx.http().delete(`${org.base}/sales/documents/${invId}`).set(owner.auth).expect(409);
  });

  it('refuses invalid documents with every reason', async () => {
    const res = await ctx
      .http()
      .post(`${org.base}/sales/documents`)
      .set(owner.auth)
      .send(invoice({ lines: [{ accountId: org.acc['1200'], quantity: '1', unitPrice: '5' }, { accountId: org.acc['4000'], quantity: '1', unitPrice: '5' }] }))
      .expect(422);
    expect(res.body.details.issues.join('\n')).toMatch(/control account[\s\S]*header/);
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice({ contactId: vendor.id })).expect(422);
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice({ kind: 'BILL' })).expect(400);
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice({ lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '0' }] })).expect(422);
  });

  it('keeps receivables and payables out of manual journals, in the API and in the database', async () => {
    const res = await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({ date: today(), post: true, lines: [{ accountId: org.acc['1200'], debit: '5.00' }, { accountId: org.acc['4100'], credit: '5.00' }] })
      .expect(422);
    expect(res.body.error).toBe('CONTROL_ACCOUNT');
    const draft = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: today(), lines: [{ accountId: org.acc['1120'], debit: '5.00' }, { accountId: org.acc['4100'], credit: '5.00' }] }).expect(201);
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO journal_lines (id, org_id, entry_id, line_no, account_id, currency, exchange_rate, debit, credit, functional_debit, functional_credit)
         VALUES (gen_random_uuid(), '${org.orgId}', '${draft.body.id}', 3, '${org.acc['1200']}', 'INR', 1, 5, 0, 5, 0)`,
      ),
    ).rejects.toThrow(/control account/);
  });

  it('does not let the journals screen reverse an invoice journal', async () => {
    const inv = (await ctx.http().get(`${org.base}/sales/documents/${invId}`).set(owner.auth).expect(200)).body;
    const res = await ctx.http().post(`${org.base}/journals/${inv.journalEntryId}/reverse`).set(owner.auth).send({ date: today() }).expect(409);
    expect(res.body.error).toBe('SYSTEM_ENTRY');
  });

  it('blocks direct changes to posted documents at the database level', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE documents SET total = 1 WHERE id = '${invId}'`)).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE document_lines SET unit_price = 1 WHERE document_id = '${invId}'`)).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM documents WHERE id = '${invId}'`)).rejects.toThrow(/cannot be deleted/);
  });
});

describe('receipts, credits and ageing', () => {
  let inv: { id: string; total: string };

  beforeAll(async () => {
    inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice({ post: true, reference: 'PO-77' })).expect(201)).body;
  });

  it('records a partial receipt against an invoice', async () => {
    const res = await receipt('5000.00', [{ documentId: inv.id, amount: '5000.00' }]).expect(201);
    expect(res.body).toMatchObject({ number: expect.stringMatching(/^RCPT-/), amount: '5000.00', allocated: '5000.00', unallocated: '0.00' });
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body;
    expect(doc).toMatchObject({ amountDue: '9300.00', paymentStatus: 'PARTIAL' });
  });

  it('refuses to allocate more than is due or more than was paid', async () => {
    const over = await receipt('50000.00', [{ documentId: inv.id, amount: '9300.01' }]).expect(422);
    expect(over.body.message).toMatch(/still due/);
    const short = await receipt('10.00', [{ documentId: inv.id, amount: '20.00' }]).expect(422);
    expect(short.body.message).toMatch(/unallocated/);
  });

  it('keeps an unallocated receipt as a customer credit and allocates it later', async () => {
    const adv = (await receipt('1000.00').expect(201)).body;
    expect(adv.unallocated).toBe('1000.00');
    let a = await ageing('sales');
    let row = a.rows.find((r: { contactId: string }) => r.contactId === customer.id);
    expect(row.unapplied).toBe('1000.00');
    expect(a.reconciliation.difference).toBe('0.00');
    await ctx.http().post(`${org.base}/sales/payments/${adv.id}/allocate`).set(owner.auth).send({ allocations: [{ documentId: inv.id, amount: '1000.00' }] }).expect(200);
    a = await ageing('sales');
    row = a.rows.find((r: { contactId: string }) => r.contactId === customer.id);
    expect(row.unapplied).toBe('0.00');
    expect(a.reconciliation.difference).toBe('0.00');
  });

  it('applies a credit note and settles the invoice', async () => {
    const cn = (
      await ctx
        .http()
        .post(`${org.base}/sales/documents`)
        .set(owner.auth)
        .send({ kind: 'CREDIT_NOTE', contactId: customer.id, issueDate: today(), post: true, lines: [{ accountId: org.acc['4100'], description: 'Damaged units', quantity: '1', unitPrice: '1000.00', taxRateId: tax18.id }] })
        .expect(201)
    ).body;
    expect(cn).toMatchObject({ number: expect.stringMatching(/^CN-/), total: '1180.00' });
    const rest = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body.amountDue;
    expect(rest).toBe('8300.00');
    await ctx.http().post(`${org.base}/sales/documents/${inv.id}/apply-credit`).set(owner.auth).send({ creditDocumentId: cn.id, amount: '1180.00' }).expect(200);
    await receipt('7120.00', [{ documentId: inv.id, amount: '7120.00' }]).expect(201);
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body;
    expect(doc).toMatchObject({ amountDue: '0.00', paymentStatus: 'PAID' });
    expect(doc.allocations).toHaveLength(4);
    const paid = (await ctx.http().get(`${org.base}/sales/documents?view=paid`).set(owner.auth).expect(200)).body;
    expect(paid.items.map((d: { id: string }) => d.id)).toContain(inv.id);
  });

  it('ageing ties to the receivables control account, today and on earlier dates', async () => {
    const a = await ageing('sales');
    expect(a.reconciliation.controlAccountBalance).toBe(await tbBalance('1200'));
    expect(a.reconciliation.difference).toBe('0.00');
    expect(cents(a.totals.balance)).toBe(cents(a.totals.current) + cents(a.totals.days1to30) + cents(a.totals.days31to60) + cents(a.totals.days61to90) + cents(a.totals.over90) - cents(a.totals.unapplied));
    const before = await ageing('sales', '2000-01-01');
    expect(before.rows).toHaveLength(0);
    expect(before.reconciliation.difference).toBe('0.00');
  });

  it('produces a customer statement with a running balance that matches the ageing', async () => {
    const s = (await ctx.http().get(`${org.base}/contacts/${customer.id}/statement?ledger=SALES&from=2000-01-01`).set(owner.auth).expect(200)).body;
    expect(s.openingBalance).toBe('0.00');
    expect(s.lines.length).toBeGreaterThan(4);
    const a = await ageing('sales');
    expect(s.closingBalance).toBe(a.rows.find((r: { contactId: string }) => r.contactId === customer.id).balance);
    const c = (await ctx.http().get(`${org.base}/contacts/${customer.id}`).set(owner.auth).expect(200)).body;
    expect(c.receivable.balance).toBe(s.closingBalance);
  });

  it('voids only after allocations are removed, and posts an exact reversal', async () => {
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${inv.id}`).set(owner.auth).expect(200)).body;
    const blocked = await ctx.http().post(`${org.base}/sales/documents/${inv.id}/void`).set(owner.auth).send({ reason: 'Issued in error' }).expect(409);
    expect(blocked.body.error).toBe('HAS_ALLOCATIONS');
    for (const al of doc.allocations) await ctx.http().post(`${org.base}/sales/allocations/${al.id}/remove`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/sales/allocations/${doc.allocations[0].id}/remove`).set(owner.auth).expect(409);
    const before1200 = cents(await tbBalance('1200'));
    const voided = await ctx.http().post(`${org.base}/sales/documents/${inv.id}/void`).set(owner.auth).send({ reason: 'Issued in error' }).expect(200);
    expect(voided.body).toMatchObject({ status: 'VOID', voidReason: 'Issued in error' });
    expect(cents(await tbBalance('1200'))).toBe(before1200 - cents(inv.total));
    const rev = (await ctx.http().get(`${org.base}/journals/${voided.body.voidJournalEntryId}`).set(owner.auth).expect(200)).body;
    expect(rev).toMatchObject({ type: 'REVERSING', reversesEntryId: voided.body.journalEntryId, totalDebit: inv.total });
    // The receipts and credit note are now unapplied credits; the ageing still ties out.
    const a = await ageing('sales');
    expect(a.reconciliation.difference).toBe('0.00');
    expect(a.rows.find((r: { contactId: string }) => r.contactId === customer.id).unapplied).not.toBe('0.00');
  });

  it('rejects over-allocation inserted directly in SQL', async () => {
    const big = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice({ post: true })).expect(201)).body;
    const pay = (await receipt('100.00').expect(201)).body;
    await expect(
      ctx.prisma.$executeRawUnsafe(
        `INSERT INTO allocations (id, org_id, target_id, payment_id, amount, date, created_by_id) VALUES (gen_random_uuid(), '${org.orgId}', '${big.id}', '${pay.id}', 500, CURRENT_DATE, '${owner.id}')`,
      ),
    ).rejects.toThrow(/exceed the source amount/);
  });

  it('replays an idempotent receipt instead of recording it twice', async () => {
    const key = { 'Idempotency-Key': `rcpt-${Date.now()}` };
    const first = await receipt('42.00', [], key).expect(201);
    const again = await receipt('42.00', [], key).expect(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    await receipt('43.00', [], key).expect(422);
  });

  it('allocates exactly once under concurrent receipts', async () => {
    const target = (
      await ctx
        .http()
        .post(`${org.base}/sales/documents`)
        .set(owner.auth)
        .send({ kind: 'INVOICE', contactId: customer.id, issueDate: today(), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '500.00' }] })
        .expect(201)
    ).body;
    const results = await Promise.all(Array.from({ length: 10 }, () => receipt('100.00', [{ documentId: target.id, amount: '100.00' }])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const doc = (await ctx.http().get(`${org.base}/sales/documents/${target.id}`).set(owner.auth).expect(200)).body;
    expect(doc.amountDue).toBe('0.00');
    expect((await ageing('sales')).reconciliation.difference).toBe('0.00');
  });
});

describe('credit limits', () => {
  it('blocks an invoice over the limit unless the poster overrides it', async () => {
    const c = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Tight Credit Ltd', isCustomer: true, creditLimit: '1000.00' }).expect(201)).body;
    const body = { kind: 'INVOICE', contactId: c.id, issueDate: today(), lines: [{ accountId: org.acc['4100'], quantity: '2', unitPrice: '1000.00' }] };
    const res = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...body, post: true }).expect(409);
    expect(res.body.error).toBe('CREDIT_LIMIT_EXCEEDED');
    // The failed post rolled back entirely: no orphan draft.
    expect((await ctx.http().get(`${org.base}/sales/documents?contactId=${c.id}`).set(owner.auth).expect(200)).body.total).toBe(0);
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...body, post: true, overrideCreditLimit: true }).expect(201);
  });
});

describe('bills and payments', () => {
  it('posts a bill to payables with recoverable input tax and pays it', async () => {
    const bill = (
      await ctx
        .http()
        .post(`${org.base}/purchases/documents`)
        .set(owner.auth)
        .send({ kind: 'BILL', contactId: vendor.id, issueDate: today(), reference: 'GS/2026/104', post: true, lines: [{ accountId: org.acc['6400'], description: 'Annual licence', quantity: '1', unitPrice: '20000.00', taxRateId: tax18.id }] })
        .expect(201)
    ).body;
    expect(bill).toMatchObject({ number: 'BILL-000001', total: '23600.00' });
    expect(await tbBalance('2100')).toBe('23600.00');
    expect(await tbBalance('1450')).toBe('3600.00');
    const pay = await ctx
      .http()
      .post(`${org.base}/purchases/payments`)
      .set(owner.auth)
      .send({ contactId: vendor.id, date: today(), bankAccountId: org.acc['1120'], amount: '23600.00', allocations: [{ documentId: bill.id, amount: '23600.00' }] })
      .expect(201);
    expect(pay.body.number).toMatch(/^PAY-/);
    expect(await tbBalance('2100')).toBe('0.00');
    const a = await ageing('purchases');
    expect(a.reconciliation.difference).toBe('0.00');
  });

  it("detects a vendor's invoice number entered twice, ignoring case", async () => {
    const body = { kind: 'BILL', contactId: vendor.id, issueDate: today(), reference: 'gs/2026/104', lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '10.00' }] };
    const res = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(body).expect(409);
    expect(res.body.error).toBe('DUPLICATE_BILL');
  });

  it('payments must come from a bank or cash account', async () => {
    await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor.id, date: today(), bankAccountId: org.acc['6400'], amount: '1.00' }).expect(422);
  });
});

describe('roles and tenants', () => {
  it('lets an approver post a draft but not create one, and a viewer only read', async () => {
    const approver = await registerUser(ctx, 'Approver');
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    const draft = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(invoice()).expect(201)).body;
    await ctx.http().post(`${org.base}/sales/documents`).set(approver.auth).send(invoice()).expect(403);
    await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(viewer.auth).send({}).expect(403);
    await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(approver.auth).send({}).expect(200);
    await ctx.http().get(`${org.base}/sales/documents/${draft.id}`).set(viewer.auth).expect(200);
    await ctx.http().post(`${org.base}/contacts`).set(viewer.auth).send({ name: 'Nope', isCustomer: true }).expect(403);
  });

  it("never exposes or accepts another tenant's documents or contacts", async () => {
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    const mine = (await ctx.http().get(`${org.base}/sales/documents`).set(owner.auth).expect(200)).body.items[0];
    await ctx.http().get(`${org.base}/sales/documents/${mine.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${otherOrg.base}/sales/documents/${mine.id}`).set(other.auth).expect(404);
    await ctx.http().post(`${otherOrg.base}/sales/documents`).set(other.auth).send({ ...invoice(), lines: [{ accountId: otherOrg.acc['4100'], quantity: '1', unitPrice: '1' }] }).expect(422);
    // A bill in the purchases ledger is not reachable through the sales routes either.
    const bill = (await ctx.http().get(`${org.base}/purchases/documents`).set(owner.auth).expect(200)).body.items[0];
    await ctx.http().get(`${org.base}/sales/documents/${bill.id}`).set(owner.auth).expect(404);
  });
});
