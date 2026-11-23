import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Arranging a dashboard by drag and drop against the real API and database (RPT-026): moving
 * widgets, dropping metrics in as figures or onto charts and tables, removing widgets, the
 * checks that refuse a drop that makes no sense, versions so two people cannot overwrite each
 * other, the audit trail, permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let id: string;
const D = () => `${org.base}/dashboards`;
const config = {
  widgets: [
    { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' },
    { type: 'BAR', title: 'Profit', metrics: ['grossProfit'], months: 3 },
    { type: 'TABLE', title: 'Margins', metrics: ['grossMargin'], months: 3 },
  ],
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Layout Owner');
  viewer = await registerUser(ctx, 'Layout Viewer');
  outsider = await registerUser(ctx, 'Layout Outsider');
  org = await createOrg(ctx, owner, { name: 'Layout Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Layout Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  id = (await ctx.http().post(D()).set(owner.auth).send({ name: 'Arranged', config }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('arranging a dashboard (RPT-026)', () => {
  it('saves drops and moves as a new version with figures and an audit event', async () => {
    const r = (
      await ctx
        .http()
        .post(`${D()}/${id}/layout`)
        .set(owner.auth)
        .send({
          baseVersion: 1,
          ops: [
            { op: 'dropMetric', metric: 'cash', target: { kind: 'new', at: 0 } },
            { op: 'dropMetric', metric: 'netIncome', target: { kind: 'into', index: 2 } },
            { op: 'dropMetric', metric: 'currentRatio', target: { kind: 'into', index: 3 } },
            { op: 'move', from: 3, to: 1 },
          ],
        })
        .expect(200)
    ).body;
    expect(r.version).toBe(2);
    expect(r.config.widgets.map((w: { title: string }) => w.title)).toEqual(['Cash and bank', 'Margins', 'Revenue', 'Profit']);
    expect(r.config.widgets[1].metrics).toEqual(['grossMargin', 'currentRatio']);
    expect(r.config.widgets[3].metrics).toEqual(['grossProfit', 'netIncome']);
    // figures come back for the new layout, worked out from the books
    expect(r.widgets[0]).toMatchObject({ type: 'STAT', metric: { key: 'cash' } });
    expect(r.widgets[0].value).toBe('0.00');
    expect(r.widgets[3].metrics.map((m: { key: string }) => m.key)).toEqual(['grossProfit', 'netIncome']);
    // everyone in the organisation sees the saved layout
    const seen = (await ctx.http().get(`${D()}/${id}`).set(viewer.auth).expect(200)).body;
    expect(seen.config).toEqual(r.config);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'dashboard', action: 'dashboard.arranged' }, select: { data: true, actorId: true } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(owner.id);
    expect((audit[0]!.data as { ops: unknown[]; version: number }).ops).toHaveLength(4);
    expect((audit[0]!.data as { version: number }).version).toBe(2);
  });

  it('refuses drops that make no sense and changes nothing', async () => {
    const mixed = await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'dropMetric', metric: 'grossMargin', target: { kind: 'into', index: 3 } }] }).expect(422);
    expect(mixed.body.message).toBe('Profit shows amounts; Gross margin is measured in percentages, so it needs its own chart');
    const unknown = await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'dropMetric', metric: 'magic', target: { kind: 'new', at: 0 } }] }).expect(422);
    expect(unknown.body.message).toBe('"magic" is not an approved metric');
    const far = await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'move', from: 0, to: 9 }] }).expect(422);
    expect(far.body.message).toBe('A widget can only move to a position from 1 to 4');
    await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [] }).expect(400);
    await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'shuffle' }] }).expect(400);
    // too many widgets
    const many = Array.from({ length: 9 }, (_, i) => ({ op: 'dropMetric', metric: 'revenue', target: { kind: 'new', at: i } }));
    const full = await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: many }).expect(422);
    expect(full.body.message).toBe('Change 9: A dashboard holds at most 12 widgets; remove one first');
    expect((await ctx.http().get(`${D()}/${id}`).set(owner.auth).expect(200)).body.version).toBe(2);
  });

  it('removes a widget and stops two people overwriting each other', async () => {
    const r = (await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'remove', index: 1 }] }).expect(200)).body;
    expect(r.version).toBe(3);
    expect(r.config.widgets.map((w: { title: string }) => w.title)).toEqual(['Cash and bank', 'Revenue', 'Profit']);
    const stale = await ctx.http().post(`${D()}/${id}/layout`).set(owner.auth).send({ baseVersion: 2, ops: [{ op: 'move', from: 0, to: 1 }] }).expect(409);
    expect(stale.body.error).toBe('DASHBOARD_CHANGED');
  });

  it('needs dashboards.manage and keeps organisations apart', async () => {
    await ctx.http().post(`${D()}/${id}/layout`).set(viewer.auth).send({ baseVersion: 3, ops: [{ op: 'move', from: 0, to: 1 }] }).expect(403);
    await ctx.http().post(`${D()}/${id}/layout`).set(outsider.auth).send({ baseVersion: 3, ops: [{ op: 'move', from: 0, to: 1 }] }).expect(404);
    await ctx.http().post(`${other.base}/dashboards/${id}/layout`).set(outsider.auth).send({ baseVersion: 3, ops: [{ op: 'move', from: 0, to: 1 }] }).expect(404);
    expect((await ctx.http().get(`${D()}/${id}`).set(owner.auth).expect(200)).body.version).toBe(3);
  });
});
