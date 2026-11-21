import { randomUUID } from 'node:crypto';
import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Intelligent collection prioritisation (AR-034) against the real API and database: customers
 * ranked by money to chase, age, chance of paying late and the last reminder sent, disputed
 * amounts left out (a fully disputed balance says to settle the dispute), a friendly note for an
 * invoice due soon and likely late, permissions and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });

const invoice = async (who: string, issueDate: string, amount: string, dueIn = 30) => {
  const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, dueIn), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; number: string };
};
const receipt = (who: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
type Row = { contactId: string; name: string; rank: number; score: number; action: string; actionLabel: string; toChase: string; overdue: string; disputed: string; oldestOverdueDays: number; lastReminderOn: string | null; factors: { key: string; points: number; detail: string }[]; invoices: { number: string; disputed: string }[] };
type Res = { asOf: string; summary: { customers: number; toChase: string; disputed: string; callNow: number }; customers: Row[] };
const get = (user = owner) => ctx.http().get(`${org.base}/collection-priorities`).set(user.auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Chase Owner');
  viewer = await registerUser(ctx, 'Chase Viewer');
  outsider = await registerUser(ctx, 'Chase Outsider');
  org = await createOrg(ctx, owner, { name: 'Chase Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Chase Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Mills', 'Elm Stores']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true, email: `ap@${name.split(' ')[0]!.toLowerCase()}.test` }).expect(201)).body.id;
  // Payment history: Elm pays forty days late, three times.
  for (let k = 0; k < 3; k++) {
    const issued = addDays(T, -200 - k * 30);
    await receipt('Elm Stores', addDays(issued, 70), (await invoice('Elm Stores', issued, '1000.00')).id, '1000.00');
  }
  // Asha: 80,000 seventy-five days past due. Banyan: 50,000 forty days past due, reminded three days ago.
  await invoice('Asha Traders', addDays(T, -105), '80000.00');
  await invoice('Banyan Retail', addDays(T, -70), '50000.00');
  const run = randomUUID();
  await raw(`INSERT INTO collection_runs (id, org_id, status, started_by_id, skipped, model, created_at, finished_at) VALUES ($3::uuid, $1::uuid, 'DONE', $2::uuid, '[]', 'scripted', now(), now())`, org.orgId, owner.id, run);
  await raw(`INSERT INTO collection_drafts (id, org_id, run_id, contact_id, status, to_email, facts, model, risk, ai_subject, ai_body, subject, body, decided_by_id, decided_at, send_attempts, sent_at, updated_at) VALUES (gen_random_uuid(), $1::uuid, $3::uuid, $2::uuid, 'SENT', 'ap@banyan.test', '{}', 'scripted', 'HIGH', 'Overdue', 'Please pay', 'Overdue', 'Please pay', $4::uuid, now() - interval '3 days', 1, now() - interval '3 days', now())`, org.orgId, c['Banyan Retail'], run, owner.id);
  // Cedar: 20,000 ten days past due, all of it disputed.
  const cedar = await invoice('Cedar Foods', addDays(T, -40), '20000.00');
  await ctx.http().post(`${org.base}/sales/disputes`).set(owner.auth).send({ documentId: cedar.id, reason: 'QUALITY', description: 'Damaged on arrival' }).expect(201);
  // Deodar: nothing overdue, one invoice due in five days. Elm: an invoice due in five days, likely late.
  await invoice('Deodar Mills', T, '9000.00', 25);
  await invoice('Elm Stores', addDays(T, -25), '6000.00');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('collection priorities', () => {
  it('ranks customers by who to chase first, with the points and a suggested action', async () => {
    const r = (await get(viewer).expect(200)).body as Res;
    expect(r.asOf).toBe(T);
    const by = Object.fromEntries(r.customers.map((x) => [x.name, x]));
    expect(r.customers.map((x) => x.name)).toEqual(['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Elm Stores']);
    expect(r.customers.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
    expect(by['Asha Traders']).toMatchObject({ score: 90, action: 'CALL_AND_HOLD', actionLabel: 'Call, and consider a credit hold', toChase: '80000.00', oldestOverdueDays: 75, lastReminderOn: null });
    expect(by['Asha Traders']!.factors.map((f) => f.points)).toEqual([40, 20, 20, 0, 10]);
    expect(by['Banyan Retail']).toMatchObject({ action: 'WAIT', toChase: '50000.00', oldestOverdueDays: 40, lastReminderOn: addDays(T, -3) });
    expect(by['Banyan Retail']!.factors.find((f) => f.key === 'NOT_CONTACTED')).toMatchObject({ points: 0, detail: 'Last reminder 3 days ago' });
    expect(by['Elm Stores']).toMatchObject({ action: 'NUDGE', toChase: '0.00', oldestOverdueDays: 0 });
    expect(by['Elm Stores']!.factors.find((f) => f.key === 'DUE_SOON')!.points).toBe(5);
    expect(by['Cedar Foods']).toMatchObject({ action: 'SETTLE_DISPUTE', toChase: '0.00', disputed: '20000.00', overdue: '20000.00' });
    expect(by['Cedar Foods']!.invoices[0]!.disputed).toBe('20000.00');
    expect(r.customers.some((x) => x.name === 'Deodar Mills')).toBe(false);
    expect(r.summary).toEqual({ customers: 4, toChase: '130000.00', disputed: '20000.00', callNow: 1 });
  });

  it('keeps to the organisation', async () => {
    await ctx.http().get(`${org.base}/collection-priorities`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/collection-priorities`).set(outsider.auth).expect(200)).body as Res;
    expect(theirs).toMatchObject({ customers: [], summary: { customers: 0, toChase: '0.00', disputed: '0.00', callNow: 0 } });
  });
});
