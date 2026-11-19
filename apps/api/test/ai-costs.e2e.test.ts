import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tokenCost, UNKNOWN_MODEL } from '../src/ai-control/ai-control.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * AGENT-053 model costs against the real API and database: an owner sets what each model costs
 * per million input and output tokens, and the AI control center shows each agent's cost this
 * month by model at those prices, with tokens of unpriced models counted apart. Prices are
 * decimal, checked, audited and kept inside the organisation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let A: string;

interface Overview {
  currency: string;
  totals: { tokens: number; cost: string; unpricedTokens: number };
  prices: { model: string; inputPerMillion: string; outputPerMillion: string; changedBy: string }[];
  modelsUsed: string[];
  agents: { key: string; usage: { tokens: number }; cost: { amount: string; currency: string; unpricedTokens: number; models: { model: string; inputTokens: number; outputTokens: number; cost: string | null }[] } }[];
}
const overview = async (who = owner, base = A) => (await ctx.http().get(base).set(who.auth).expect(200)).body as Overview;
const copilot = (o: Overview) => o.agents.find((a) => a.key === 'COPILOT')!;
// Usage records as the report designer stores them after each model call.
const call = (model: string | null, inputTokens: number, outputTokens: number, orgId = org.orgId, by = owner.id) =>
  ctx.prisma.reportAiCall.create({ data: { orgId, kind: 'DESIGN', request: 'Synthetic request', status: 'DONE', model, inputTokens, outputTokens, createdById: by } });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Cost Owner');
  viewer = await registerUser(ctx, 'Cost Viewer');
  outsider = await registerUser(ctx, 'Cost Outsider');
  org = await createOrg(ctx, owner, { name: 'AI Costs Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Costs Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  A = `${org.base}/ai-control`;
  await call('model-large', 120_000, 30_000);
  await call('model-large', 80_000, 20_000);
  await call('model-small', 400_000, 100_000);
  await call(null, 0, 0);
  await call('model-large', 999_999, 999_999, other.orgId, outsider.id);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('model costs in the AI control center', () => {
  it('works out the cost of tokens exactly, in decimals', () => {
    expect(tokenCost(1_000_000, 0, { inputPerMillion: '3.0000', outputPerMillion: '15.0000' })).toBe('3.0000');
    expect(tokenCost(200_000, 50_000, { inputPerMillion: '5', outputPerMillion: '25' })).toBe('2.2500');
    expect(tokenCost(1, 1, { inputPerMillion: '0.1', outputPerMillion: '0.2' })).toBe('0.0000');
    expect(tokenCost(3333, 0, { inputPerMillion: '15', outputPerMillion: '0' })).toBe('0.0500');
  });

  it('shows tokens by model, with nothing priced until a price is set', async () => {
    const o = await overview();
    await ctx.http().get(A).set(viewer.auth).expect(403);
    expect(o.currency).toBe('USD');
    expect(o.prices).toEqual([]);
    expect(o.modelsUsed).toEqual([UNKNOWN_MODEL, 'model-large', 'model-small']);
    expect(copilot(o).cost).toMatchObject({ amount: '0.0000', currency: 'USD', unpricedTokens: 750_000 });
    expect(copilot(o).cost.models.find((m) => m.model === 'model-large')).toEqual({ model: 'model-large', inputTokens: 200_000, outputTokens: 50_000, cost: null });
    expect(o.totals).toMatchObject({ cost: '0.0000', unpricedTokens: 750_000 });
  });

  it('applies the prices an owner sets, and counts unpriced models apart', async () => {
    await ctx.http().put(`${A}/prices`).set(viewer.auth).send({ model: 'model-large', inputPerMillion: '5', outputPerMillion: '25' }).expect(403);
    await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-large', inputPerMillion: '-1', outputPerMillion: '25' }).expect(400);
    await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-large', inputPerMillion: '5.00001', outputPerMillion: '25' }).expect(400);
    await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-large', inputPerMillion: 5, outputPerMillion: '25' }).expect(400);
    let o = (await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-large', inputPerMillion: '5', outputPerMillion: '25' }).expect(200)).body as Overview;
    expect(o.prices).toEqual([expect.objectContaining({ model: 'model-large', inputPerMillion: '5.0000', outputPerMillion: '25.0000', changedBy: 'Cost Owner' })]);
    // 200,000 in at $5 and 50,000 out at $25 per million: $1.00 + $1.25.
    expect(copilot(o).cost).toMatchObject({ amount: '2.2500', unpricedTokens: 500_000 });
    expect(copilot(o).cost.models.find((m) => m.model === 'model-large')!.cost).toBe('2.2500');

    o = (await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-small', inputPerMillion: '0.8', outputPerMillion: '4' }).expect(200)).body as Overview;
    // 400,000 in at $0.80 and 100,000 out at $4: $0.32 + $0.40.
    expect(copilot(o).cost).toMatchObject({ amount: '2.9700', unpricedTokens: 0 });
    expect(o.totals).toMatchObject({ cost: '2.9700', unpricedTokens: 0 });

    // Changing a price is audited with what it was.
    await ctx.http().put(`${A}/prices`).set(owner.auth).send({ model: 'model-small', inputPerMillion: '1', outputPerMillion: '5' }).expect(200);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=ai_model_price&entityId=${org.orgId}`).set(owner.auth).expect(200)).body;
    const set = (audit.items ?? audit).find((e: { action: string; data: { model: string; from: unknown } }) => e.action === 'ai.model_price_set' && e.data.model === 'model-small' && e.data.from);
    expect(set.data).toMatchObject({ from: { inputPerMillion: '0.8', outputPerMillion: '4' }, to: { inputPerMillion: '1', outputPerMillion: '5' } });
  });

  it('removes a price, and keeps prices inside the organisation', async () => {
    const o = (await ctx.http().post(`${A}/prices/remove`).set(owner.auth).send({ model: 'model-small' }).expect(200)).body as Overview;
    expect(o.prices.map((p) => p.model)).toEqual(['model-large']);
    expect(copilot(o).cost).toMatchObject({ amount: '2.2500', unpricedTokens: 500_000 });
    expect((await ctx.http().post(`${A}/prices/remove`).set(owner.auth).send({ model: 'model-small' }).expect(404)).body.error).toBe('PRICE_NOT_FOUND');

    const theirs = await overview(outsider, `${other.base}/ai-control`);
    expect(theirs.prices).toEqual([]);
    expect(copilot(theirs).cost).toMatchObject({ amount: '0.0000', unpricedTokens: 1_999_998 });
    await ctx.http().put(`${other.base}/ai-control/prices`).set(owner.auth).send({ model: 'model-large', inputPerMillion: '1', outputPerMillion: '1' }).expect(404);
  });
});
