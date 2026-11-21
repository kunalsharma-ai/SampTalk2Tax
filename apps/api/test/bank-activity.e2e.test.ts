import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Unusual bank activity (BANK-019, BANK-023) against the real API and database: an imported
 * statement with a duplicate payment, cash deposits split just under 50,000, money straight in and
 * out, and money out nobody has booked; the findings and their levels, a lower splitting
 * threshold, excluding a line, the alert check raising and clearing alerts, permissions and
 * tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
type Item = { lineId: string; account: { name: string }; date: string; amount: string; description: string; level: string; indicators: { code: string; level: string; label: string; detail: string }[] };
type Res = { asOf: string; days: number; threshold: string; summary: { lines: number; high: number; medium: number; low: number; accounts: number; byIndicator: Record<string, number> }; items: Item[] };
const get = async (query = '', user = owner) => (await ctx.http().get(`${org.base}/banking/unusual-activity${query}`).set(user.auth).expect(200)).body as Res;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Watch Owner');
  viewer = await registerUser(ctx, 'Watch Viewer');
  outsider = await registerUser(ctx, 'Watch Outsider');
  org = await createOrg(ctx, owner, { name: 'Watchful Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Watch Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  bank = org.acc['1120']!;
  const history = Array.from({ length: 12 }, (_, k) => `${dmy(addDays(T, -(170 - k * 10)))},${k % 2 ? `UPI DR VENDOR ${k}` : `NEFT CR CUSTOMER ${k}`},,${k % 2 ? '-4000.00' : '6000.00'}`);
  const csv = [
    'Date,Narration,Ref,Amount',
    ...history,
    `${dmy(addDays(T, -20))},POS SOMEWHERE,,-1500.00`,
    `${dmy(addDays(T, -10))},IMPS TEAK SUPPLIES REF 1,IMPS1,-25000.00`,
    `${dmy(addDays(T, -9))},IMPS TEAK SUPPLIES REF 2,IMPS2,-25000.00`,
    `${dmy(addDays(T, -6))},CASH DEPOSIT,,48000.00`,
    `${dmy(addDays(T, -5))},CASH DEPOSIT BRANCH 2,,49500.00`,
    `${dmy(addDays(T, -3))},CASH DEPOSIT,,47000.00`,
    `${dmy(addDays(T, -2))},RTGS CR UNKNOWN PARTY,UTR9,300000.00`,
    `${dmy(addDays(T, -1))},RTGS DR ONWARD TRANSFER,UTR10,-295000.00`,
  ].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'nov.csv', csv, mapping }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('unusual bank activity', () => {
  it('flags the warning signs on statement lines, most serious first', async () => {
    const r = await get('', viewer);
    expect(r).toMatchObject({ asOf: T, days: 30, threshold: '50000' });
    const by = (amount: string) => r.items.find((i) => i.amount === amount)!;
    const codes = (amount: string) => by(amount).indicators.map((i) => i.code);
    expect(r.items.filter((i) => i.amount === '-25000.00').map((i) => i.indicators[0]!.code)).toEqual(['DUPLICATE', 'DUPLICATE']);
    for (const a of ['48000.00', '49500.00', '47000.00']) expect(codes(a)).toEqual(['JUST_UNDER']);
    expect(by('49500.00').indicators[0]!.detail).toBe('One of 3 credits within 7 days each just under ₹50,000.00');
    expect(by('-295000.00')).toMatchObject({ level: 'HIGH', account: { name: 'Operating Bank Account' } });
    expect(codes('-295000.00')).toEqual(['PASS_THROUGH', 'LARGE', 'NEW_PAYEE', 'ROUND']);
    expect(by('-295000.00').indicators[0]!.detail).toBe('Paid out 1 day after ₹3,00,000.00 came in');
    expect(by('300000.00')).toMatchObject({ level: 'MEDIUM' });
    expect(codes('300000.00')).toEqual(['LARGE', 'ROUND']);
    expect(codes('-1500.00')).toEqual(['NOT_RECORDED']);
    expect(r.items.map((i) => i.level)).toEqual(['HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'HIGH', 'MEDIUM', 'MEDIUM']);
    expect(r.items[0]!.amount).toBe('-295000.00');
    expect(r.summary).toMatchObject({ lines: 8, high: 6, medium: 2, low: 0, accounts: 1, byIndicator: { DUPLICATE: 2, JUST_UNDER: 3, PASS_THROUGH: 1, NOT_RECORDED: 1, ROUND: 2 } });
  });

  it('takes another period and threshold, and checks them', async () => {
    expect((await get('?threshold=60000')).items.some((i) => i.indicators.some((x) => x.code === 'JUST_UNDER'))).toBe(false);
    expect((await get('?days=7')).items.some((i) => i.amount === '-1500.00')).toBe(false);
    await ctx.http().get(`${org.base}/banking/unusual-activity?days=3`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/unusual-activity?threshold=0`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/unusual-activity?threshold=12abc`).set(owner.auth).expect(400);
  });

  it('raises alerts for serious and medium signs, cleared once a line is excluded', async () => {
    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_BANK_ACTIVITY`).set(viewer.auth).send({ enabled: true }).expect(403);
    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_BANK_ACTIVITY`).set(owner.auth).send({ enabled: true, params: { days: '30', threshold: '50000' } }).expect(200);
    const alerts = async () => {
      await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
      return (await ctx.http().get(`${org.base}/alerts`).query({ status: 'ACTIVE' }).set(owner.auth).expect(200)).body.alerts.filter((a: { rule: string }) => a.rule === 'UNUSUAL_BANK_ACTIVITY') as { severity: string; title: string; summary: string; evidence: { facts: { label: string; value: string }[]; links: { path?: string }[] } }[];
    };
    const found = await alerts();
    expect(found).toHaveLength(8);
    expect(found.filter((a) => a.severity === 'CRITICAL')).toHaveLength(6);
    const pass = found.find((a) => a.title.startsWith('Straight in and out'))!;
    expect(pass.title).toMatch(/^Straight in and out: ₹2,95,000\.00 out of Operating Bank Account on /);
    expect(pass.evidence.facts).toEqual(expect.arrayContaining([{ label: 'Money out', value: '₹2,95,000.00' }, { label: 'Narration', value: 'RTGS DR ONWARD TRANSFER' }, { label: 'Reference', value: 'UTR10' }]));
    expect(pass.evidence.links[0]).toMatchObject({ path: '/banking/unusual-activity' });

    const pos = (await get()).items.find((i) => i.amount === '-1500.00')!;
    await ctx.http().post(`${org.base}/banking/lines/${pos.lineId}/exclude`).set(owner.auth).send({ reason: 'Card test charge, refunded' }).expect(200);
    expect((await get()).items.some((i) => i.amount === '-1500.00')).toBe(false);
    expect(await alerts()).toHaveLength(7);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/banking/unusual-activity`).set(outsider.auth).expect(404);
    expect(((await ctx.http().get(`${other.base}/banking/unusual-activity`).set(outsider.auth).expect(200)).body as Res).items).toEqual([]);
  });
});
