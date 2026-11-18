import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * EXP-022 anomaly checks against the real API and database: a claim line several times the
 * organisation's usual for its category (from approved claims in the last 12 months), a receipt
 * just under a per-receipt limit, and receipts split to stay under it are shown on the claim for
 * a second look; nothing is blocked; normal claims show nothing; other organisations' claims do
 * not count.
 */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let approver: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const claim = (lines: object[], o = org, who = employee) => ctx.http().post(`${o.base}/expense-claims`).set(who.auth).send({ title: 'Team lunch (synthetic)', lines }).expect(201);
const approved = async (amount: string, n: number, o = org, who = employee, boss = approver) => {
  const c = (await claim([{ date: day(n), accountId: o.acc['6600'], merchant: 'Synthetic Canteen', amount }], o, who)).body;
  await ctx.http().post(`${o.base}/expense-claims/${c.id}/submit`).set(who.auth).send({}).expect(200);
  await ctx.http().post(`${o.base}/expense-claims/${c.id}/approve`).set(boss.auth).send({}).expect(200);
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Anomaly Owner');
  employee = await registerUser(ctx, 'Anomaly Employee');
  approver = await registerUser(ctx, 'Anomaly Approver');
  outsider = await registerUser(ctx, 'Anomaly Outsider');
  org = await createOrg(ctx, owner);
  other = await createOrg(ctx, outsider, { name: 'Other Anomalies Ltd' });
  for (const [u, role] of [[employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Ten approved meal claims around INR 1,000 make the usual for the category.
  for (let i = 0; i < 10; i++) await approved(String(900 + i * 20), 20 + i);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('anomaly checks on a claim', () => {
  it('flags a meal several times the usual, and not one near it', async () => {
    const c = (await claim([
      { date: day(2), accountId: org.acc['6600'], merchant: 'Synthetic Bistro', amount: '1100.00' },
      { date: day(3), accountId: org.acc['6600'], merchant: 'Synthetic Grand Hotel', amount: '6400.00' },
    ])).body;
    expect(c.anomalies).toHaveLength(1);
    expect(c.anomalies[0]).toMatchObject({ code: 'UNUSUAL_AMOUNT', lineNo: 2, lineNos: [2] });
    expect(c.anomalies[0].message).toBe('Line 2: INR 6400.00 is about 6 times the usual for 6600 · Professional Fees (median INR 990.00 across 10 approved lines in the last 12 months)');
    // Nothing is blocked: it submits, and the approver sees the same.
    const s = (await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(employee.auth).send({}).expect(200)).body;
    expect(s.status).toBe('SUBMITTED');
    const seen = (await ctx.http().get(`${org.base}/expense-claims/${c.id}`).set(approver.auth).expect(200)).body;
    expect(seen.anomalies.map((x: { code: string }) => x.code)).toEqual(['UNUSUAL_AMOUNT']);
    // Once decided, the checks are no longer shown.
    const done = (await ctx.http().post(`${org.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200)).body;
    expect(done.anomalies).toBeNull();
  });

  it('flags receipts just under a per-receipt limit, and receipts split around it', async () => {
    await ctx.http().post(`${org.base}/expense-policy-rules`).set(owner.auth).send({ kind: 'LINE_MAX', severity: 'WARN', accountId: org.acc['6700'], amount: '5000' }).expect(201);
    const c = (await claim([
      { date: day(4), accountId: org.acc['6700'], merchant: 'Synthetic Cabs', amount: '4900.00' },
      { date: day(5), accountId: org.acc['6700'], merchant: 'Synthetic Rail', amount: '3000.00' },
      { date: day(5), accountId: org.acc['6700'], merchant: 'Synthetic Rail', amount: '2500.00' },
    ])).body;
    expect(c.policy).toEqual([]);
    expect(c.anomalies.map((x: { code: string; lineNos: number[] }) => [x.code, x.lineNos])).toEqual([
      ['JUST_UNDER_LIMIT', [1]],
      ['SPLIT_UNDER_LIMIT', [2, 3]],
    ]);
    expect(c.anomalies[1].message).toContain('total INR 5500.00, over the limit of INR 5000.00 per receipt');
  });

  it('shows nothing on an ordinary claim, and does not count other organisations', async () => {
    const c = (await claim([{ date: day(2), accountId: org.acc['6600'], merchant: 'Synthetic Bistro', amount: '950.00' }])).body;
    expect(c.anomalies).toEqual([]);
    // The other organisation has no history of its own, so a large meal there is not compared with ours.
    const big = (await claim([{ date: day(2), accountId: other.acc['6600'], merchant: 'Synthetic Grand Hotel', amount: '6400.00' }], other, outsider)).body;
    expect(big.anomalies).toEqual([]);
  });
});
