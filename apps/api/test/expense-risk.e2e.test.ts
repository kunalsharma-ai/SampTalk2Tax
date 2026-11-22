import { formatDateText } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Unusual expenses and fraud risk indicators (EXP-023, EXP-024) against the real API and database:
 * the same receipt claimed by two people, an old receipt, receipts split around a limit, someone
 * who keeps landing just under it, missing receipts, an unusually large meal and a Sunday receipt;
 * the findings, their order and the people view; a higher receipts amount; the alert check raising
 * alerts and clearing them once a claim is rejected; permissions and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let ravi: TestUser;
let asha: TestUser;
let approver: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const ids: Record<string, string> = {};

const iso = (n: number) => new Date(Date.parse(`${T}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const sunday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay() === 0;
/** n days ago, moved a day earlier when that is a Sunday, so only the Sunday test sees one. */
const day = (n: number) => (sunday(iso(n)) ? iso(n + 1) : iso(n));
const lastSunday = () => {
  let n = 2;
  while (!sunday(iso(n))) n++;
  return iso(n);
};
type Indicator = { code: string; level: string; label: string; detail: string; lineNos: number[]; otherClaim: { id: string; number: string; claimantName: string } | null };
type Item = { claim: { id: string; number: string; claimantName: string; title: string; total: string; status: string }; level: string; score: number; indicators: Indicator[] };
type Res = { asOf: string; days: number; receiptsFrom: string; summary: { claims: number; flagged: number; high: number; medium: number; low: number; people: number; byIndicator: Record<string, number> }; items: Item[]; people: { claimantName: string; claims: number; flagged: number; score: number; high: number; medium: number; low: number; flaggedTotal: { currency: string; amount: string }[]; codes: string[] }[] };
const get = async (query = '', user = owner) => (await ctx.http().get(`${org.base}/expense-risk${query}`).set(user.auth).expect(200)).body as Res;

async function submitted(key: string, who: TestUser, lines: object[], approve = false) {
  const c = (await ctx.http().post(`${org.base}/expense-claims`).set(who.auth).send({ title: `Synthetic ${key}`, lines }).expect(201)).body;
  await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(who.auth).send({}).expect(200);
  if (approve) await ctx.http().post(`${org.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200);
  ids[key] = c.id;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Risk Owner');
  ravi = await registerUser(ctx, 'Ravi Risky');
  asha = await registerUser(ctx, 'Asha Careful');
  approver = await registerUser(ctx, 'Risk Approver');
  outsider = await registerUser(ctx, 'Risk Outsider');
  org = await createOrg(ctx, owner, { name: 'Careful Spend Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Spend Ltd' });
  for (const [u, role] of [[ravi, 'EMPLOYEE'], [asha, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/expense-policy-rules`).set(owner.auth).send({ kind: 'LINE_MAX', severity: 'WARN', accountId: org.acc['6700'], amount: '5000' }).expect(201);
  const meal = (n: number, amount: string, merchant = 'Synthetic Canteen') => ({ date: day(n), accountId: org.acc['6600'], merchant, amount });
  const travel = (n: number, amount: string, merchant = 'Synthetic Cabs') => ({ date: day(n), accountId: org.acc['6700'], merchant, amount });
  // Ten ordinary approved meals make the usual for the category.
  for (let i = 0; i < 10; i++) await submitted(`history${i}`, asha, [meal(20 + i, `${905 + i * 20}.50`)], true);
  await submitted('A', asha, [meal(6, '845.50', 'Cafe Coffee Day')], true);
  await submitted('B', ravi, [meal(6, '845.50', 'CAFE COFFEE DAY'), travel(70, '640.25', 'Synthetic Rail')]);
  await submitted('D', ravi, [travel(12, '4800.50'), travel(10, '4850.25')]);
  await submitted('C', ravi, [travel(5, '4890.00'), travel(4, '3000.50'), travel(4, '2499.75')]);
  await submitted('E', asha, [meal(3, '6400.25', 'Synthetic Grand Hotel')]);
  await submitted('F', asha, [{ date: lastSunday(), accountId: org.acc['6600'], merchant: 'Synthetic Dhaba', amount: '512.40' }]);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('unusual expenses and fraud risk', () => {
  it('flags the warning signs on claims, most serious first, and who has the most', async () => {
    const r = await get();
    expect(r).toMatchObject({ asOf: T, days: 90, receiptsFrom: '5000' });
    expect(r.items.map((i) => [i.claim.id, i.level, i.score])).toEqual([
      [ids.C, 'HIGH', 9],
      [ids.B, 'HIGH', 5],
      [ids.A, 'HIGH', 3],
      [ids.D, 'MEDIUM', 8],
      [ids.E, 'MEDIUM', 4],
      [ids.F, 'LOW', 1],
    ]);
    const by = (k: string) => r.items.find((i) => i.claim.id === ids[k])!;
    const codes = (k: string) => by(k).indicators.map((i) => i.code);
    expect(codes('C')).toEqual(['SPLIT_UNDER_LIMIT', 'JUST_UNDER_LIMIT', 'REPEATED_JUST_UNDER', 'NO_RECEIPTS']);
    expect(by('C').indicators[2]!.detail).toBe(`3 lines just under a per-receipt limit on Ravi Risky's claims in the 90 days to ${formatDateText(T)}`);
    expect(by('C').indicators[3]!.detail).toBe('₹10,390.25 of receipts claimed with no file attached');
    expect(codes('B')).toEqual(['DUPLICATE_RECEIPT', 'LATE_RECEIPT']);
    expect(by('B').indicators[0]).toMatchObject({ lineNos: [1], otherClaim: { id: ids.A, claimantName: 'Asha Careful' } });
    expect(by('B').indicators[0]!.detail).toBe(`Line 1: ₹845.50 on ${formatDateText(day(6))} at CAFE COFFEE DAY is also line 1 of ${by('A').claim.number}, claimed by Asha Careful`);
    expect(codes('A')).toEqual(['DUPLICATE_RECEIPT']);
    expect(codes('D')).toEqual(['JUST_UNDER_LIMIT', 'JUST_UNDER_LIMIT', 'REPEATED_JUST_UNDER', 'NO_RECEIPTS']);
    expect(codes('E')).toEqual(['UNUSUAL_AMOUNT', 'NO_RECEIPTS']);
    expect(by('E').indicators[0]!.detail).toContain('INR 6400.25 is about 6 times the usual');
    expect(codes('F')).toEqual(['SUNDAY']);
    expect(by('C').claim).toMatchObject({ claimantName: 'Ravi Risky', title: 'Synthetic C', total: '10390.25', status: 'SUBMITTED' });
    expect(r.summary).toMatchObject({ claims: 16, flagged: 6, high: 3, medium: 2, low: 1, people: 2, byIndicator: { DUPLICATE_RECEIPT: 2, NO_RECEIPTS: 3, SUNDAY: 1, ROUND_AMOUNT: 0 } });
    expect(r.people.map((p) => [p.claimantName, p.claims, p.flagged, p.score])).toEqual([
      ['Ravi Risky', 3, 3, 22],
      ['Asha Careful', 13, 3, 8],
    ]);
    expect(r.people[0]!.flaggedTotal).toEqual([{ currency: 'INR', amount: '21526.75' }]);
  });

  it('takes another period and receipts amount, and checks them', async () => {
    expect((await get('?receiptsFrom=20000')).items.some((i) => i.indicators.some((x) => x.code === 'NO_RECEIPTS'))).toBe(false);
    await ctx.http().get(`${org.base}/expense-risk?days=3`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/expense-risk?receiptsFrom=0`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/expense-risk?other=1`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/expense-risk`).set(ravi.auth).expect(403);
    expect((await get('', approver)).items).toHaveLength(6);
  });

  it('raises alerts for serious and medium signs, cleared once a claim is rejected', async () => {
    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_EXPENSE`).set(owner.auth).send({ enabled: true, params: { days: '30', receiptsFrom: '5000' } }).expect(200);
    const alerts = async () => {
      await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
      return (await ctx.http().get(`${org.base}/alerts`).query({ status: 'ACTIVE' }).set(owner.auth).expect(200)).body.alerts.filter((a: { rule: string }) => a.rule === 'UNUSUAL_EXPENSE') as { severity: string; title: string; summary: string; evidence: { facts: { label: string; value: string }[]; links: { path?: string }[] } }[];
    };
    const found = await alerts();
    expect(found).toHaveLength(5);
    expect(found.filter((a) => a.severity === 'CRITICAL')).toHaveLength(3);
    const split = found.find((a) => a.title.startsWith('Split around a limit'))!;
    expect(split.title).toMatch(/^Split around a limit: EXP-\d+, ₹10,390\.25 by Ravi Risky$/);
    expect(split.evidence.facts).toEqual(expect.arrayContaining([{ label: 'Claimant', value: 'Ravi Risky' }, { label: 'Status', value: 'Submitted' }]));
    expect(split.evidence.links.map((l) => l.path)).toEqual(['/expenses/risk', `/expenses/${ids.C}`]);

    // Rejecting the second copy of the receipt clears both duplicates.
    await ctx.http().post(`${org.base}/expense-claims/${ids.B}/reject`).set(approver.auth).send({ note: 'Already claimed by Asha' }).expect(200);
    expect((await get()).items.some((i) => i.indicators.some((x) => x.code === 'DUPLICATE_RECEIPT'))).toBe(false);
    expect(await alerts()).toHaveLength(3);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/expense-risk`).set(outsider.auth).expect(404);
    expect(((await ctx.http().get(`${other.base}/expense-risk`).set(outsider.auth).expect(200)).body as Res).items).toEqual([]);
  });
});
