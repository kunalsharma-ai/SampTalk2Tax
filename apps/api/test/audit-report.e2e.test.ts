import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Audit reports (RPT-021) against the real API and database: a back-dated journal, a large round
 * manual journal and one posted by its preparer; a reversal and a role change as sensitive
 * actions; activity by person; the hash chain verified; the CSV export in the audit trail;
 * validation, permissions and tenants.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const je: Record<string, { id: string; entryNumber: number }> = {};
const R = () => `${org.base}/reports/audit`;
const num = (k: string) => `JE-${String(je[k]!.entryNumber).padStart(6, '0')}`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Audit Report Owner');
  accountant = await registerUser(ctx, 'Anita Accountant');
  approver = await registerUser(ctx, 'Arun Approver');
  viewer = await registerUser(ctx, 'Audit Report Viewer');
  outsider = await registerUser(ctx, 'Audit Report Outsider');
  org = await createOrg(ctx, owner, { name: 'Audited Books Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Audit Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([45, 0].map((ago) => fiscalYearForDate(addDays(T, -ago), 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  const journal = async (key: string, who: TestUser, date: string, amount: string, memo: string, post = true) =>
    (je[key] = (await ctx.http().post(`${org.base}/journals`).set(who.auth).send({ date, post, memo, lines: [{ accountId: org.acc['6600'], debit: amount }, { accountId: org.acc['1120'], credit: amount }] }).expect(201)).body);
  // Prepared by the accountant, posted by the owner: no self-posting.
  await journal('checked', accountant, T, '5000.00', 'Office supplies', false);
  je.checked = (await ctx.http().post(`${org.base}/journals/${je.checked!.id}/post`).set(owner.auth).expect(200)).body;
  await journal('backdated', accountant, addDays(T, -45), '1200.00', 'Missed courier bill');
  await journal('round', accountant, T, '250000.00', 'Year-end provision');
  await ctx.http().post(`${org.base}/journals/${je.round!.id}/reverse`).set(owner.auth).send({ date: T, memo: 'Entered twice' }).expect(201);
  await ctx.http().put(`/v1/orgs/${org.orgId}/members/${viewer.id}`).set(owner.auth).send({ role: 'EMPLOYEE' }).expect(200);
  await ctx.http().put(`/v1/orgs/${org.orgId}/members/${viewer.id}`).set(owner.auth).send({ role: 'VIEWER' }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

type Exception = { code: string; severity: string; number: string; detail: string };

describe('audit report', () => {
  it('checks the journals posted in the period', async () => {
    const r = (await ctx.http().get(R()).query({ from: addDays(T, -1), to: T }).set(approver.auth).expect(200)).body;
    expect(r).toMatchObject({ from: addDays(T, -1), to: T, truncated: false, chain: { valid: true } });
    expect(r.journals).toMatchObject({ posted: 4, manual: 3, manualTotal: '256200.00' });
    expect((r.journals.exceptions as Exception[]).map((x) => [x.code, x.severity, x.number])).toEqual([
      ['BACKDATED', 'HIGH', num('backdated')],
      ['ROUND_MANUAL', 'MEDIUM', num('round')],
      // Most serious first, then the latest posted.
      ['SELF_POSTED', 'LOW', num('round')],
      ['SELF_POSTED', 'LOW', num('backdated')],
    ]);
    expect(r.journals.exceptions[0].detail).toBe(`Dated ${addDays(T, -45)}, posted 45 days later on ${T}`);
  });

  it('lists sensitive actions and activity by person', async () => {
    const r = (await ctx.http().get(R()).query({ from: addDays(T, -1), to: T }).set(owner.auth).expect(200)).body;
    const sens = r.sensitive.events as { action: string; category: string; actor: { name: string } | null }[];
    expect(sens.filter((e) => e.action === 'member.role_changed')).toHaveLength(2);
    expect(sens.find((e) => e.action === 'journal.reversed')).toMatchObject({ category: 'VOID_REVERSAL', actor: { name: 'Audit Report Owner' } });
    expect(sens.filter((e) => e.action === 'member.added')).toHaveLength(3);
    expect(r.sensitive.counts.find((c: { category: string }) => c.category === 'ACCESS').events).toBeGreaterThanOrEqual(5);
    const people = r.activity.byPerson as { name: string; events: number; sensitive: number }[];
    expect(people.find((p) => p.name === 'Anita Accountant')).toMatchObject({ sensitive: 0 });
    expect(people.find((p) => p.name === 'Anita Accountant')!.events).toBeGreaterThanOrEqual(3);
    expect(people[0]!.name).toBe('Audit Report Owner');
    expect(r.activity.events).toBe(people.reduce((s, p) => s + p.events, 0));
  });

  it('exports the report as CSV and keeps the export in the audit trail', async () => {
    const x = (await ctx.http().get(`${R()}/export`).query({ from: addDays(T, -1), to: T }).set(approver.auth).expect(200)).body;
    expect(x.fileName).toBe(`audit-report-${addDays(T, -1)}-to-${T}.csv`);
    const rows = (x.csv as string).trim().split('\n');
    expect(rows[0]).toMatch(new RegExp(`^Audit report,${addDays(T, -1)} to ${T},Audit trail intact \\(\\d+ events checked\\)$`));
    expect(rows.some((l) => l.startsWith(`Posted long after its date,HIGH,${num('backdated')},`))).toBe(true);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'audit_report.exported' }).sort({ idNumber: 1 }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ from: addDays(T, -1), to: T, exceptions: 4 });
    // The export itself shows up as a sensitive action next time.
    const again = (await ctx.http().get(R()).query({ from: addDays(T, -1), to: T }).set(approver.auth).expect(200)).body;
    expect(again.sensitive.events[0]).toMatchObject({ action: 'audit_report.exported', category: 'EXPORT', actor: { name: 'Arun Approver' } });
    expect(again.chain.valid).toBe(true);
  });

  it('checks the period, permissions and tenants', async () => {
    const d = (await ctx.http().get(R()).set(owner.auth).expect(200)).body;
    expect(d.to).toBe(T);
    expect(d.from).toMatch(/^\d{4}-04-01$/);
    await ctx.http().get(R()).query({ from: T, to: addDays(T, -3) }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: '2020-01-01', to: T }).set(owner.auth).expect(422);
    await ctx.http().get(R()).query({ from: 'today' }).set(owner.auth).expect(400);
    await ctx.http().get(R()).set(viewer.auth).expect(403);
    await ctx.http().get(R()).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/reports/audit`).set(outsider.auth).expect(200)).body;
    expect(theirs.journals).toMatchObject({ posted: 0, exceptions: [] });
    expect(JSON.stringify(theirs)).not.toContain('Anita Accountant');
  });
});
