import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * AR-041: invoices raised by hand to customers with contracts, matched to the contract they
 * bill, against the real API and database. Billing a period twice is flagged; an invoice for
 * the next period can be counted as that period so the contract does not bill it again; a
 * match that is wrong is dismissed with a reason.
 */
const H = 3_600_000;
const T = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 10);
const firstOfMonth = (iso: string, add: number) => {
  const d = new Date(Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + add);
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let B: string;
const c: Record<string, string> = {};
const k: Record<string, { id: string; number: string; periods: { periodNo: number; invoice: { id: string } | null }[] }> = {};
const inv: Record<string, { id: string; number: string }> = {};

interface Match {
  invoice: { id: string; number: string; issueDate: string; subtotal: string };
  contract: { id: string; ref: string };
  customer: string;
  status: string;
  confidence: string;
  score: number;
  periodState: string;
  period: { no: number; start: string; end: string } | null;
  billedBy: { id: string; number: string | null } | null;
  differences: { description: string; difference: string }[];
  totalDifference: string | null;
  canLink: boolean;
  advice: string;
}
const matching = async (auth = owner.auth) => (await ctx.http().get(B).set(auth).expect(200)).body as { matches: Match[]; summary: Record<string, number>; contracts: number; dismissed: number; canManage: boolean };
const forInvoice = async (key: string) => (await matching()).matches.find((m) => m.invoice.id === inv[key].id);

const contract = async (key: string, who: string, body: Record<string, unknown>) => {
  const d = (await ctx.http().post(`${org.base}/sales/contracts`).set(owner.auth).send({ contactId: c[who], autoRenew: false, noticeDays: 30, endDate: null, ...body }).expect(201)).body;
  k[key] = (await ctx.http().post(`${org.base}/sales/contracts/${d.id}/activate`).set(owner.auth).expect(200)).body;
};
const invoice = async (key: string, who: string, issueDate: string, lines: { description: string; account: string; quantity: string; unitPrice: string }[]) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, 15), post: true, lines: lines.map((l) => ({ accountId: org.acc[l.account], description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })) }).expect(201)).body;
  inv[key] = { id: d.id, number: d.number };
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Matching Owner');
  accountant = await registerUser(ctx, 'Matching Accountant');
  viewer = await registerUser(ctx, 'Matching Viewer');
  org = await createOrg(ctx, owner, { name: 'Contract Matching Pvt Ltd' });
  B = `${org.base}/sales/contract-matching`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const name of ['Amber Logistics', 'Birch Clinics', 'Cobalt Labs']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('contract-to-invoice matching', () => {
  it('shows nothing before there are contracts', async () => {
    expect(await matching(viewer.auth)).toEqual({ matches: [], summary: { matches: 0, billedTwice: 0, toLink: 0, priceDifferences: 0 }, contracts: 0, dismissed: 0, canManage: false });
  });

  it('flags an invoice for a period the contract already billed', async () => {
    // Monthly in advance from two months ago: activation bills three periods.
    await contract('amber', 'Amber Logistics', { title: 'Fleet tracking', frequency: 'MONTHLY', timing: 'ADVANCE', startDate: firstOfMonth(T, -2), lines: [{ accountId: org.acc['4100'], description: 'Fleet tracking subscription', quantity: '10', unitPrice: '1200.00' }] });
    const first = k.amber.periods.find((p) => p.periodNo === 1)!.invoice!.id;
    const posted = await ctx.http().post(`${org.base}/sales/documents/${first}/post`).set(owner.auth).send({});
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const firstNumber = (await ctx.http().get(`${org.base}/sales/documents/${first}`).set(owner.auth).expect(200)).body.number;
    await invoice('amberTwice', 'Amber Logistics', addDays(firstOfMonth(T, -2), 4), [{ description: 'Fleet tracking subscription', account: '4100', quantity: '10', unitPrice: '1200.00' }]);

    const m = (await forInvoice('amberTwice'))!;
    expect(m).toMatchObject({ customer: 'Amber Logistics', status: 'POSTED', confidence: 'HIGH', score: 100, periodState: 'ALREADY_BILLED', billedBy: { id: first, number: firstNumber }, canLink: false, totalDifference: '0.00', differences: [] });
    expect(m.contract.id).toBe(k.amber.id);
    expect(m.advice).toContain(`already billed period 1 on ${firstNumber}: the customer may be billed twice`);
    // Invoices the contract made itself are not matched again.
    const ids = (await matching()).matches.map((x) => x.invoice.id);
    for (const p of k.amber.periods) expect(ids).not.toContain(p.invoice!.id);
  });

  it('counts an invoice for the next period as that period, so the contract does not bill it again', async () => {
    // Quarterly in arrears from the first of this month: the first period is billed at its end.
    await contract('birch', 'Birch Clinics', {
      title: 'Clinic software',
      frequency: 'QUARTERLY',
      timing: 'ARREARS',
      startDate: firstOfMonth(T, 0),
      lines: [
        { accountId: org.acc['4100'], description: 'Clinic software licences', quantity: '5', unitPrice: '3000.00' },
        { accountId: org.acc['4100'], description: 'Priority support', quantity: '1', unitPrice: '5000.00' },
      ],
    });
    expect(k.birch.periods).toEqual([]);
    await invoice('birchEarly', 'Birch Clinics', T, [
      { description: 'Licences for clinic software', account: '4100', quantity: '5', unitPrice: '3000.00' },
      { description: 'Support (priority)', account: '4100', quantity: '1', unitPrice: '5000.00' },
    ]);
    const m = (await forInvoice('birchEarly'))!;
    expect(m).toMatchObject({ periodState: 'NEXT', canLink: true, confidence: 'HIGH', period: { no: 1, start: firstOfMonth(T, 0), end: addDays(firstOfMonth(T, 3), -1) } });
    expect((await matching()).summary).toMatchObject({ billedTwice: 1, toLink: 1 });

    // Who may link, and what is refused.
    await ctx.http().post(`${B}/link`).set(viewer.auth).send({ documentId: inv.birchEarly.id, contractId: k.birch.id }).expect(403);
    await ctx.http().post(`${B}/link`).set(owner.auth).send({ documentId: inv.birchEarly.id }).expect(400);
    expect((await ctx.http().post(`${B}/link`).set(owner.auth).send({ documentId: inv.amberTwice.id, contractId: k.amber.id }).expect(409)).body.error).toBe('NOT_NEXT_PERIOD');
    expect((await ctx.http().post(`${B}/link`).set(owner.auth).send({ documentId: inv.amberTwice.id, contractId: k.birch.id }).expect(422)).body.error).toBe('NO_MATCH');

    const after = (await ctx.http().post(`${B}/link`).set(accountant.auth).send({ documentId: inv.birchEarly.id, contractId: k.birch.id }).expect(200)).body;
    expect(after.matches.map((x: Match) => x.invoice.id)).not.toContain(inv.birchEarly.id);
    expect((await ctx.http().post(`${B}/link`).set(owner.auth).send({ documentId: inv.birchEarly.id, contractId: k.birch.id }).expect(409)).body.error).toBe('ALREADY_LINKED');

    const detail = (await ctx.http().get(`${org.base}/sales/contracts/${k.birch.id}`).set(owner.auth).expect(200)).body;
    expect(detail.periods).toEqual([expect.objectContaining({ periodNo: 1, status: 'BILLED' })]);
    expect(detail.events[0]).toMatchObject({ kind: 'INVOICE_LINKED', body: `${inv.birchEarly.number} counted as period ${firstOfMonth(T, 0)} to ${addDays(firstOfMonth(T, 3), -1)}` });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'sales_contract.invoice_linked' } });
    expect(audit?.data).toMatchObject({ periodNo: 1, documentId: inv.birchEarly.id, score: 100, totalDifference: '0.00' });

    // At the quarter's end the contract bills nothing for the period the invoice already billed.
    const run = (await ctx.http().post(`${org.base}/sales/contracts/${k.birch.id}/bill-due`).set(owner.auth).expect(200)).body;
    expect(run.billed).toBe(0);
  });

  it('shows prices that differ from the contract, line by line', async () => {
    await invoice('birchCheap', 'Birch Clinics', T, [
      { description: 'Clinic software licences', account: '4100', quantity: '5', unitPrice: '2500.00' },
      { description: 'Priority support', account: '4100', quantity: '1', unitPrice: '5000.00' },
    ]);
    const m = (await forInvoice('birchCheap'))!;
    expect(m).toMatchObject({ periodState: 'ALREADY_BILLED', billedBy: { id: inv.birchEarly.id, number: inv.birchEarly.number }, totalDifference: '-2500.00' });
    expect(m.differences).toEqual([expect.objectContaining({ description: 'Clinic software licences', difference: '-2500.00' })]);
  });

  it('leaves out invoices that are not like any contract', async () => {
    await invoice('cobalt', 'Cobalt Labs', T, [{ description: 'Consulting', account: '4100', quantity: '1', unitPrice: '9000.00' }]);
    await invoice('amberOther', 'Amber Logistics', T, [{ description: 'Installation visit', account: '4200', quantity: '1', unitPrice: '2000.00' }]);
    const ids = (await matching()).matches.map((m) => m.invoice.id);
    expect(ids).not.toContain(inv.cobalt.id);
    expect(ids).not.toContain(inv.amberOther.id);
  });

  it('dismisses a wrong match with a reason, once', async () => {
    await ctx.http().post(`${B}/dismiss`).set(owner.auth).send({ documentId: inv.amberTwice.id, contractId: k.amber.id, reason: 'x' }).expect(400);
    await ctx.http().post(`${B}/dismiss`).set(viewer.auth).send({ documentId: inv.amberTwice.id, contractId: k.amber.id, reason: 'Extra trucks this month' }).expect(403);
    const o = (await ctx.http().post(`${B}/dismiss`).set(owner.auth).send({ documentId: inv.amberTwice.id, contractId: k.amber.id, reason: 'Extra trucks this month, agreed by email' }).expect(200)).body;
    expect(o.matches.map((m: Match) => m.invoice.id)).not.toContain(inv.amberTwice.id);
    expect(o.dismissed).toBe(1);
    expect((await ctx.http().post(`${B}/dismiss`).set(owner.auth).send({ documentId: inv.amberTwice.id, contractId: k.amber.id, reason: 'Again' }).expect(409)).body.error).toBe('ALREADY_DISMISSED');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'contract_match.dismissed' } });
    expect(audit?.data).toMatchObject({ documentId: inv.amberTwice.id, reason: 'Extra trucks this month, agreed by email' });
  });

  it('keeps each organisation to its own contracts and invoices', async () => {
    const other = await createOrg(ctx, owner, { name: 'Other Matching Ltd' });
    expect((await ctx.http().get(`${other.base}/sales/contract-matching`).set(owner.auth).expect(200)).body.contracts).toBe(0);
    await ctx.http().post(`${other.base}/sales/contract-matching/link`).set(owner.auth).send({ documentId: inv.birchCheap.id, contractId: k.birch.id }).expect(404);
    await ctx.http().get(B).set(registerUserLater.auth).expect(404);
  });
});
let registerUserLater: TestUser;
beforeAll(async () => {
  registerUserLater = await registerUser(ctx, 'Matching Outsider');
});
