import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Exchange rates and period-end revaluation of foreign-currency balances, against the real API. */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let usdBank: string;
let eurLoan: string;
const d0 = today();
const y = Number(d0.slice(0, 4));
// Dates inside the fiscal year created at onboarding (April to March).
const fyStart = d0.slice(5) >= '04-01' ? `${y}-04-01` : `${y - 1}-04-01`;
const day = (n: number) => { const d = new Date(`${fyStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'FX Owner');
  viewer = await registerUser(ctx, 'FX Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  usdBank = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1130', name: 'USD Bank', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
  eurLoan = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '2710', name: 'EUR Loan', type: 'LIABILITY', subtype: 'LONG_TERM_DEBT' }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('exchange rates', () => {
  it('are recorded by those who manage accounts, replaced per day, checked and audited', async () => {
    await ctx.http().put(`${org.base}/fx/rates`).set(viewer.auth).send({ currency: 'USD', date: day(0), rate: '83' }).expect(403);
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '82.5' }).expect(200);
    const r = (await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '83', source: 'RBI reference rate' }).expect(200)).body;
    expect(r).toMatchObject({ currency: 'USD', date: day(0), rate: '83', source: 'RBI reference rate' });
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'EUR', date: day(0), rate: '90' }).expect(200);
    expect((await ctx.http().get(`${org.base}/fx/rates`).set(viewer.auth).expect(200)).body).toHaveLength(2);
    expect((await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'INR', date: day(0), rate: '1' }).expect(422)).body.message).toMatch(/always has a rate of 1/);
    expect((await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(0), rate: '0' }).expect(422)).body.message).toMatch(/more than zero/);
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'XYZ', date: day(0), rate: '2' }).expect(422);
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'usd', date: day(0), rate: '2' }).expect(400);
    const actions = (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'fx.rate' } } })).map((a) => a.action).sort();
    expect(actions).toEqual(['fx.rate_added', 'fx.rate_added', 'fx.rate_changed']);
  });

  it('fill in journal lines that leave the rate out', async () => {
    const je = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: day(1), post: true, memo: 'USD funding', lines: [{ accountId: usdBank, currency: 'USD', debit: '10000.00' }, { accountId: org.acc['3100'], credit: '830000.00' }] }).expect(201)).body;
    expect(je.lines[0]).toMatchObject({ currency: 'USD', exchangeRate: '83' });
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: day(1), post: true, memo: 'EUR loan', lines: [{ accountId: org.acc['1120'], debit: '450000.00' }, { accountId: eurLoan, currency: 'EUR', exchangeRate: '90', credit: '5000.00' }] }).expect(201);
    // No GBP rate: the journal says the rate is needed.
    const bad = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: day(1), post: true, lines: [{ accountId: usdBank, currency: 'GBP', debit: '10.00' }, { accountId: org.acc['3100'], credit: '1000.00' }] }).expect(422);
    expect(JSON.stringify(bad.body)).toMatch(/exchange rate is required for GBP/);
  });
});

describe('revaluation', () => {
  it('previews the balances at the recorded or entered rates', async () => {
    await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: day(29), rate: '84.5' }).expect(200);
    const e = (await ctx.http().get(`${org.base}/fx/exposure?asOf=${day(29)}`).set(viewer.auth).expect(200)).body;
    expect(e.currencies).toEqual([{ currency: 'EUR', rate: '90', rateDate: day(0), entered: false }, { currency: 'USD', rate: '84.5', rateDate: day(29), entered: false }]);
    expect(e.lines.map((l: { code: string; adjustment: string }) => [l.code, l.adjustment])).toEqual([['1130', '15000.00'], ['2710', '0.00']]);
    expect(e.gain).toBe('15000.00');
    const tried = (await ctx.http().get(`${org.base}/fx/exposure?asOf=${day(29)}&rate.EUR=91.2`).set(viewer.auth).expect(200)).body;
    expect(tried.gain).toBe('9000.00');
    expect(tried.currencies[0]).toMatchObject({ currency: 'EUR', rate: '91.2', entered: true });
  });

  it('posts the gain or loss and reverses it the next day', async () => {
    await ctx.http().post(`${org.base}/fx/revaluations`).set(viewer.auth).send({ date: day(29) }).expect(403);
    const r = (await ctx.http().post(`${org.base}/fx/revaluations`).set(owner.auth).send({ date: day(29), rates: { EUR: '91.2' } }).expect(201)).body;
    expect(r).toMatchObject({ number: 1, reference: 'FXR-0001', date: day(29), reversalDate: day(30), gain: '9000.00' });
    expect(r.rates).toEqual({ EUR: { rate: '91.2', date: null }, USD: { rate: '84.5', date: day(29) } });
    // The books at the period end carry the closing rates.
    const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${day(29)}`).set(owner.auth).expect(200)).body;
    const bal = (code: string) => tb.rows.find((x: { code: string }) => x.code === code).balance;
    expect(bal('1130')).toBe('845000.00');
    expect(bal('2710')).toBe('456000.00');
    expect(bal('7200')).toBe('-9000.00');
    // The next day the entries are back at their own rates.
    const next = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${day(30)}`).set(owner.auth).expect(200)).body;
    expect(next.rows.find((x: { code: string }) => x.code === '1130').balance).toBe('830000.00');
    const je = (await ctx.http().get(`${org.base}/journals/${r.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ source: 'FX_REVALUATION', reference: 'FXR-0001' });
    // System entries cannot be reversed or changed by hand.
    await ctx.http().post(`${org.base}/journals/${r.journalEntryId}/reverse`).set(owner.auth).send({ date: day(31) }).expect(409);
    expect((await ctx.http().get(`${org.base}/fx/revaluations`).set(viewer.auth).expect(200)).body).toHaveLength(1);
    await expect(ctx.prisma.fxRevaluation.delete({ where: { id: r.id } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(ctx.prisma.fxRevaluation.update({ where: { id: r.id }, data: { gain: '1' } })).rejects.toThrow(/cannot be changed/);
    expect(await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: 'fx.revalued' } })).toBe(1);
  });

  it('refuses out of order, without rates, without an exchange account, or with nothing to post', async () => {
    expect((await ctx.http().post(`${org.base}/fx/revaluations`).set(owner.auth).send({ date: day(29) }).expect(409)).body.error).toBe('FX_ORDER');
    await ctx.http().post(`${org.base}/fx/revaluations`).set(owner.auth).send({ date: day(15) }).expect(409);
    await ctx.http().post(`${org.base}/fx/revaluations`).set(owner.auth).send({ date: day(40), rates: { USD: 'abc' } }).expect(422);

    const other = await createOrg(ctx, owner, { name: 'FX Other' });
    const bank = (await ctx.http().post(`${other.base}/accounts`).set(owner.auth).send({ code: '1131', name: 'SGD Bank', type: 'ASSET', subtype: 'BANK' }).expect(201)).body.id;
    expect((await ctx.http().post(`${other.base}/fx/revaluations`).set(owner.auth).send({ date: day(5) }).expect(409)).body.error).toBe('FX_NOTHING');
    await ctx.http().post(`${other.base}/journals`).set(owner.auth).send({ date: day(1), post: true, lines: [{ accountId: bank, currency: 'SGD', exchangeRate: '62', debit: '100.00' }, { accountId: other.acc['3100'], credit: '6200.00' }] }).expect(201);
    expect((await ctx.http().post(`${other.base}/fx/revaluations`).set(owner.auth).send({ date: day(5) }).expect(422)).body.error).toBe('FX_RATE_MISSING');
    expect((await ctx.http().post(`${other.base}/fx/revaluations`).set(owner.auth).send({ date: day(5), rates: { SGD: '62' } }).expect(409)).body.error).toBe('FX_NOTHING');
    await ctx.http().patch(`${other.base}/accounts/${other.acc['7200']}`).set(owner.auth).send({ isActive: false }).expect(200);
    expect((await ctx.http().post(`${other.base}/fx/revaluations`).set(owner.auth).send({ date: day(5), rates: { SGD: '63' } }).expect(409)).body.error).toBe('FX_ACCOUNT_MISSING');
  });
});
