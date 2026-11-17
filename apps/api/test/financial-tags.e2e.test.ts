import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Financial tags (GL-031) and locations (GL-028) against the real API and database: defining a
 * tag and its values, journal lines checked against them, profit split by a tag (untagged lines
 * included so the columns add up), switching values off, and the audit trail.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const FROM = `${T.slice(0, 7)}-01`;

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let F: string;
let locationId: string;

const journal = (lines: Record<string, unknown>[], memo = 'Test') => ({ date: T, memo, post: true, lines });
const post = (lines: Record<string, unknown>[], status = 201) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send(journal(lines)).expect(status);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tag Owner');
  viewer = await registerUser(ctx, 'Tag Viewer');
  org = await createOrg(ctx, owner, { name: 'Tags Pvt Ltd' });
  F = `${org.base}/financial-tags`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('financial tags', () => {
  it('defines a location tag with values, offering the presets not yet used', async () => {
    const before = (await ctx.http().get(F).set(viewer.auth).expect(200)).body;
    expect(before.items).toEqual([]);
    expect(before.presets.map((p: { key: string }) => p.key)).toContain('location');
    await ctx.http().post(F).set(viewer.auth).send({ key: 'location', label: 'Location', values: [] }).expect(403);
    const bad = (await ctx.http().post(F).set(owner.auth).send({ key: 'Location!', label: 'Location', values: [{ code: 'PUNE', name: 'Pune' }, { code: 'pune', name: 'Pune again' }] }).expect(422)).body;
    expect(bad.error).toBe('TAG_INVALID');
    expect(bad.details.issues).toEqual(expect.arrayContaining(['Value code PUNE is used twice']));
    const t = (await ctx.http().post(F).set(owner.auth).send({ key: 'location', label: 'Location', values: [{ code: 'pune', name: 'Pune office' }, { code: 'MUM', name: 'Mumbai store' }] }).expect(201)).body;
    locationId = t.id;
    expect(t).toMatchObject({ key: 'location', label: 'Location', isActive: true, values: [{ code: 'PUNE', name: 'Pune office', isActive: true }, { code: 'MUM', name: 'Mumbai store', isActive: true }] });
    expect((await ctx.http().post(F).set(owner.auth).send({ key: 'location', label: 'Again', values: [] }).expect(409)).body.error).toBe('TAG_EXISTS');
    const after = (await ctx.http().get(F).set(viewer.auth).expect(200)).body;
    expect(after.items).toHaveLength(1);
    expect(after.presets.map((p: { key: string }) => p.key)).not.toContain('location');
  });

  it('checks journal lines against the defined values, leaving undefined keys free', async () => {
    const lines = (loc: string, extra: Record<string, string> = {}) => [
      { accountId: org.acc['6100'], debit: '1000.00', dimensions: { location: loc, ...extra } },
      { accountId: org.acc['1120'], credit: '1000.00' },
    ];
    expect((await post(lines('DELHI'), 422)).body).toMatchObject({ error: 'INVALID_TAG', message: 'Line 1: DELHI is not a Location' });
    await post(lines('PUNE', { campaign: 'diwali' }));
  });

  it('splits profit by location, with untagged lines in their own column', async () => {
    const sale = (amount: string, loc?: string) => [
      { accountId: org.acc['1120'], debit: amount },
      { accountId: org.acc['4100'], credit: amount, ...(loc ? { dimensions: { location: loc } } : {}) },
    ];
    await post(sale('5000.00', 'PUNE'));
    await post(sale('3000.00', 'MUM'));
    await post(sale('700.00'));
    await post([
      { accountId: org.acc['6100'], debit: '400.00', dimensions: { location: 'MUM' } },
      { accountId: org.acc['1120'], credit: '400.00' },
    ]);
    const r = (await ctx.http().get(`${org.base}/reports/profit-by-tag?key=location&from=${FROM}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(r.tag).toEqual({ key: 'location', label: 'Location' });
    expect(r.columns).toEqual([
      { code: 'PUNE', name: 'Pune office', revenue: '5000.00', expenses: '1000.00', netIncome: '4000.00' },
      { code: 'MUM', name: 'Mumbai store', revenue: '3000.00', expenses: '400.00', netIncome: '2600.00' },
      { code: null, name: 'Not tagged', revenue: '700.00', expenses: '0.00', netIncome: '700.00' },
    ]);
    expect(r.total).toEqual({ revenue: '8700.00', expenses: '1400.00', netIncome: '7300.00' });
    const income = (await ctx.http().get(`${org.base}/reports/income-statement?from=${FROM}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(income.netIncome).toBe('7300.00');
    const sales = r.rows.find((x: { code: string }) => x.code === '4100');
    expect(sales).toMatchObject({ type: 'REVENUE', amounts: ['5000.00', '3000.00', '700.00'], total: '8700.00' });
    await ctx.http().get(`${org.base}/reports/profit-by-tag?key=region&from=${FROM}&to=${T}`).set(viewer.auth).expect(404);
  });

  it('switches a value off instead of removing it, and refuses it on new lines', async () => {
    const removed = (await ctx.http().put(`${F}/${locationId}`).set(owner.auth).send({ label: 'Location', values: [{ code: 'PUNE', name: 'Pune office' }] }).expect(422)).body;
    expect(removed.details.issues[0]).toBe('Value MUM may be on journal lines: switch it off instead of removing it');
    const t = (await ctx.http().put(`${F}/${locationId}`).set(owner.auth).send({ label: 'Site', values: [{ code: 'PUNE', name: 'Pune office' }, { code: 'MUM', name: 'Mumbai store', isActive: false }, { code: 'BLR', name: 'Bengaluru' }] }).expect(200)).body;
    expect(t.label).toBe('Site');
    expect(t.values.map((v: { code: string; isActive: boolean }) => `${v.code}:${v.isActive}`)).toEqual(['PUNE:true', 'MUM:false', 'BLR:true']);
    const lines = [
      { accountId: org.acc['6100'], debit: '10.00', dimensions: { location: 'MUM' } },
      { accountId: org.acc['1120'], credit: '10.00' },
    ];
    expect((await post(lines, 422)).body.message).toBe('Line 1: Site MUM is inactive');
    // Old lines keep their name in the report.
    const r = (await ctx.http().get(`${org.base}/reports/profit-by-tag?key=location&from=${FROM}&to=${T}`).set(viewer.auth).expect(200)).body;
    expect(r.columns.map((c: { name: string }) => c.name)).toEqual(['Pune office', 'Mumbai store', 'Not tagged']);
    await ctx.http().put(`${F}/${locationId}`).set(owner.auth).send({ label: 'Site', isActive: false, values: t.values }).expect(200);
    expect((await post(lines, 422)).body.message).toBe('Line 1: the Site tag is no longer used');
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'financial_tag' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['financial_tag.created', 'financial_tag.updated', 'financial_tag.updated']);
  });
});
