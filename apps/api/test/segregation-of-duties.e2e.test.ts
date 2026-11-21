import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDbDate } from '../src/common/dates';
import { runInOrg } from '../src/common/tenant-context';
import { bankReconciliations } from '../src/db/collections/banking';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Segregation-of-duties checks (AUDIT-014) against the real API and database: journals and bills
 * prepared and posted by one person, a vendor paid by whoever changed their bank details, a bank
 * reconciled by whoever recorded its payments; the duties each member's role holds; a finding
 * cleared only by someone not involved, with a reason, once, audited; permissions and tenants.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
type Finding = { key: string; rule: string; date: string; people: { id: string; name: string }[]; subject: { type: string; label: string }; involvesMe: boolean; review: { reason: string; by: { name: string } } | null };
type Overview = { from: string; to: string; findings: Finding[]; rules: { id: string; open: number; reviewed: number }[]; members: { name: string; role: string; conflicts: { id: string }[] }[]; canReview: boolean };
const S = () => `${org.base}/segregation-of-duties`;
const je = (amount: string, post: boolean) => ({ date: T, post, lines: [{ accountId: org.acc['6200'], debit: amount }, { accountId: org.acc['1120'], credit: amount }] });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Duties Owner');
  accountant = await registerUser(ctx, 'Duties Accountant');
  approver = await registerUser(ctx, 'Duties Approver');
  viewer = await registerUser(ctx, 'Duties Viewer');
  outsider = await registerUser(ctx, 'Duties Outsider');
  org = await createOrg(ctx, owner, { name: 'Duties Test Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Duties Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);

  // The accountant writes and posts a journal alone; another is posted by the approver.
  await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je('1200.00', true)).expect(201);
  const draft = (await ctx.http().post(`${org.base}/journals`).set(accountant.auth).send(je('300.00', false)).expect(201)).body;
  await ctx.http().post(`${org.base}/journals/${draft.id}/post`).set(approver.auth).expect(200);
  // A bill entered and posted by the accountant.
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Quartz Supplies', isVendor: true }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/purchases/documents`).set(accountant.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '4000' }] }).expect(201);
  // The accountant changes Quartz's bank details, then pays them.
  await ctx.http().put(`/v1/orgs/${org.orgId}/contacts/${vendor}/bank-details`).set(accountant.auth).send({ accountName: 'Quartz Supplies LLP', accountNumber: '000987654321', ifsc: 'HDFC0001234' }).expect(200);
  await ctx.http().post(`${org.base}/purchases/payments`).set(accountant.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount: '4000.00' }).expect(201);
  // The same person then reconciles that bank account over the period.
  await runInOrg(org.orgId, () =>
    ctx.store.collection(bankReconciliations).insertOne({ accountId: org.acc['1120']!, startDate: toDbDate(`${T.slice(0, 7)}-01`), statementDate: toDbDate(T), openingBalance: '0', statementBalance: '0', ledgerBalance: '0', uncleared: '0', status: 'COMPLETED', completedById: accountant.id, completedAt: new Date(), undoneById: null, undoneAt: null, undoReason: null }),
  );
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('segregation-of-duties checks', () => {
  let found: Overview;

  it('finds each place one person did two jobs that should be split', async () => {
    found = (await ctx.http().get(S()).set(approver.auth).expect(200)).body;
    expect(found.to).toBe(T);
    expect(found.findings.map((f) => [f.rule, f.people.map((p) => p.name)]).sort()).toEqual([
      ['BANK_DETAILS_CHANGED_THEN_PAID', ['Duties Accountant']],
      ['RECONCILED_OWN_PAYMENTS', ['Duties Accountant']],
      ['SELF_POSTED_BILL', ['Duties Accountant']],
      ['SELF_POSTED_JOURNAL', ['Duties Accountant']],
    ]);
    expect(found.findings.find((f) => f.rule === 'SELF_POSTED_JOURNAL')!.subject.label).toMatch(/^Journal #\d+$/);
    expect(found.rules.find((r) => r.id === 'SELF_POSTED_JOURNAL')).toMatchObject({ open: 1, reviewed: 0 });
    expect(found.canReview).toBe(true);
    // A period before any of it finds nothing.
    expect((await ctx.http().get(`${S()}?from=2020-01-01&to=2020-12-31`).set(approver.auth).expect(200)).body.findings).toEqual([]);
    expect((await ctx.http().get(`${S()}?from=2026-02-01&to=2026-01-01`).set(approver.auth).expect(422)).body.error).toBe('INVALID_PERIOD');
    expect((await ctx.http().get(`${S()}?from=2020-01-01&to=2026-01-01`).set(approver.auth).expect(422)).body.error).toBe('PERIOD_TOO_LONG');
  });

  it('names the conflicting duties each member’s role holds', async () => {
    const byName = Object.fromEntries(found.members.map((m) => [m.name, m.conflicts.map((c) => c.id)]));
    expect(byName['Duties Accountant']).toEqual(['PREPARE_AND_POST_JOURNALS', 'VENDORS_AND_PAYMENTS', 'PAY_AND_RECONCILE', 'PAYROLL_AND_POST']);
    expect(byName['Duties Approver']).toEqual([]);
    expect(byName['Duties Viewer']).toBeUndefined();
  });

  it('lets only someone not involved clear a finding, with a reason, once', async () => {
    const f = found.findings.find((x) => x.rule === 'SELF_POSTED_JOURNAL')!;
    const send = (who: TestUser, body: object, status: number) => ctx.http().post(`${S()}/reviews`).set(who.auth).send(body).expect(status);
    await send(viewer, { key: f.key, date: f.date, reason: 'Looked at the support for it' }, 403);
    await send(accountant, { key: f.key, date: f.date, reason: 'Looked at the support for it' }, 403);
    expect((await send(approver, { key: f.key, date: '2020-01-01', reason: 'Looked at the support for it' }, 404)).body.error).toBe('NOT_FOUND');
    await send(approver, { key: f.key, date: f.date, reason: 'short' }, 400);
    await send(approver, { key: f.key, date: f.date, reason: 'Checked the accrual schedule behind it' }, 201);
    expect((await send(owner, { key: f.key, date: f.date, reason: 'Checked the accrual schedule again' }, 409)).body.error).toBe('ALREADY_REVIEWED');
    await ctx.http().get(S()).set(viewer.auth).expect(403);
    const o = (await ctx.http().get(S()).set(owner.auth).expect(200)).body as Overview;
    expect(o.findings.find((x) => x.key === f.key)!.review).toMatchObject({ reason: 'Checked the accrual schedule behind it', by: { name: 'Duties Approver' } });
    expect(o.rules.find((r) => r.id === 'SELF_POSTED_JOURNAL')).toMatchObject({ open: 0, reviewed: 1 });
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=sod_review`).set(owner.auth).expect(200)).body;
    expect(((audit.items ?? audit) as { action: string; data: { finding: string } }[]).map((e) => [e.action, e.data.finding])).toEqual([['sod.finding_reviewed', f.key]]);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(S()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/segregation-of-duties`).set(outsider.auth).expect(200)).body.findings).toEqual([]);
    const f = found.findings[0]!;
    expect((await ctx.http().post(`${other.base}/segregation-of-duties/reviews`).set(outsider.auth).send({ key: f.key, date: f.date, reason: 'Reviewing someone else’s books' }).expect(404)).body.error).toBe('NOT_FOUND');
  });
});
