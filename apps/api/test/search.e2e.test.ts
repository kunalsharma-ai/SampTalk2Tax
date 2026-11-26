import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { literalPattern, matchRank } from '../src/graph/record-search';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Efficient search (PERF-012): the header search finds records by part of a name or number, best
 * match first, and reads only the records it returns: each field is walked through its own index,
 * so a search that matches every invoice still fetches no more than it shows.
 */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const numbers: string[] = [];
type Found = { type: string; id: string; label: string };
const search = async (q: string, base = org.base, who = owner) =>
  (
    await ctx
      .http()
      .get(`${base}/graph/search?q=${encodeURIComponent(q)}`)
      .set(who.auth)
      .expect(200)
  ).body as Found[];

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Search Owner');
  org = await createOrg(ctx, owner, { name: 'Search Traders Pvt Ltd' });
  other = await createOrg(ctx, owner, { name: 'Other Search Co' });
  const post = async (base: string, path: string, body: Record<string, unknown>) => (await ctx.http().post(`${base}${path}`).set(owner.auth).send(body).expect(201)).body;
  const customer = (await post(org.base, '/contacts', { name: 'Zephyr Logistics (North)', isCustomer: true })).id;
  for (const name of ['Alpha Zephyr Foods', 'Zeta Traders', 'Mukherjee & Sons']) await post(org.base, '/contacts', { name, isCustomer: true });
  await post(other.base, '/contacts', { name: 'Zephyr Elsewhere', isCustomer: true });
  for (let batch = 0; batch < 4; batch++)
    await Promise.all(
      Array.from({ length: 10 }, async (_, j) => {
        const i = batch * 10 + j;
        const d = await post(org.base, '/sales/documents', {
          kind: 'INVOICE',
          contactId: customer,
          issueDate: T,
          dueDate: T,
          post: true,
          reference: i === 5 ? 'PO/7781-A' : undefined,
          lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: `${1000 + i}.00` }],
        });
        numbers.push(d.number);
      }),
    );
  numbers.sort();
  await post(org.base, '/journals', {
    date: T,
    memo: 'Quarterly rent accrual',
    reference: 'ACR-42',
    post: true,
    lines: [
      { accountId: org.acc['6400'], debit: '100.00' },
      { accountId: org.acc['1120'], credit: '100.00' },
    ],
  });
}, 120_000);
afterAll(async () => {
  await ctx?.app.close();
});

describe('finding records', () => {
  it('puts an exact number first, then numbers that start with the text', async () => {
    const exact = numbers[3]!;
    const r = await search(exact.toLowerCase());
    expect(r[0]).toMatchObject({ type: 'DOCUMENT' });
    expect(r[0]!.label).toContain(exact);
    // A prefix shared by every invoice shows the newest numbers first, at most eight.
    const prefix = exact.replace(/\d+$/, '');
    const docs = (await search(prefix)).filter((f) => f.type === 'DOCUMENT');
    expect(docs).toHaveLength(8);
    expect(docs[0]!.label).toContain(numbers[numbers.length - 1]!);
  });

  it('finds names by any part, ignoring case, starting matches first', async () => {
    const r = (await search('zephyr')).filter((f) => f.type === 'CONTACT').map((f) => f.label);
    expect(r).toEqual(['Zephyr Logistics (North)', 'Alpha Zephyr Foods']);
    expect((await search('& so')).map((f) => f.label)).toContain('Mukherjee & Sons');
    // Characters with a meaning in patterns are only text.
    expect((await search('(north)')).filter((f) => f.type === 'CONTACT').map((f) => f.label)).toEqual(['Zephyr Logistics (North)']);
    expect(await search('.*')).toEqual([]);
  });

  it('finds references, journal memos and numbers, and account codes', async () => {
    expect((await search('7781-a')).filter((f) => f.type === 'DOCUMENT')).toHaveLength(1);
    expect((await search('rent accr')).filter((f) => f.type === 'JOURNAL')).toHaveLength(1);
    expect((await search('acr-42')).filter((f) => f.type === 'JOURNAL')).toHaveLength(1);
    const accounts = (await search('410')).filter((f) => f.type === 'ACCOUNT');
    expect(accounts.length).toBeGreaterThan(0);
    for (const a of accounts) expect(a.label.startsWith('410')).toBe(true);
  });

  it("never shows another organisation's records", async () => {
    expect((await search('zephyr')).map((f) => f.label)).not.toContain('Zephyr Elsewhere');
    expect((await search('zephyr', other.base)).map((f) => f.label)).toEqual(['Zephyr Elsewhere']);
  });
});

describe('reading only what it shows', () => {
  it('walks indexes and fetches at most a page of records per field, however many match', async () => {
    const db = ctx.db;
    await db.command({ profile: 2 });
    const from = new Date();
    try {
      const prefix = numbers[0]!.replace(/\d+$/, '');
      expect((await search(prefix)).filter((f) => f.type === 'DOCUMENT')).toHaveLength(8);
    } finally {
      await db.command({ profile: 0 });
    }
    const reads = await db
      .collection('system.profile')
      .find({ ts: { $gte: from }, op: 'query', ns: { $in: ['documents', 'contacts', 'payments', 'journal_entries', 'accounts'].map((c) => `${db.databaseName}.${c}`) } })
      .toArray();
    const searches = reads.filter((r) => JSON.stringify(r.command?.filter ?? {}).includes('$regex') && JSON.stringify(r.command?.filter ?? {}).includes(org.orgId));
    expect(searches.length).toBeGreaterThanOrEqual(5);
    for (const r of searches) {
      expect(r.planSummary).not.toContain('COLLSCAN');
      expect(r.planSummary).toContain('IXSCAN');
      expect(r.docsExamined).toBeLessThanOrEqual(8);
    }
    // 40 invoices match; the four document reads (number and reference, starting and containing)
    // fetched at most a page each, and would fetch no more with 40,000.
    const docReads = searches.filter((r) => r.ns.endsWith('.documents'));
    expect(docReads).toHaveLength(4);
    expect(docReads.reduce((t, r) => t + (r.docsExamined as number), 0)).toBeLessThan(40);
  });
});

describe('the matching rules', () => {
  it('ranks exact, then starting, then containing, ignoring case', () => {
    expect(matchRank('INV-0001', 'inv-0001')).toBe(0);
    expect(matchRank('INV-0001', 'inv')).toBe(1);
    expect(matchRank('INV-0001', '0001')).toBe(2);
    expect(matchRank('INV-0001', 'bill')).toBeNull();
    expect(matchRank(null, 'x')).toBeNull();
  });
  it('escapes every pattern character', () => {
    const p = literalPattern('a.b*c(d)[e]^f$g|h?i+j{k}\\l/m-n');
    expect(new RegExp(p).test('a.b*c(d)[e]^f$g|h?i+j{k}\\l/m-n')).toBe(true);
    expect(new RegExp(`^${p}$`).test('aXb*c(d)[e]^f$g|h?i+j{k}\\l/m-n')).toBe(false);
  });
});
