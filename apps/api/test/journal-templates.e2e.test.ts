import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JournalTemplatesService } from '../src/journal-templates/journal-templates.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * GL-007 / GL-012 against the real API and database: templates checked on save, used by hand
 * (draft or posted, placeholders filled), saved from an existing journal; schedules that make
 * every run that has fallen due exactly once (by the runner and by Run due now), at the month end,
 * posting or as drafts; a closed period stops a run and keeps the error; pause, resume with missed
 * runs skipped, end; archive and delete; permissions, tenant isolation and the database guards.
 */
let ctx: Ctx;
let svc: JournalTemplatesService;
let owner: TestUser;
let bookkeeper: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let fyStart: string;
let periods: { id: string; startDate: string; endDate: string; status: string }[];

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const rent = (extra: Record<string, unknown> = {}) => ({
  name: 'Office rent accrual',
  description: 'Rent for the Pune office, paid in arrears',
  memo: 'Rent for {month}',
  reference: 'RENT-{period}',
  lines: [
    { accountId: org.acc['6200'], debit: '85000.00', description: 'Rent {month}' },
    { accountId: org.acc['2200'], credit: '85000.00' },
  ],
  ...extra,
});
const orgInfo = () => ({ id: org.orgId, role: 'OWNER' as const, functionalCurrency: 'INR', fiscalYearStartMonth: 4 });

beforeAll(async () => {
  ctx = await bootApp();
  svc = ctx.app.get(JournalTemplatesService);
  owner = await registerUser(ctx, 'Template Owner');
  bookkeeper = await registerUser(ctx, 'Template Bookkeeper');
  viewer = await registerUser(ctx, 'Template Viewer');
  outsider = await registerUser(ctx, 'Template Outsider');
  org = await createOrg(ctx, owner, { name: 'Template Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Templates Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: bookkeeper.email, role: 'ACCOUNTANT' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body;
  fyStart = periods.map((p) => p.startDate).sort()[0]!;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('journal templates', () => {
  let id: string;
  it('checks the lines before saving', async () => {
    const unbalanced = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['6200'], debit: '100' }, { accountId: org.acc['2200'], credit: '90' }] })).expect(422);
    expect(unbalanced.body).toMatchObject({ error: 'TEMPLATE_INVALID' });
    expect(unbalanced.body.message).toContain('must be equal');
    const control = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['1200'], debit: '100' }, { accountId: org.acc['4100'], credit: '100' }] })).expect(422);
    expect(control.body.message).toContain('control account');
    const heading = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['6000'], debit: '100' }, { accountId: org.acc['2200'], credit: '100' }] })).expect(422);
    expect(heading.body.message).toContain('heading');
    const decimals = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['6200'], debit: '1.005' }, { accountId: org.acc['2200'], credit: '1.005' }] })).expect(422);
    expect(decimals.body.message).toContain('more decimals');
    const foreign = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ lines: [{ accountId: org.acc['6200'], debit: '100', currency: 'USD' }, { accountId: org.acc['2200'], credit: '100' }] })).expect(422);
    expect(foreign.body.details.issues).toHaveLength(2);
    await ctx.http().post(`${org.base}/journal-templates`).set(viewer.auth).send(rent()).expect(403);

    const r = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent()).expect(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ reference: 'JT-0001', name: 'Office rent accrual', status: 'ACTIVE', schedule: null, totals: [{ currency: 'INR', amount: '85000.00' }], runs: [], upcoming: [] });
    expect(r.body.lines[0]).toMatchObject({ account: { code: '6200', name: 'Rent' }, debit: '85000.00', credit: null, currency: 'INR' });
  });

  it('makes a draft or a posted journal from the template, with the placeholders filled', async () => {
    const date = addDays(fyStart, 29);
    const month = new Date(`${date}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const draft = await ctx.http().post(`${org.base}/journal-templates/${id}/use`).set(bookkeeper.auth).send({ date }).expect(201);
    expect(draft.body).toMatchObject({ posted: false, entryNumber: null });
    const je = (await ctx.http().get(`${org.base}/journals/${draft.body.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ status: 'DRAFT', type: 'STANDARD', memo: `Rent for ${month}`, reference: `RENT-${date.slice(0, 7)}` });
    expect(je.lines[0].description).toBe(`Rent ${month}`);

    // A viewer cannot use a template.
    await ctx.http().post(`${org.base}/journal-templates/${id}/use`).set(viewer.auth).send({ date, post: true }).expect(403);
    const posted = await ctx.http().post(`${org.base}/journal-templates/${id}/use`).set(owner.auth).send({ date, post: true }).expect(201);
    expect(posted.body.entryNumber).toBeGreaterThan(0);
    expect((await ctx.http().get(`${org.base}/journals/${posted.body.journalEntryId}`).set(owner.auth).expect(200)).body).toMatchObject({ status: 'POSTED', totalDebit: '85000.00' });

    const t = (await ctx.http().get(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(200)).body;
    expect(t.runs).toHaveLength(2);
    expect(t.runs.every((r: { scheduled: boolean }) => !r.scheduled)).toBe(true);
    expect(t.runs.map((r: { posted: boolean }) => r.posted).sort()).toEqual([false, true]);

    // Deleting the draft keeps the run in the history, without its journal.
    await ctx.http().delete(`${org.base}/journals/${draft.body.journalEntryId}`).set(owner.auth).expect(204);
    const after = (await ctx.http().get(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(200)).body;
    expect(after.runs).toHaveLength(2);
    expect(after.runs.find((r: { posted: boolean }) => !r.posted).entry).toBeNull();

    // A template that has made journals is archived, not deleted.
    expect((await ctx.http().delete(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(409)).body.error).toBe('TEMPLATE_USED');
  });

  it('saves an existing manual journal as a template', async () => {
    const je = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(fyStart, 10), memo: 'Software', lines: [{ accountId: org.acc['6400'], debit: '1200.50' }, { accountId: org.acc['2200'], credit: '1200.50' }], post: true }).expect(201);
    const t = await ctx.http().post(`${org.base}/journal-templates/from-journal/${je.body.id}`).set(owner.auth).send({ name: 'Software subscriptions' }).expect(201);
    expect(t.body).toMatchObject({ reference: 'JT-0002', memo: 'Software', totals: [{ currency: 'INR', amount: '1200.50' }] });
    expect(t.body.lines.map((l: { account: { code: string } }) => l.account.code)).toEqual(['6400', '2200']);
    // An unused template is deleted outright.
    await ctx.http().delete(`${org.base}/journal-templates/${t.body.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${org.base}/journal-templates/${t.body.id}`).set(owner.auth).expect(404);
  });
});

describe('recurring journals', () => {
  let id: string;
  it('checks the schedule and shows the runs to come', async () => {
    const bad = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ schedule: { frequency: 'MONTHLY', startDate: addDays(fyStart, 9), endDate: addDays(fyStart, 19), monthEnd: true } })).expect(422);
    expect(bad.body.error).toBe('TEMPLATE_END');
    await ctx.http().post(`${org.base}/journal-templates`).set(viewer.auth).send(rent({ schedule: { frequency: 'MONTHLY', startDate: fyStart, monthEnd: true, postMode: 'POST' } })).expect(403);
    const end = periods.map((p) => p.endDate).sort().at(-1)!;
    const r = await ctx.http().post(`${org.base}/journal-templates`).set(owner.auth).send(rent({ name: 'Monthly rent', schedule: { frequency: 'MONTHLY', startDate: fyStart, endDate: end, monthEnd: true, postMode: 'POST' } })).expect(201);
    id = r.body.id;
    expect(r.body.schedule).toMatchObject({ frequency: 'MONTHLY', status: 'ACTIVE', postMode: 'POST', nextRunNo: 1, runsTotal: 12, monthEnd: true });
    expect(r.body.schedule.description).toContain('until');
    expect(r.body.upcoming).toHaveLength(6);
    expect(r.body.upcoming[0].date.slice(0, 7)).toBe(fyStart.slice(0, 7));
  });

  it('makes every run that has fallen due, once, as posted journals', async () => {
    const asOf = addDays(fyStart, 75); // two month ends have passed
    const first = await svc.runAll(asOf, [org.orgId]);
    expect(first).toMatchObject({ templates: 1, made: 2, failed: 0 });
    // Running again on the same day makes nothing more.
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ made: 0 });
    const t = (await ctx.http().get(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(200)).body;
    expect(t.schedule.nextRunNo).toBe(3);
    const scheduled = t.runs.filter((r: { scheduled: boolean }) => r.scheduled);
    expect(scheduled.map((r: { runNo: number }) => r.runNo).sort()).toEqual([1, 2]);
    expect(scheduled.every((r: { posted: boolean; by: string; entry: { status: string } }) => r.posted && r.by === 'Schedule' && r.entry.status === 'POSTED')).toBe(true);
    const je = (await ctx.http().get(`${org.base}/journals/${scheduled[0].entry.id}`).set(owner.auth).expect(200)).body;
    expect(je).toMatchObject({ type: 'RECURRING', status: 'POSTED', totalDebit: '85000.00' });
    expect(je.date.slice(8)).not.toBe('01'); // month end
    // The trial balance carries both runs (and the one posted by hand earlier).
    const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${asOf}`).set(owner.auth).expect(200)).body;
    const rentRow = tb.rows.find((x: { code: string }) => x.code === '6200');
    expect(rentRow.debit).toBe('255000.00');
  });

  it('stops at a locked period, keeps the error, and runs once the period opens', async () => {
    const third = periods.sort((a, b) => a.startDate.localeCompare(b.startDate))[2]!;
    await ctx.http().post(`${org.base}/periods/${third.id}/lock`).set(owner.auth).expect(200);
    const asOf = addDays(third.endDate, 1);
    const r = await svc.runAll(asOf, [org.orgId]);
    expect(r).toMatchObject({ made: 0, failed: 1 });
    const t = (await ctx.http().get(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(200)).body;
    expect(t.schedule.lastError).toMatch(/is LOCKED/);
    expect(t.schedule.nextRunNo).toBe(3);
    await ctx.http().post(`${org.base}/periods/${third.id}/unlock`).set(owner.auth).expect(200);
    expect(await svc.runAll(asOf, [org.orgId])).toMatchObject({ made: 1, failed: 0 });
    const t2 = (await ctx.http().get(`${org.base}/journal-templates/${id}`).set(owner.auth).expect(200)).body;
    expect(t2.schedule).toMatchObject({ nextRunNo: 4, lastError: null });
  });

  it('pauses, resumes skipping the missed runs, and keeps its shape once it has run', async () => {
    await ctx.http().post(`${org.base}/journal-templates/${id}/pause`).set(owner.auth).expect(200);
    const sixMonths = periods[6]!.endDate;
    expect(await svc.runAll(addDays(sixMonths, 1), [org.orgId])).toMatchObject({ templates: 0 });
    // A viewer cannot resume a schedule.
    await ctx.http().post(`${org.base}/journal-templates/${id}/resume`).set(viewer.auth).send({}).expect(403);
    const resumed = await ctx.http().post(`${org.base}/journal-templates/${id}/resume`).set(owner.auth).send({ skipMissed: true }).expect(200);
    expect(resumed.body.schedule.status).toBe('ACTIVE');
    // Runs dated before today were passed over; nothing was made for them.
    expect(resumed.body.schedule.nextRunNo).toBeGreaterThanOrEqual(4);
    expect(resumed.body.runs.filter((r: { scheduled: boolean }) => r.scheduled)).toHaveLength(3);

    const reshaped = await ctx.http().put(`${org.base}/journal-templates/${id}`).set(owner.auth).send(rent({ name: 'Monthly rent', schedule: { frequency: 'QUARTERLY', startDate: fyStart, monthEnd: true, postMode: 'POST' } })).expect(409);
    expect(reshaped.body.error).toBe('TEMPLATE_SCHEDULE_RAN');
    // The amount and the end date can change; later runs use the new lines.
    const changed = await ctx.http().put(`${org.base}/journal-templates/${id}`).set(owner.auth).send(rent({ name: 'Monthly rent', lines: [{ accountId: org.acc['6200'], debit: '90000.00' }, { accountId: org.acc['2200'], credit: '90000.00' }], schedule: { frequency: 'MONTHLY', startDate: fyStart, endDate: null, monthEnd: true, postMode: 'DRAFT' } })).expect(200);
    expect(changed.body.schedule).toMatchObject({ endDate: null, postMode: 'DRAFT', runsTotal: null, status: 'ACTIVE' });
    expect(changed.body.totals[0].amount).toBe('90000.00');

    // The database keeps the run history and the run count as they are.
    await expect(raw(`UPDATE journal_templates SET next_run_no = 1 WHERE id = '${id}'`)).rejects.toThrow(/not undone/);
    await expect(raw(`UPDATE journal_templates SET frequency = 'YEARLY' WHERE id = '${id}'`)).rejects.toThrow(/keeps its start date/);
    await expect(raw(`UPDATE journal_template_runs SET run_date = run_date + 1 WHERE template_id = '${id}'`)).rejects.toThrow(/append-only/);
    await expect(raw(`DELETE FROM journal_template_runs WHERE template_id = '${id}'`)).rejects.toThrow(/append-only/);

    const ended = await ctx.http().post(`${org.base}/journal-templates/${id}/end`).set(owner.auth).expect(200);
    expect(ended.body.schedule.status).toBe('ENDED');
    expect(ended.body.upcoming).toEqual([]);
    expect((await ctx.http().post(`${org.base}/journal-templates/${id}/resume`).set(owner.auth).send({}).expect(409)).body.error).toBe('TEMPLATE_SCHEDULE_ENDED');
  });

  it('makes drafts by Run due now, and ends by itself after its last run', async () => {
    const q = await ctx.http().post(`${org.base}/journal-templates`).set(bookkeeper.auth).send(rent({ name: 'Quarterly audit fee accrual', journalType: 'ADJUSTING', lines: [{ accountId: org.acc['6600'], debit: '30000' }, { accountId: org.acc['2200'], credit: '30000' }], schedule: { frequency: 'QUARTERLY', startDate: fyStart, endDate: addDays(addDays(fyStart, 0), 95), monthEnd: false, postMode: 'DRAFT' } })).expect(201);
    expect(q.body.schedule.runsTotal).toBe(2);
    const ran = await ctx.http().post(`${org.base}/journal-templates/${q.body.id}/run-due`).set(bookkeeper.auth).expect(200);
    // Both quarters have started by today (the fiscal year began more than three months ago, or this is the first quarter).
    expect(ran.body.error).toBeNull();
    const runs = ran.body.template.runs;
    expect(runs.length).toBe(ran.body.made);
    expect(runs.every((r: { posted: boolean; entry: { status: string } }) => !r.posted && r.entry.status === 'DRAFT')).toBe(true);
    if (ran.body.made === 2) {
      expect(ran.body.template.schedule.status).toBe('ENDED');
    }
    // A viewer sees templates but cannot run them.
    await ctx.http().get(`${org.base}/journal-templates?view=scheduled`).set(viewer.auth).expect(200);
    await ctx.http().post(`${org.base}/journal-templates/${q.body.id}/run-due`).set(viewer.auth).expect(403);
  });

  it('lists templates by view and archives them', async () => {
    const all = (await ctx.http().get(`${org.base}/journal-templates?view=all`).set(owner.auth).expect(200)).body;
    expect(all.counts).toMatchObject({ all: 3, archived: 0 });
    expect(all.can).toEqual({ manage: true, post: true });
    const archived = await ctx.http().post(`${org.base}/journal-templates/${id}/archive`).set(owner.auth).expect(200);
    expect(archived.body.status).toBe('ARCHIVED');
    expect((await ctx.http().post(`${org.base}/journal-templates/${id}/use`).set(owner.auth).send({ date: fyStart }).expect(409)).body.error).toBe('TEMPLATE_ARCHIVED');
    const list = (await ctx.http().get(`${org.base}/journal-templates?view=archived`).set(owner.auth).expect(200)).body;
    expect(list.items.map((t: { id: string }) => t.id)).toEqual([id]);
    await ctx.http().post(`${org.base}/journal-templates/${id}/restore`).set(owner.auth).expect(200);
  });

  it('keeps each organisation to its own templates', async () => {
    const mine = (await ctx.http().get(`${org.base}/journal-templates?view=all`).set(owner.auth).expect(200)).body.items[0];
    await ctx.http().get(`${other.base}/journal-templates/${mine.id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/journal-templates`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/journal-templates`).set(outsider.auth).expect(200)).body.items).toEqual([]);
    // Another organisation's account cannot be used.
    const r = await ctx.http().post(`${other.base}/journal-templates`).set(outsider.auth).send(rent()).expect(422);
    expect(r.body.message).toContain('account not found');
  });
});
