import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Report templates (RPT-030) and report design version history (RPT-039) against the real API
 * and database: a design started from a template, every saved version kept as it was, an earlier
 * version restored as a new one, the history kept after the design is deleted, permissions and
 * tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
type Version = { version: number; name: string; change: string; restoredFrom: number | null; templateId: string | null; sections: number; current: boolean };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Templates Owner');
  accountant = await registerUser(ctx, 'Templates Accountant');
  viewer = await registerUser(ctx, 'Templates Viewer');
  outsider = await registerUser(ctx, 'Templates Outsider');
  org = await createOrg(ctx, owner, { name: 'Templates Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Templates Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

const R = () => `${org.base}/report-designer`;
const versions = async (id: string, who = viewer) => (await ctx.http().get(`${R()}/designs/${id}/versions`).set(who.auth).expect(200)).body as { current: number; items: Version[] };

describe('report templates and version history', () => {
  let id: string;

  it('lists the templates and starts a design from one', async () => {
    const cat = (await ctx.http().get(`${R()}/catalogue`).set(viewer.auth).expect(200)).body;
    expect(cat.templates.map((t: { id: string }) => t.id)).toEqual(['MANAGEMENT_PACK', 'BOARD_REPORT', 'INVESTOR_UPDATE', 'CASH_AND_COLLECTIONS']);
    expect(cat.templates[0].sections.length).toBeGreaterThan(5);

    await ctx.http().post(`${R()}/designs/from-template`).set(viewer.auth).send({ templateId: 'BOARD_REPORT' }).expect(403);
    await ctx.http().post(`${R()}/designs/from-template`).set(accountant.auth).send({ templateId: 'NOPE' }).expect(404);
    const d = (await ctx.http().post(`${R()}/designs/from-template`).set(accountant.auth).send({ templateId: 'BOARD_REPORT' }).expect(201)).body;
    expect(d).toMatchObject({ name: 'Board report', version: 1 });
    id = d.id;
    expect((await ctx.http().post(`${R()}/designs/from-template`).set(accountant.auth).send({ templateId: 'BOARD_REPORT' }).expect(409)).body.error).toBe('DUPLICATE');
    const named = (await ctx.http().post(`${R()}/designs/from-template`).set(accountant.auth).send({ templateId: 'BOARD_REPORT', name: 'Board report (short)' }).expect(201)).body;
    expect(named.name).toBe('Board report (short)');
    expect((await versions(id)).items).toMatchObject([{ version: 1, change: 'FROM_TEMPLATE', templateId: 'BOARD_REPORT', current: true }]);
  });

  it('keeps every saved version as it was', async () => {
    const v1 = (await ctx.http().get(`${R()}/designs/${id}/versions/1`).set(viewer.auth).expect(200)).body;
    const shorter = { sections: v1.layout.sections.slice(0, 3) };
    await ctx.http().put(`${R()}/designs/${id}`).set(accountant.auth).send({ name: 'Board report', layout: shorter, baseVersion: 1 }).expect(200);
    await ctx.http().put(`${R()}/designs/${id}`).set(accountant.auth).send({ name: 'Board pack', layout: shorter, baseVersion: 2 }).expect(200);
    const h = await versions(id);
    expect(h.current).toBe(3);
    expect(h.items.map((v) => [v.version, v.name, v.change, v.sections, v.current])).toEqual([
      [3, 'Board pack', 'EDITED', 3, true],
      [2, 'Board report', 'EDITED', 3, false],
      [1, 'Board report', 'FROM_TEMPLATE', v1.layout.sections.length, false],
    ]);
    const again = (await ctx.http().get(`${R()}/designs/${id}/versions/1`).set(viewer.auth).expect(200)).body;
    expect(again).toMatchObject({ version: 1, current: false, layout: v1.layout });
    expect(again.descriptions.length).toBe(v1.layout.sections.length);
    await ctx.http().get(`${R()}/designs/${id}/versions/9`).set(viewer.auth).expect(404);
  });

  it('restores an earlier version as a new one', async () => {
    await ctx.http().post(`${R()}/designs/${id}/versions/1/restore`).set(viewer.auth).send({ baseVersion: 3 }).expect(403);
    expect((await ctx.http().post(`${R()}/designs/${id}/versions/1/restore`).set(accountant.auth).send({ baseVersion: 2 }).expect(409)).body.error).toBe('DESIGN_CHANGED');
    expect((await ctx.http().post(`${R()}/designs/${id}/versions/3/restore`).set(accountant.auth).send({ baseVersion: 3 }).expect(409)).body.error).toBe('ALREADY_CURRENT');
    const d = (await ctx.http().post(`${R()}/designs/${id}/versions/1/restore`).set(accountant.auth).send({ baseVersion: 3 }).expect(200)).body;
    const v1 = (await ctx.http().get(`${R()}/designs/${id}/versions/1`).set(viewer.auth).expect(200)).body;
    expect(d).toMatchObject({ version: 4, name: 'Board report', layout: v1.layout });
    expect((await versions(id)).items[0]).toMatchObject({ version: 4, change: 'RESTORED', restoredFrom: 1, current: true });
  });

  it('keeps the history after the design is deleted, and apart between organisations', async () => {
    await ctx.http().get(`${other.base}/report-designer/designs/${id}/versions`).set(outsider.auth).expect(404);
    await ctx.http().delete(`${R()}/designs/${id}`).set(accountant.auth).expect(204);
    await ctx.http().get(`${R()}/designs/${id}/versions`).set(viewer.auth).expect(404);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=report_design&entityId=${id}`).set(owner.auth).expect(200)).body;
    const actions = ((audit.items ?? audit) as { action: string }[]).map((e) => e.action).sort();
    expect(actions).toEqual(['report_design.created', 'report_design.deleted', 'report_design.restored', 'report_design.updated', 'report_design.updated']);
  });
});
