import { taxYearOf } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Tax audit preparation (TAX-051) against the real API and database, for the last financial year:
 * open months, a draft journal, fixed assets without depreciation, cash payments over 10,000 in a
 * day and no income tax computation; then fixing what is missing, explaining what needs attention,
 * marking the year ready, the frozen notes, the CSV export and reopening; validation, permissions
 * and tenants.
 */
const current = taxYearOf(today());
const P = Number(current.from.slice(0, 4)) - 1;
const LAST = taxYearOf(`${P}-04-01`);
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let us: Awaited<ReturnType<typeof createOrg>>;
let draftId: string;
const R = () => `${org.base}/tax/audit-preparation`;
type Check = { key: string; status: string; detail: string; items: string[]; note: { text: string; by: string } | null };
const statuses = (r: { checks: Check[] }) => Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
const journal = (date: string, debit: string, credit: string, amount: string, post = true) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post, memo: 'Preparation test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Preparation Owner');
  accountant = await registerUser(ctx, 'Preparation Accountant');
  viewer = await registerUser(ctx, 'Preparation Viewer');
  org = await createOrg(ctx, owner, { name: 'Prepared Traders Pvt Ltd' });
  us = await createOrg(ctx, owner, { name: 'US Prep Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: P + 1 });
  await journal(`${P}-05-05`, '1120', '4100', '2000000.00');
  await journal(`${P}-06-01`, '1510', '1120', '500000.00');
  draftId = (await journal(`${P}-11-11`, '6600', '1120', '1000.00', false)).body.id;
  const kirana = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Local Kirana', isVendor: true }).expect(201)).body.id;
  for (const amount of ['6000.00', '5000.00']) await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: kirana, date: `${P}-06-03`, bankAccountId: org.acc['1110'], amount, allocations: [] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('tax audit preparation', () => {
  it('lists what is missing and what needs attention for the last financial year', async () => {
    const r = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ taxYear: LAST.label, from: LAST.from, to: LAST.to, yearEnded: true, status: 'OPEN', ready: null, reopened: null });
    expect(statuses(r)).toEqual({
      PERIODS_LOCKED: 'MISSING',
      YEAR_CLOSED: 'ATTENTION',
      NO_DRAFTS: 'MISSING',
      BANK_RECONCILED: 'NOT_APPLICABLE',
      RETURNS_FILED: 'NOT_APPLICABLE',
      FILING_PROOF: 'NOT_APPLICABLE',
      CASH_PAYMENTS: 'ATTENTION',
      CASH_RECEIPTS: 'READY',
      TDS_ON_TIME: 'NOT_APPLICABLE',
      DEPRECIATION: 'ATTENTION',
      INCOME_COMPUTATION: 'MISSING',
    });
    const by = (k: string) => r.checks.find((c: Check) => c.key === k)!;
    expect(by('PERIODS_LOCKED').detail).toBe('12 months of 12 still open: lock them so the audited figures cannot change.');
    expect(by('NO_DRAFTS').detail).toBe('1 draft journal and 0 draft invoices or bills are dated in the year: post or delete them.');
    expect(by('CASH_PAYMENTS').detail).toContain('11000.00');
    expect(by('DEPRECIATION').detail).toBe('Fixed assets of 500000.00 at cost, but no depreciation is posted for the year.');
    expect(r.summary).toEqual({ ready: 1, attention: 3, missing: 3, notApplicable: 4 });
    expect(r.blockers).toHaveLength(6);
  });

  it('will not mark the year ready while anything is missing or unexplained', async () => {
    await ctx.http().post(`${R()}/${LAST.label}/ready`).set(viewer.auth).expect(403);
    const res = await ctx.http().post(`${R()}/${LAST.label}/ready`).set(accountant.auth).expect(409);
    expect(res.body.error).toBe('NOT_READY');
    expect(res.body.message).toContain('Months of the year locked');
  });

  it('keeps notes to the auditor and marks the year ready once everything is done or explained', async () => {
    await ctx.http().put(`${R()}/${LAST.label}/notes/CASH_PAYMENTS`).set(viewer.auth).send({ note: 'x' }).expect(403);
    await ctx.http().put(`${R()}/${LAST.label}/notes/NOT_A_CHECK`).set(accountant.auth).send({ note: 'x' }).expect(400);
    await ctx.http().put(`${R()}/${LAST.label}/notes/CASH_PAYMENTS`).set(accountant.auth).send({ note: 'x'.repeat(2001) }).expect(400);
    let r = (await ctx.http().put(`${R()}/${LAST.label}/notes/CASH_PAYMENTS`).set(accountant.auth).send({ note: '  Paid to a farmer for produce: rule 6DD(e) applies.  ' }).expect(200)).body;
    expect(r.checks.find((c: Check) => c.key === 'CASH_PAYMENTS').note).toMatchObject({ text: 'Paid to a farmer for produce: rule 6DD(e) applies.', by: 'Preparation Accountant' });
    await ctx.http().put(`${R()}/${LAST.label}/notes/YEAR_CLOSED`).set(accountant.auth).send({ note: 'Closing after the audit adjustments.' }).expect(200);
    await ctx.http().put(`${R()}/${LAST.label}/notes/DEPRECIATION`).set(accountant.auth).send({ note: 'Placeholder' }).expect(200);
    r = (await ctx.http().put(`${R()}/${LAST.label}/notes/DEPRECIATION`).set(accountant.auth).send({ note: '' }).expect(200)).body;
    expect(r.checks.find((c: Check) => c.key === 'DEPRECIATION').note).toBeNull();

    // Fix what is missing: post the draft, depreciate, prepare and finalise the computation, lock the months.
    await ctx.http().post(`${org.base}/journals/${draftId}/post`).set(owner.auth).expect((res) => expect(res.status).toBeLessThan(300));
    await journal(`${P + 1}-03-31`, '6800', '1520', '50000.00');
    await ctx.http().put(`${org.base}/tax/income-computation/${LAST.label}`).set(owner.auth).send({ regime: 'COMPANY_22', taxDepreciation: '75000', broughtForwardLoss: '0', adjustments: [], otherCredits: '0' }).expect(200);
    await ctx.http().post(`${org.base}/tax/income-computation/${LAST.label}/finalise`).set(owner.auth).expect(200);
    const periods = (await ctx.http().get(`${org.base}/periods?fiscalYear=${P + 1}`).set(owner.auth).expect(200)).body as { id: string; status: string }[];
    for (const p of periods.filter((x) => x.status === 'OPEN')) await ctx.http().post(`${org.base}/periods/${p.id}/lock`).set(owner.auth).expect(200);

    r = (await ctx.http().get(`${R()}?year=${LAST.label}`).set(viewer.auth).expect(200)).body;
    expect(statuses(r)).toMatchObject({ PERIODS_LOCKED: 'READY', NO_DRAFTS: 'READY', DEPRECIATION: 'READY', INCOME_COMPUTATION: 'READY', YEAR_CLOSED: 'ATTENTION', CASH_PAYMENTS: 'ATTENTION' });
    expect(r.blockers).toEqual([]);

    const ready = (await ctx.http().post(`${R()}/${LAST.label}/ready`).set(accountant.auth).expect(200)).body;
    expect(ready).toMatchObject({ status: 'READY', ready: { by: 'Preparation Accountant', summary: { ready: 5, attention: 2, missing: 0, notApplicable: 4 }, changedSince: [] } });
    expect((await ctx.http().post(`${R()}/${LAST.label}/ready`).set(accountant.auth).expect(409)).body.error).toBe('PREPARATION_READY');
    expect((await ctx.http().put(`${R()}/${LAST.label}/notes/YEAR_CLOSED`).set(accountant.auth).send({ note: 'Changed' }).expect(409)).body.error).toBe('PREPARATION_READY');
  });

  it('exports the checklist with notes and reopens with a reason', async () => {
    const csv = (await ctx.http().get(`${R()}/export?year=${LAST.label}`).set(viewer.auth).expect(200)).body;
    expect(csv.fileName).toBe(`tax-audit-preparation-${LAST.label}.csv`);
    const rows = csv.csv.split('\n');
    expect(rows[0]).toBe(`Tax audit preparation,${LAST.label}`);
    expect(rows.find((l: string) => l.startsWith('"Cash payments over 10,000 a day"'))).toMatch(/Needs attention,.*Paid to a farmer for produce: rule 6DD\(e\) applies\.$/);
    await ctx.http().post(`${R()}/${LAST.label}/reopen`).set(viewer.auth).send({ reason: 'Auditor asked' }).expect(403);
    await ctx.http().post(`${R()}/${LAST.label}/reopen`).set(owner.auth).send({ reason: '' }).expect(400);
    const r = (await ctx.http().post(`${R()}/${LAST.label}/reopen`).set(owner.auth).send({ reason: 'Auditor asked for a depreciation note' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'OPEN', ready: null, reopened: { by: 'Preparation Owner', reason: 'Auditor asked for a depreciation note' } });
    expect((await ctx.http().post(`${R()}/${LAST.label}/reopen`).set(owner.auth).send({ reason: 'Again please' }).expect(409)).body.error).toBe('NOT_MARKED_READY');
    await ctx.http().put(`${R()}/${LAST.label}/notes/DEPRECIATION`).set(accountant.auth).send({ note: 'Book rates follow the Companies Act schedule II.' }).expect(200);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: { $regex: '^tax_audit_preparation\\.' } }).toArray();
    expect(events.map((e) => e.action)).toEqual([
      'tax_audit_preparation.noted',
      'tax_audit_preparation.noted',
      'tax_audit_preparation.noted',
      'tax_audit_preparation.note_removed',
      'tax_audit_preparation.ready',
      'tax_audit_preparation.exported',
      'tax_audit_preparation.reopened',
      'tax_audit_preparation.noted',
    ]);
  });

  it('checks the year, the country and the tenant', async () => {
    const now = (await ctx.http().get(`${R()}?year=${current.label}`).set(viewer.auth).expect(200)).body;
    expect(now).toMatchObject({ taxYear: current.label, yearEnded: false });
    expect(now.blockers[0]).toBe('The financial year has not ended.');
    const next = taxYearOf(`${Number(current.from.slice(0, 4)) + 1}-04-01`).label;
    expect((await ctx.http().get(`${R()}?year=${next}`).set(viewer.auth).expect(422)).body.error).toBe('FUTURE_YEAR');
    expect((await ctx.http().get(`${R()}?year=2025-27`).set(viewer.auth).expect(400)).body.error).toBe('INVALID_TAX_YEAR');
    expect((await ctx.http().get(`${us.base}/tax/audit-preparation`).set(owner.auth).expect(422)).body.error).toBe('NOT_INDIA');
    const outsider = await registerUser(ctx, 'Preparation Outsider');
    await ctx.http().get(R()).set(outsider.auth).expect(404);
  });
});
