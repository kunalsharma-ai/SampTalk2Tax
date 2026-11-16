import { addMonth, chargeFor, fiscalYearForDate, monthEnd } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The fixed asset register against the real API and database: adding assets (with the
 * purchase posted, or brought in part-depreciated), depreciation runs posted as one journal a
 * month with catch-up of missed months, reversing the latest run, disposal with a gain or loss,
 * and the database guards that keep posted history fixed.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const M = T.slice(0, 7);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let F: string;
let laptop: string;
let machine: string;
const machineTerms = { cost: '500000.00', residualValue: '0.00', inServiceDate: `${addMonth(M, -30)}-01`, method: 'WRITTEN_DOWN_VALUE' as const, annualRate: '15', openingAccumulated: '75000.00', depreciatedThrough: addMonth(M, -4) };

const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const asset = async (id: string) => (await ctx.http().get(`${F}/${id}`).set(owner.auth).expect(200)).body;
const dep = async (month?: string) => (await ctx.http().get(`${F}/depreciation${month ? `?month=${month}` : ''}`).set(owner.auth).expect(200)).body;
const entry = async (number: number) => {
  const list = (await ctx.http().get(`${org.base}/journals?limit=200`).set(owner.auth).expect(200)).body;
  const e = (list.items ?? list).find((j: { entryNumber: number }) => j.entryNumber === number);
  return (await ctx.http().get(`${org.base}/journals/${e.id}`).set(owner.auth).expect(200)).body;
};
const lineMap = (e: { lines: { accountId: string; debit: string; credit: string }[] }) =>
  Object.fromEntries(Object.entries(org.acc).filter(([, id]) => e.lines.some((l) => l.accountId === id)).map(([code, id]) => {
    const ls = e.lines.filter((l) => l.accountId === id);
    return [code, ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0).toFixed(2)];
  }));
const laptopBody = (over: Record<string, unknown> = {}) => ({
  name: 'Design laptops (3)',
  category: 'Computers',
  serialNumber: 'LT-2026-01',
  location: 'Pune office',
  assetAccountId: org.acc['1510'],
  accumulatedAccountId: org.acc['1520'],
  expenseAccountId: org.acc['6800'],
  acquisitionDate: `${addMonth(M, -3)}-10`,
  inServiceDate: `${addMonth(M, -3)}-12`,
  cost: '120000.00',
  residualValue: '12000.00',
  method: 'STRAIGHT_LINE',
  usefulLifeMonths: 36,
  fundingAccountId: org.acc['1120'],
  ...over,
});

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Asset Owner');
  accountant = await registerUser(ctx, 'Asset Accountant');
  viewer = await registerUser(ctx, 'Asset Viewer');
  org = await createOrg(ctx, owner, { name: 'Fixed Assets Pvt Ltd' });
  F = `${org.base}/fixed-assets`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('fixed asset register', () => {
  it('adds an asset and posts its purchase', async () => {
    const r = await ctx.http().post(F).set(accountant.auth).send(laptopBody()).expect(201);
    laptop = r.body.id;
    expect(r.body).toMatchObject({ reference: 'FA-0001', status: 'ACTIVE', cost: '120000.00', accumulated: '0.00', netBookValue: '120000.00', termsFixed: false, createdBy: 'Asset Accountant', fullyDepreciatedIn: addMonth(M, 32) });
    expect(r.body.accounts.asset.code).toBe('1510');
    const purchase = await entry(r.body.acquisitionEntry.entryNumber);
    expect(purchase).toMatchObject({ source: 'ASSET', reference: 'FA-0001', date: `${addMonth(M, -3)}-10` });
    expect(lineMap(purchase)).toEqual({ '1120': '-120000.00', '1510': '120000.00' });
    expect(r.body.schedule[0]).toEqual({ month: addMonth(M, -3), charge: '3000.00', accumulated: '3000.00', netBookValue: '117000.00', posted: false });
  });

  it('brings in an asset already part-depreciated, without posting anything', async () => {
    const r = await ctx.http().post(F).set(owner.auth).send({ ...laptopBody({ name: 'CNC machine', category: 'Plant', serialNumber: null, location: 'Factory', acquisitionDate: machineTerms.inServiceDate, fundingAccountId: null, usefulLifeMonths: null }), ...machineTerms }).expect(201);
    machine = r.body.id;
    expect(r.body).toMatchObject({ reference: 'FA-0002', accumulated: '75000.00', netBookValue: '425000.00', acquisitionEntry: null, method: 'WRITTEN_DOWN_VALUE', annualRate: '15.00' });
    expect(r.body.schedule[0].month).toBe(addMonth(M, -3));
  });

  it('refuses terms that do not add up, and accounts of the wrong kind', async () => {
    const bad = async (over: Record<string, unknown>, msg: string) => {
      const r = await ctx.http().post(F).set(owner.auth).send(laptopBody(over)).expect(422);
      expect(r.body.message).toBe(msg);
    };
    await bad({ residualValue: '120000.00' }, 'Residual value must be less than cost');
    await bad({ assetAccountId: org.acc['1120'] }, 'The asset account must be a fixed asset account');
    await bad({ expenseAccountId: org.acc['6900'] }, 'The depreciation expense account must be a depreciation account');
    await bad({ method: 'WRITTEN_DOWN_VALUE', usefulLifeMonths: null, annualRate: '150' }, 'Annual rate must be more than 0% and at most 100%');
    await bad({ inServiceDate: `${addMonth(M, -4)}-01` }, 'An asset cannot be put to use before it was acquired');
    await bad({ openingAccumulated: '5000.00', depreciatedThrough: addMonth(M, -2) }, 'An asset brought in with opening depreciation is already in the books: do not record its purchase again');
    await ctx.http().post(F).set(viewer.auth).send(laptopBody()).expect(403);
    expect((await ctx.http().get(F).set(viewer.auth).expect(200)).body.can.manage).toBe(false);
  });

  it('previews and posts a month of depreciation as one journal', async () => {
    const d = await dep();
    expect(d).toMatchObject({ lastPosted: null, nextMonth: addMonth(M, -3), month: addMonth(M, -3), alreadyPosted: false });
    const m3 = addMonth(M, -3);
    const machineCharge = chargeFor(machineTerms, m3, {}, 4);
    expect(d.preview).toEqual([
      { assetId: laptop, reference: 'FA-0001', name: 'Design laptops (3)', month: m3, amount: '3000.00', catchUp: false },
      { assetId: machine, reference: 'FA-0002', name: 'CNC machine', month: m3, amount: machineCharge, catchUp: false },
    ]);
    const total = (3000 + Number(machineCharge)).toFixed(2);
    expect(d.previewTotal).toBe(total);

    const after = (await ctx.http().post(`${F}/depreciation/runs`).set(accountant.auth).send({ month: m3 }).expect(201)).body;
    expect(after.lastPosted).toBe(m3);
    expect(after.runs[0]).toMatchObject({ month: m3, status: 'POSTED', total, lines: 2, postedBy: 'Asset Accountant', canReverse: true });
    const je = await entry(after.runs[0].entry.entryNumber);
    expect(je).toMatchObject({ source: 'ASSET', reference: `DEP-${m3}`, date: monthEnd(m3) });
    expect(lineMap(je)).toEqual({ '1520': `-${total}`, '6800': total });

    expect((await ctx.http().post(`${F}/depreciation/runs`).set(owner.auth).send({ month: m3 }).expect(409)).body.error).toBe('MONTH_ALREADY_RUN');
    expect((await ctx.http().post(`${F}/depreciation/runs`).set(owner.auth).send({ month: addMonth(M, 1) }).expect(409)).body.error).toBe('MONTH_NOT_OVER');
    await ctx.http().post(`${F}/depreciation/runs`).set(viewer.auth).send({ month: addMonth(M, -2) }).expect(403);
  });

  it('catches up months that were skipped', async () => {
    const m1 = addMonth(M, -1);
    const d = await dep(m1);
    expect(d.preview.filter((l: { assetId: string }) => l.assetId === laptop).map((l: { month: string; catchUp: boolean }) => [l.month, l.catchUp])).toEqual([[addMonth(M, -2), true], [m1, false]]);
    await ctx.http().post(`${F}/depreciation/runs`).set(owner.auth).send({ month: m1 }).expect(201);
    const a = await asset(laptop);
    expect(a).toMatchObject({ accumulated: '9000.00', netBookValue: '111000.00', termsFixed: true });
    expect(a.postings.map((p: { month: string; runMonth: string }) => [p.month, p.runMonth])).toEqual([[addMonth(M, -3), addMonth(M, -3)], [addMonth(M, -2), m1], [m1, m1]]);
    expect(a.schedule.filter((r: { posted: boolean }) => r.posted)).toHaveLength(3);
  });

  it('fixes an asset\'s terms once depreciation is posted, but not its name', async () => {
    const r = await ctx.http().put(`${F}/${laptop}`).set(owner.auth).send({ ...laptopBody({ cost: '125000.00' }), fundingAccountId: undefined }).expect(409);
    expect(r.body.error).toBe('ASSET_TERMS_FIXED');
    const ok = await ctx.http().put(`${F}/${laptop}`).set(owner.auth).send({ ...laptopBody({ name: 'Design laptops (3 x 16")', location: 'Mumbai office' }), fundingAccountId: undefined }).expect(200);
    expect(ok.body).toMatchObject({ name: 'Design laptops (3 x 16")', location: 'Mumbai office', cost: '120000.00' });
  });

  it('reverses only the latest run', async () => {
    const d = await dep();
    const [latest, earlier] = d.runs;
    expect([latest.canReverse, earlier.canReverse]).toEqual([true, false]);
    expect((await ctx.http().post(`${F}/depreciation/runs/${earlier.id}/reverse`).set(owner.auth).expect(409)).body.error).toBe('NOT_LATEST_RUN');
    const after = (await ctx.http().post(`${F}/depreciation/runs/${latest.id}/reverse`).set(owner.auth).expect(200)).body;
    expect(after.runs[0]).toMatchObject({ status: 'REVERSED', reversedBy: 'Asset Owner' });
    expect(after.lastPosted).toBe(addMonth(M, -3));
    const rev = await entry(after.runs[0].reversal.entryNumber);
    expect(rev.type).toBe('REVERSING');
    expect((await asset(laptop)).accumulated).toBe('3000.00');
  });

  it('disposes of an asset with a loss, once depreciation is posted through the month of disposal', async () => {
    const body = { date: T, proceeds: '100000.00', proceedsAccountId: org.acc['1120'], gainLossAccountId: org.acc['4900'], note: 'Sold to staff' };
    const r = await ctx.http().post(`${F}/${laptop}/dispose`).set(owner.auth).send(body).expect(409);
    expect(r.body).toMatchObject({ error: 'DEPRECIATION_NOT_POSTED' });
    await ctx.http().post(`${F}/depreciation/runs`).set(owner.auth).send({ month: addMonth(M, -1) }).expect(201);
    expect((await ctx.http().post(`${F}/${laptop}/dispose`).set(owner.auth).send(body).expect(409)).body.error).toBe('DEPRECIATION_NOT_POSTED');
    await ctx.http().post(`${F}/depreciation/runs`).set(owner.auth).send({ month: M }).expect(201);
    expect((await ctx.http().post(`${F}/${laptop}/dispose`).set(owner.auth).send({ ...body, gainLossAccountId: org.acc['1120'] }).expect(422)).body.message).toBe('The gain or loss goes to an income or expense account');

    const a = (await ctx.http().post(`${F}/${laptop}/dispose`).set(owner.auth).send(body).expect(200)).body;
    expect(a).toMatchObject({ status: 'DISPOSED', accumulated: '12000.00', netBookValue: '0.00', disposal: { date: T, proceeds: '100000.00', note: 'Sold to staff', by: 'Asset Owner' } });
    const je = await entry(a.disposal.entry.entryNumber);
    // Proceeds 100,000 in; 12,000 accumulated depreciation and 120,000 cost out; loss of 8,000.
    expect(lineMap(je)).toEqual({ '1120': '100000.00', '1510': '-120000.00', '1520': '12000.00', '4900': '8000.00' });
    expect((await ctx.http().post(`${F}/${laptop}/dispose`).set(owner.auth).send(body).expect(409)).body.error).toBe('ASSET_DISPOSED');
    const d = await dep();
    expect((await ctx.http().post(`${F}/depreciation/runs/${d.runs[0].id}/reverse`).set(owner.auth).expect(409)).body.error).toBe('ASSET_DISPOSED');
    const reg = (await ctx.http().get(F).set(owner.auth).expect(200)).body;
    expect(reg.totals).toMatchObject({ active: 1, disposed: 1 });
    expect(reg.totals.cost).toBe('500000.00');
  });

  it('keeps the register\'s history in the database', async () => {
    await expect(raw(`DELETE FROM fixed_assets WHERE id = $1::uuid`, machine)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE depreciation_lines SET amount = 1 WHERE asset_id = $1::uuid`, machine)).rejects.toThrow(/never changed/);
    await expect(raw(`UPDATE fixed_assets SET cost = 1 WHERE id = $1::uuid`, machine)).rejects.toThrow(/terms are fixed/);
    await expect(raw(`UPDATE fixed_assets SET name = 'x' WHERE id = $1::uuid`, laptop)).rejects.toThrow(/disposed asset/);
    await expect(raw(`DELETE FROM depreciation_runs WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/never deleted/);
  });
});
