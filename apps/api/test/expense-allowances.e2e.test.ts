import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Mileage and per diem claims (EXP-006, EXP-008), from the rates to the posted journal. */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let car: string;
let metro: string;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const rates = () => ctx.http().post(`${org.base}/expense-allowance-rates`);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  employee = await registerUser(ctx, 'Field Employee');
  approver = await registerUser(ctx, 'Approver');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('rates', () => {
  it('are set by finance, checked, unique by name, and listed for claimants', async () => {
    await rates().set(employee.auth).send({ kind: 'MILEAGE', name: 'Car', rate: '9.50', accountId: org.acc['6700'] }).expect(403);
    const bad = await rates().set(owner.auth).send({ kind: 'PER_DIEM', name: 'Metro city', rate: '2500.005', accountId: org.acc['6700'] }).expect(422);
    expect(bad.body.details.issues).toEqual(['A daily rate has at most 2 decimal places in INR']);
    // Not an expense account (bank), and a control account.
    expect((await rates().set(owner.auth).send({ kind: 'MILEAGE', name: 'Car', rate: '9.50', accountId: org.acc['1120'] }).expect(422)).body.details.issues).toEqual(['Choose an active expense account the rate posts to']);

    const r = await rates().set(owner.auth).send({ kind: 'MILEAGE', name: 'Car', rate: '9.50', accountId: org.acc['6700'] }).expect(201);
    expect(r.body).toMatchObject({ kind: 'MILEAGE', unit: 'KM', name: 'Car', rate: '9.50', account: '6700 · Travel', isActive: true });
    car = r.body.id;
    expect((await rates().set(owner.auth).send({ kind: 'MILEAGE', name: 'car', rate: '10', accountId: org.acc['6700'] }).expect(409)).body.error).toBe('RATE_EXISTS');
    metro = (await rates().set(owner.auth).send({ kind: 'PER_DIEM', name: 'Metro city', rate: '2500', accountId: org.acc['6700'] }).expect(201)).body.id;
    const off = (await rates().set(owner.auth).send({ kind: 'PER_DIEM', name: 'Retired rate', rate: '100', accountId: org.acc['6700'] }).expect(201)).body.id;
    await ctx.http().put(`${org.base}/expense-allowance-rates/${off}`).set(owner.auth).send({ name: 'Retired rate', rate: '100', accountId: org.acc['6700'], isActive: false }).expect(200);

    const opts = (await ctx.http().get(`${org.base}/expense-claims/options`).set(employee.auth).expect(200)).body;
    expect(opts.allowanceRates.map((x: { name: string }) => x.name)).toEqual(['Car', 'Metro city']);
    await ctx.http().get(`${org.base}/expense-allowance-rates`).set(employee.auth).expect(403);
    expect((await ctx.http().get(`${org.base}/expense-allowance-rates`).set(owner.auth).expect(200)).body).toHaveLength(3);
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: { startsWith: 'expense_allowance_rate.' } } })).toBe(4);
  });
});

describe('a claim with mileage, per diem and a receipt', () => {
  let claimId: string;

  it('works out the amounts on the server and keeps what they came from', async () => {
    const bad = await ctx
      .http()
      .post(`${org.base}/expense-claims`)
      .set(employee.auth)
      .send({
        title: 'Mumbai client visit (synthetic)',
        lines: [
          { date: day(3), allowance: { rateId: car, quantity: '12.25', from: 'Pune', to: 'Mumbai' } },
          { date: day(3), allowance: { rateId: metro, quantity: '1.5' } },
        ],
      })
      .expect(422);
    expect(bad.body.details.issues).toEqual(['Line 1: Give the distance to one decimal place (0.1 km)', 'Line 2: Say where you stayed']);

    const res = await ctx
      .http()
      .post(`${org.base}/expense-claims`)
      .set(employee.auth)
      .send({
        title: 'Mumbai client visit (synthetic)',
        lines: [
          // Amount and account sent by the client are ignored for an allowance line.
          { date: day(3), accountId: org.acc['6600'], amount: '99999.00', allowance: { rateId: car, quantity: '148.5', from: 'Pune', to: 'Mumbai', purpose: 'Client visit' } },
          { date: day(2), allowance: { rateId: metro, quantity: '1.5', to: 'Mumbai' } },
          { date: day(2), accountId: org.acc['6700'], merchant: 'Synthetic Tolls', amount: '320.00' },
        ],
      })
      .expect(201);
    claimId = res.body.id;
    expect(res.body.total).toBe('5480.75'); // 148.5 × 9.50 = 1410.75; 1.5 × 2500 = 3750; + 320
    const [m, p, r] = res.body.lines;
    expect(m).toMatchObject({ accountCode: '6700', amount: '1410.75', taxAmount: '0.00', merchant: null, description: 'Mileage 148.5 km × 9.50 (Car), Pune to Mumbai: Client visit' });
    expect(m.allowance).toMatchObject({ kind: 'MILEAGE', rateName: 'Car', rate: '9.50', unit: 'KM', quantity: '148.5', from: 'Pune', to: 'Mumbai', purpose: 'Client visit' });
    expect(p.allowance).toMatchObject({ kind: 'PER_DIEM', unit: 'DAY', quantity: '1.5', from: null, to: 'Mumbai' });
    expect(p.amount).toBe('3750.00');
    expect(r.allowance).toBeNull();
  });

  it('keeps the saved amounts when the rate changes later, and replaces details when the claim is edited', async () => {
    await ctx.http().put(`${org.base}/expense-allowance-rates/${car}`).set(owner.auth).send({ name: 'Car', rate: '12.00', accountId: org.acc['6700'], isActive: true }).expect(200);
    const kept = (await ctx.http().get(`${org.base}/expense-claims/${claimId}`).set(employee.auth).expect(200)).body;
    expect(kept.lines[0].amount).toBe('1410.75');

    const edited = await ctx
      .http()
      .put(`${org.base}/expense-claims/${claimId}`)
      .set(employee.auth)
      .send({ title: 'Mumbai client visit (synthetic)', lines: [{ date: day(2), allowance: { rateId: metro, quantity: '2', to: 'Mumbai' } }, { date: day(3), allowance: { rateId: car, quantity: '10', from: 'Office', to: 'Client' } }] })
      .expect(200);
    expect(edited.body.lines.map((l: { amount: string }) => l.amount)).toEqual(['5000.00', '120.00']);
    expect(edited.body.lines[1].allowance.rate).toBe('12.00');
    expect(await ctx.db.collection('expense_claim_allowances').countDocuments({ claimId })).toBe(2);
  });

  it('posts to the rates\' accounts when approved', async () => {
    await ctx.http().post(`${org.base}/expense-claims/${claimId}/submit`).set(employee.auth).send({}).expect(200);
    const c = (await ctx.http().post(`${org.base}/expense-claims/${claimId}/approve`).set(approver.auth).send({}).expect(200)).body;
    expect(c.status).toBe('APPROVED');
    const je = (await ctx.http().get(`${org.base}/journals/${c.journalEntryId}`).set(owner.auth).expect(200)).body;
    const debits = je.lines.filter((l: { debit: string }) => Number(l.debit) > 0).map((l: { accountId: string; debit: string }) => [l.accountId, l.debit]);
    expect(debits).toEqual([[org.acc['6700'], '5000.00'], [org.acc['6700'], '120.00']]);
  });

  it('refuses an inactive rate, and drops details with a deleted draft', async () => {
    const off = (await ctx.http().get(`${org.base}/expense-allowance-rates`).set(owner.auth).expect(200)).body.find((r: { isActive: boolean }) => !r.isActive).id;
    const r = await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'x', lines: [{ date: day(1), allowance: { rateId: off, quantity: '1', to: 'Pune' } }] }).expect(422);
    expect(r.body.details.issues).toEqual(['Line 1: choose an active mileage or per diem rate']);
    const d = (await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'Draft', lines: [{ date: day(1), allowance: { rateId: metro, quantity: '1', to: 'Pune' } }] }).expect(201)).body.id;
    await ctx.http().delete(`${org.base}/expense-claims/${d}`).set(employee.auth).expect(204);
    expect(await ctx.db.collection('expense_claim_allowances').countDocuments({ claimId: d })).toBe(0);
    // A line with neither a category and amount nor an allowance is refused by the API shape.
    await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'x', lines: [{ date: day(1), merchant: 'nothing' }] }).expect(400);
  });
});
