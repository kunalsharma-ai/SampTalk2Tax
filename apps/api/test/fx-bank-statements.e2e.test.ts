import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Bank accounts kept in another currency (BANK-012): a USD account's statements are imported,
 * matched, turned into entries and receipts, and reconciled in USD, while the books carry it in
 * INR and a revaluation restates it.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let usd: string;
let customer: string;
let invoice: string;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - (10 - n) * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
const csv = () => ['Date,Details,Ref,Amount (USD)', `${dmy(day(0))},OPENING DEPOSIT,,5000.00`, `${dmy(day(3))},WIRE ACME INC,W-77,1000.00`, `${dmy(day(4))},WIRE FEE,,-25.00`].join('\n');

type Line = { id: string; description: string; amount: string; currency: string; status: string; matches: { amount: string; payment: { number: string } | null }[]; suggestion: { amount: string; unique: boolean } | null };
const lines = async () => (await ctx.http().get(`${org.base}/banking/accounts/${usd}/lines`).set(owner.auth).expect(200)).body.lines as Line[];
const lineBy = async (text: string) => (await lines()).find((l) => l.description.includes(text))!;
const accountRow = async () => (await ctx.http().get(`${org.base}/banking/accounts`).set(owner.auth).expect(200)).body.find((a: { id: string }) => a.id === usd);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'USD Owner');
  viewer = await registerUser(ctx, 'USD Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '83' }).expect(200);
  await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(3), rate: '84' }).expect(200);
  usd = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'USD Account', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Acme Inc', isCustomer: true }).expect(201)).body.id;
  invoice = (
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth)
      .send({ kind: 'INVOICE', contactId: customer, issueDate: day(1), currency: 'USD', post: true, lines: [{ accountId: org.acc['4100'], description: 'Consulting', quantity: '1', unitPrice: '1000' }] })
      .expect(201)
  ).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the account currency', () => {
  it('is set by those who manage accounts, on bank accounts only', async () => {
    await ctx.http().put(`${org.base}/banking/accounts/${usd}/currency`).set(viewer.auth).send({ currency: 'USD' }).expect(403);
    expect((await ctx.http().put(`${org.base}/banking/accounts/${usd}/currency`).set(owner.auth).send({ currency: 'XYZ' }).expect(422)).body.error).toBe('FX_INVALID');
    expect((await ctx.http().put(`${org.base}/banking/accounts/${org.acc['6200']}/currency`).set(owner.auth).send({ currency: 'USD' }).expect(422)).body.error).toBe('INVALID_BANK_ACCOUNT');
    expect((await ctx.http().put(`${org.base}/banking/accounts/${usd}/currency`).set(owner.auth).send({ currency: 'usd' }).expect(200)).body).toEqual({ accountId: usd, currency: 'USD' });
    expect((await ctx.http().get(`${org.base}/accounts/${usd}`).set(owner.auth).expect(200)).body.currency).toBe('USD');
    const ev = await ctx.prisma.auditEvent.findFirst({ where: { action: 'bank.account_currency_set', entityId: usd } });
    expect(ev?.data).toEqual({ from: 'INR', to: 'USD' });
  });

  it('takes postings only in its currency', async () => {
    const inr = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: day(0), memo: 'Wrong currency', post: true, lines: [{ accountId: usd, debit: '415000.00' }, { accountId: org.acc['3100'], credit: '415000.00' }] }).expect(422);
    expect(inr.body.error).toBe('ACCOUNT_CURRENCY');
    await ctx.http()
      .post(`${org.base}/journals`).set(owner.auth)
      .send({ date: day(0), memo: 'Opening deposit', post: true, lines: [{ accountId: usd, currency: 'USD', debit: '5000.00' }, { accountId: org.acc['3100'], currency: 'USD', credit: '5000.00' }] })
      .expect(201);
  });
});

describe('statements in USD', () => {
  it('imports the statement in the account currency', async () => {
    const preview = (await ctx.http().post(`${org.base}/banking/accounts/${usd}/imports`).set(owner.auth).send({ fileName: 'usd.csv', csv: csv(), mapping, dryRun: true }).expect(201)).body;
    expect(preview).toMatchObject({ currency: 'USD', newCount: 3, moneyIn: '6000.00', moneyOut: '25.00' });
    await ctx.http().post(`${org.base}/banking/accounts/${usd}/imports`).set(owner.auth).send({ fileName: 'usd.csv', csv: csv(), mapping, dryRun: false }).expect(201);
    const l = await lineBy('OPENING');
    expect(l).toMatchObject({ amount: '5000.00', currency: 'USD' });
    // Suggested in USD, the amount the bank shows, not the INR the books carry.
    expect(l.suggestion).toMatchObject({ amount: '5000.00', unique: true });
  });

  it('matches, posts entries and records receipts in USD', async () => {
    const am = await ctx.http().post(`${org.base}/banking/accounts/${usd}/auto-match`).set(owner.auth).expect(200);
    expect(am.body).toEqual({ matched: 1 });
    const wire = await lineBy('WIRE ACME');
    const paid = (await ctx.http().post(`${org.base}/banking/lines/${wire.id}/record-payment`).set(owner.auth).send({ contactId: customer, allocations: [{ documentId: invoice, amount: '1000.00' }] }).expect(200)).body;
    expect(paid.status).toBe('MATCHED');
    expect(paid.matches[0]).toMatchObject({ amount: '1000.00' });
    const payment = await ctx.prisma.payment.findFirst({ where: { orgId: org.orgId, number: paid.matches[0].payment.number } });
    expect([payment?.currency, payment?.exchangeRate.toFixed()]).toEqual(['USD', '84']);

    const fee = await lineBy('WIRE FEE');
    const entry = (await ctx.http().post(`${org.base}/banking/lines/${fee.id}/create-entry`).set(owner.auth).send({ accountId: org.acc['6200'] }).expect(200)).body;
    expect(entry.matches[0]).toMatchObject({ amount: '-25.00' });
    const jl = await ctx.prisma.journalLine.findFirst({ where: { entryId: entry.matches[0].entryId, accountId: usd } });
    expect([jl?.currency, jl?.credit.toFixed(2), jl?.functionalCredit.toFixed(2)]).toEqual(['USD', '25.00', '2100.00']);
  });

  it('reconciles in USD while the books carry INR', async () => {
    const f = (await ctx.http().post(`${org.base}/banking/accounts/${usd}/reconciliations/preview`).set(owner.auth).send({ statementDate: day(4), statementBalance: '5975.00', openingBalance: '0.00' }).expect(200)).body;
    expect(f).toMatchObject({ currency: 'USD', ledgerBalance: '5975.00', uncleared: '0.00', difference: '0.00', canComplete: true });
    await ctx.http().post(`${org.base}/banking/accounts/${usd}/reconciliations`).set(owner.auth).send({ statementDate: day(4), statementBalance: '5975.00', openingBalance: '0.00' }).expect(201);
    // 5000 at 83, 1000 at 84, less 25 at 84.
    expect(await accountRow()).toMatchObject({ currency: 'USD', ledgerBalance: '5975.00', functionalBalance: '496900.00', lastReconciled: { statementBalance: '5975.00' } });
  });

  it('is restated by a revaluation without moving the USD balance', async () => {
    await ctx.http().post(`${org.base}/fx/revaluations`).set(owner.auth).send({ date: day(5), rates: { USD: '85' } }).expect(201);
    const row = await accountRow();
    // The revaluation's next-day reversal is dated day(6), so the books still show 5,975 at 85 today.
    expect(row.ledgerBalance).toBe('5975.00');
    expect((await ctx.http().post(`${org.base}/banking/accounts/${usd}/reconciliations/preview`).set(owner.auth).send({ statementDate: day(5), statementBalance: '5975.00' }).expect(200)).body).toMatchObject({ ledgerBalance: '5975.00', difference: '0.00' });
  });

  it('keeps its currency once it is in use, and transfers stay within one currency', async () => {
    const r = (await ctx.http().put(`${org.base}/banking/accounts/${usd}/currency`).set(owner.auth).send({ currency: null }).expect(409)).body;
    expect(r.error).toBe('CURRENCY_IN_USE');
    expect(r.details.issues).toEqual(['It has imported statement lines', 'It has postings in USD']);
    // An INR line of the same amount on the INR account is not suggested as a transfer from USD.
    await ctx.http()
      .post(`${org.base}/banking/accounts/${org.acc['1120']}/imports`).set(owner.auth)
      .send({ fileName: 'inr.csv', csv: ['Date,Details,Ref,Amount', `${dmy(day(5))},FROM USD ACCOUNT,,500.00`].join('\n'), mapping, dryRun: false })
      .expect(201);
    await ctx.http()
      .post(`${org.base}/banking/accounts/${usd}/imports`).set(owner.auth)
      .send({ fileName: 'usd2.csv', csv: ['Date,Details,Ref,Amount (USD)', `${dmy(day(5))},TO INR ACCOUNT,,-500.00`].join('\n'), mapping, dryRun: false })
      .expect(201);
    expect((await ctx.http().get(`${org.base}/banking/transfers/suggestions`).set(owner.auth).expect(200)).body.items).toEqual([]);
    const out = await lineBy('TO INR');
    const into = (await ctx.http().get(`${org.base}/banking/accounts/${org.acc['1120']}/lines`).set(owner.auth).expect(200)).body.lines[0];
    expect((await ctx.http().post(`${org.base}/banking/transfers`).set(owner.auth).send({ outLineId: out.id, inLineId: into.id }).expect(422)).body.message).toMatch(/1130 is in USD and 1120 in INR/);
  });
});
