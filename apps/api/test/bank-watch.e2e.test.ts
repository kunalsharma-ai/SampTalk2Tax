import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Bank account watch (BANK-014) against the real API and database: an overdrawn bank account,
 * one below the set minimum, and one not reconciled for too long each raise an alert, which
 * clears once the cause is fixed.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Alert { rule: string; severity: string; title: string; summary: string; amount: string | null; evidence: { facts: { label: string; value: string }[]; links: { kind: string; path?: string }[] } }
const watch = async () => {
  await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
  return ((await ctx.http().get(`${org.base}/alerts`).query({ status: 'ACTIVE' }).set(owner.auth).expect(200)).body.alerts as Alert[]).filter((a) => a.rule === 'BANK_ACCOUNT_WATCH');
};
const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Bank watch test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const rule = (params: Record<string, string>, enabled = true) => ctx.http().put(`${org.base}/alert-rules/BANK_ACCOUNT_WATCH`).set(owner.auth).send({ enabled, params }).expect(200);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Watch Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('bank account watch', () => {
  it('is a listed rule with its settings', async () => {
    const rules = (await ctx.http().get(`${org.base}/alert-rules`).set(owner.auth).expect(200)).body as { key: string; params: { key: string }[] }[];
    const r = rules.find((x) => x.key === 'BANK_ACCOUNT_WATCH')!;
    expect(r.params.map((p) => p.key)).toEqual(['minBalance', 'unreconciledDays']);
  });

  it('finds nothing on accounts without activity', async () => {
    await rule({ minBalance: '0', unreconciledDays: '10' });
    expect(await watch()).toEqual([]);
  });

  it('flags an overdrawn account and one never reconciled', async () => {
    await journal(addDays(T, -20), '1120', '4100', '50000.00');
    await journal(T, '6200', '1120', '62500.00');
    const found = await watch();
    const over = found.find((a) => a.title.includes('overdrawn'))!;
    expect(over.severity).toBe('CRITICAL');
    expect(over.amount).toBe('12500');
    expect(over.evidence.links[0].path).toBe(`/banking/${org.acc['1120']}/reconcile`);
    const stale = found.find((a) => a.title.includes('not reconciled'))!;
    expect(stale.severity).toBe('WARNING');
    expect(stale.title).toMatch(/for 20 days/);
    expect(stale.summary).toMatch(/never been reconciled/);
    expect(found).toHaveLength(2);
  });

  it('warns below the minimum, and clears when fixed or the limit is raised', async () => {
    await journal(T, '1120', '4100', '20000.00');
    await rule({ minBalance: '10000', unreconciledDays: '30' });
    let found = await watch();
    expect(found.map((a) => a.title)).toEqual([expect.stringMatching(/down to/)]);
    expect(found[0].severity).toBe('WARNING');
    expect(found[0].title).toMatch(/down to/);
    expect(found[0].amount).toBe('2500');
    await journal(T, '1120', '4100', '5000.00');
    found = await watch();
    expect(found).toEqual([]);
  });

  it('stops when the rule is turned off', async () => {
    await journal(T, '6200', '1120', '99000.00');
    expect((await watch()).length).toBe(1);
    await rule({}, false);
    expect(await watch()).toEqual([]);
  });
});
