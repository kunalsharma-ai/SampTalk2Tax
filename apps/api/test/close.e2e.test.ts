import Anthropic from '@anthropic-ai/sdk';
import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseService } from '../src/close/close.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Month-end close against the real API and database: the checklist worked out from the books,
 * tasks for open checks, an AI review whose adjusting entries are checked and posted only when
 * a person approves them, and closing (which locks the month and records a certification) and
 * reopening. The language model is a scripted stand-in that reads what it was sent.
 */
type Step = (req: CopilotRequest) => CopilotResponse | Promise<CopilotResponse>;
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  requests: CopilotRequest[] = [];
  steps: Step[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('The test did not script this step');
    return step(req);
  }
}
let n = 0;
const reply = (content: unknown[], stop_reason = 'tool_use') =>
  ({ id: `msg_c_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 4200, output_tokens: 610, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const submit = (input: Record<string, unknown>) => reply([{ type: 'tool_use', id: `tu_${n}`, name: 'submit_close_review', input }]);
const textOf = (req: CopilotRequest) => (req.messages[0].content as { text: string }[])[0].text;

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const lastDay = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let M: string;
let periodId: string;
let nextPeriodId: string;
let C: string;
let draftId: string;
let lineId: string;

interface Check {
  key: string;
  severity: string;
  ok: boolean;
  label: string;
  detail: string;
  count: number;
  link: string | null;
  task: { id: string; status: string } | null;
}
interface Adjustment {
  id: string;
  status: string;
  description: string;
  confidence: string;
  reverseNextPeriod: boolean;
  checks: { ok: boolean; label: string }[];
  canPost: boolean;
  resolved: { date: string; total: string; reverseOn: string | null } | null;
  journal: { id: string; number: number } | null;
  reversal: { id: string; number: number } | null;
  decidedBy: string | null;
  decisionNote: string | null;
}
interface CloseView {
  period: { id: string; name: string; status: string };
  close: { status: string; startedBy: string } | null;
  checks: Check[];
  readiness: { blocking: number; warnings: number; noteRequired: boolean };
  review: { status: string; summary: string | null; findings: { title: string; detail: string }[]; errorCode: string | null; inputTokens: number | null } | null;
  adjustments: Adjustment[];
  certifications: { certifiedBy: string; note: string | null; totals: Record<string, unknown>; warningsAccepted: string[]; reopenedBy: string | null; reopenReason: string | null }[];
  can: { manage: boolean; post: boolean; close: boolean };
}

const settle = () => Promise.all([...ctx.app.get(CloseService).inflight.values()]);
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const view = async (who: TestUser = owner) => (await ctx.http().get(C).set(who.auth).expect(200)).body as CloseView;
const check = (v: CloseView, key: string) => v.checks.find((c) => c.key === key)!;
const adj = (v: CloseView, text: string) => v.adjustments.find((a) => a.description.includes(text))!;
const journal = (date: string, debit: string, credit: string, amount: string, memo: string, post = true) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo, post, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Close Owner');
  accountant = await registerUser(ctx, 'Close Accountant');
  approver = await registerUser(ctx, 'Close Approver');
  viewer = await registerUser(ctx, 'Close Viewer');
  org = await createOrg(ctx, owner, { name: 'Month End Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  M = shift(T.slice(0, 7), -1);
  const fy = fiscalYearForDate(`${M}-01`, 4);
  for (const y of [fy - 1, fy]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[];
  periodId = periods.find((p) => p.startDate === `${M}-01`)!.id;
  nextPeriodId = periods.find((p) => p.startDate === `${shift(M, 1)}-01`)!.id;
  C = `${org.base}/close/${periodId}`;

  // Capital four months back, rent in each of the three months before M but not in M,
  // equipment two months back, and sales in M.
  await journal(`${shift(M, -4)}-05`, '1120', '3100', '500000.00', 'Capital introduced');
  for (const k of [-3, -2, -1]) await journal(`${shift(M, k)}-15`, '6200', '1120', '45000.00', 'Office rent');
  await journal(`${shift(M, -2)}-20`, '1510', '1120', '120000.00', 'Laptops');
  await journal(`${M}-10`, '1120', '4100', '80000.00', 'Cash sales');
  draftId = (await journal(`${M}-12`, '6500', '1120', '5000.00', 'Ad campaign (draft)', false)).body.id;
  const csv = ['Date,Narration,Ref,Amount', `${dmy(`${M}-25`)},UNKNOWN CREDIT,,999.00`].join('\n');
  const imp = (await ctx.http().post(`${org.base}/banking/accounts/${org.acc['1120']}/imports`).set(owner.auth).send({ fileName: 'm.csv', csv, mapping: { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true } }).expect(201)).body;
  lineId = imp.lines[0].id ?? (await ctx.prisma.bankStatementLine.findFirstOrThrow({ where: { orgId: org.orgId } })).id;
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
});

describe('the checklist', () => {
  it('is worked out from the books, and anyone who can see periods can read it', async () => {
    const v = await view(viewer);
    expect(v.close).toBeNull();
    expect(v.can).toEqual({ manage: false, post: false, close: false });
    const failing = v.checks.filter((c) => !c.ok).map((c) => [c.key, c.severity, c.count]);
    expect(failing).toEqual([
      ['DRAFT_JOURNALS', 'BLOCKING', 1],
      ['UNMATCHED_BANK_LINES', 'BLOCKING', 1],
      ['BANK_NOT_RECONCILED', 'WARNING', 1],
      ['DEPRECIATION_MISSING', 'WARNING', 1],
      ['EARLIER_PERIODS_OPEN', 'WARNING', expect.any(Number)],
    ]);
    expect(check(v, 'TRIAL_BALANCE')).toMatchObject({ ok: true, detail: 'Debits and credits are both ₹8,35,000.00' });
    expect(check(v, 'DEPRECIATION_MISSING').detail).toBe('Fixed assets of ₹1,20,000.00 but no depreciation posted in the month');
    expect(check(v, 'DRAFT_JOURNALS').link).toBe('/journals?status=DRAFT');
    expect(v.readiness).toMatchObject({ blocking: 2, noteRequired: true });

    await ctx.http().post(`${C}/start`).set(viewer.auth).expect(403);
    const started = (await ctx.http().post(`${C}/start`).set(accountant.auth).expect(200)).body as CloseView;
    expect(started.close).toMatchObject({ status: 'IN_PROGRESS', startedBy: 'Close Accountant' });
    await ctx.http().post(`${C}/start`).set(owner.auth).expect(200);
    const list = (await ctx.http().get(`${org.base}/close`).set(viewer.auth).expect(200)).body.periods as { id: string; closeStatus: string }[];
    expect(list.find((p) => p.id === periodId)?.closeStatus).toBe('IN_PROGRESS');
    expect(list.find((p) => p.id === nextPeriodId)?.closeStatus).toBe('NOT_STARTED');
  });

  it('makes one task per open check for accountants, and not again while it is open', async () => {
    const r = (await ctx.http().post(`${C}/tasks`).set(accountant.auth).expect(200)).body;
    expect(r.created).toBe(5);
    const v = r.close as CloseView;
    const t = check(v, 'DRAFT_JOURNALS').task!;
    expect(t.status).toBe('OPEN');
    const task = (await ctx.http().get(`${org.base}/tasks/${t.id}`).set(accountant.auth).expect(200)).body;
    expect(task).toMatchObject({ title: expect.stringMatching(/close: no draft journals in the month$/), assignee: expect.objectContaining({ role: 'ACCOUNTANT' }), link: { path: `/close/${periodId}`, label: 'Month-end close' } });
    expect(task.description).toContain('The month cannot be closed until this is done.');
    expect((await ctx.http().post(`${C}/tasks`).set(accountant.auth).expect(200)).body.created).toBe(0);
  });
});

describe('the AI review', () => {
  it('needs AI set up and on', async () => {
    const borg = await createOrg(bare, owner, { name: 'No Key Close Ltd' });
    const bp = ((await bare.http().get(`${borg.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[]).find((p) => p.startDate <= T)!;
    await bare.http().post(`${borg.base}/close/${bp.id}/start`).set(owner.auth).expect(200);
    expect((await bare.http().post(`${borg.base}/close/${bp.id}/reviews`).set(owner.auth).expect(503)).body.error).toBe('AI_NOT_CONFIGURED');
    expect((await ctx.http().post(`${C}/reviews`).set(owner.auth).expect(409)).body.error).toBe('AI_OFF');
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    await ctx.http().post(`${C}/reviews`).set(viewer.auth).expect(403);
    expect(model.requests).toHaveLength(0);
  });

  it('shows the model the month with codes, never ids, and checks every entry it proposes', async () => {
    model.steps.push((req) => {
      expect(req.tool_choice).toEqual({ type: 'tool', name: 'submit_close_review' });
      const t = textOf(req);
      expect(t).toContain('Posted to in each of the 3 months before but nothing this month: 6200 Rent.');
      expect(t).toContain('- 6200 Rent (expense): this month ₹0.00, average of the 3 months before ₹45,000.00, posted to in 3 of those 3');
      expect(t).toContain('- OPEN: No draft journals in the month.');
      expect(t).toContain('- 2200 Accrued Liabilities (liability)');
      expect(t).not.toContain('- 1120 Operating Bank Account (asset)\n');
      expect(t).not.toContain(org.acc['6200']);
      return submit({
        summary: 'Sales of ₹80,000 were booked, but rent, posted every month, is missing and no depreciation was charged.',
        findings: [{ title: 'Rent missing', detail: '6200 Rent averaged ₹45,000 a month but has nothing this month.' }],
        adjustments: [
          { description: 'Accrue rent for the month', reason: 'Rent of ₹45,000 was posted in each of the three months before.', confidence: 'HIGH', reverseNextPeriod: true, lines: [{ accountCode: '6200', debit: '45000.00' }, { accountCode: '2200', credit: '45000.00' }] },
          { description: 'Depreciation on laptops', reason: 'Fixed assets of ₹1,20,000 and no depreciation; 5 years straight line is ₹2,000 a month.', confidence: 'MEDIUM', reverseNextPeriod: false, lines: [{ accountCode: '6800', debit: '2000.00' }, { accountCode: '1520', credit: '2000.00' }] },
          { description: 'Pay the rent', reason: 'Clear it from the bank.', confidence: 'LOW', reverseNextPeriod: false, lines: [{ accountCode: '2200', debit: '45000.00' }, { accountCode: '1120', credit: '45000.00' }] },
          { description: 'Marketing reclass', reason: 'Some ad spend looks misposted.', confidence: 'LOW', reverseNextPeriod: false, lines: [{ accountCode: '6500', debit: '1000.00' }, { accountCode: '6400', credit: '900.00' }] },
        ],
      });
    });
    const started = (await ctx.http().post(`${C}/reviews`).set(accountant.auth).expect(201)).body as CloseView;
    expect(started.review?.status).toBe('RUNNING');
    await settle();
    const v = await view(accountant);
    expect(v.review).toMatchObject({ status: 'DONE', summary: expect.stringContaining('rent, posted every month, is missing'), findings: [{ title: 'Rent missing' }], inputTokens: 4200 });
    expect(v.adjustments.map((a) => [a.description, a.status, a.canPost])).toEqual([
      ['Accrue rent for the month', 'READY', true],
      ['Depreciation on laptops', 'READY', true],
      ['Pay the rent', 'READY', false],
      ['Marketing reclass', 'READY', false],
    ]);
    expect(adj(v, 'Accrue').resolved).toMatchObject({ date: lastDay(M), total: '45000.00', reverseOn: `${shift(M, 1)}-01` });
    expect(adj(v, 'Pay the rent').checks.find((c) => !c.ok)?.label).toBe('Accounts it may not use: 1120');
    expect(adj(v, 'Marketing').checks.find((c) => !c.ok)?.label).toBe('Debits ₹1,000.00 and credits ₹900.00 do not balance');
    expect(check(v, 'AI_WAITING')).toMatchObject({ ok: false, count: 4, detail: '4 proposed adjusting entries waiting for a person' });
  });
});

describe('deciding on entries', () => {
  it('posts an accrual dated the month end with its reversal next month, through the journal code', async () => {
    let v = await view();
    await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Accrue').id}/post`).set(approver.auth).expect(403);
    v = (await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Accrue').id}/post`).set(accountant.auth).expect(200)).body;
    const a = adj(v, 'Accrue');
    expect(a).toMatchObject({ status: 'POSTED', decidedBy: 'Close Accountant', canPost: false });
    const je = await ctx.prisma.journalEntry.findUniqueOrThrow({ where: { id: a.journal!.id }, include: { lines: true } });
    expect(je).toMatchObject({ source: 'CLOSE', status: 'POSTED', memo: 'Accrue rent for the month (AI-proposed month-end adjustment)' });
    expect(je.date.toISOString().slice(0, 10)).toBe(lastDay(M));
    expect(je.lines.find((l) => l.accountId === org.acc['6200'])?.functionalDebit.toFixed(2)).toBe('45000.00');
    const rev = await ctx.prisma.journalEntry.findUniqueOrThrow({ where: { id: a.reversal!.id }, include: { lines: true } });
    expect(rev).toMatchObject({ type: 'REVERSING', reversesEntryId: je.id, source: 'CLOSE' });
    expect(rev.date.toISOString().slice(0, 10)).toBe(`${shift(M, 1)}-01`);
    expect(rev.lines.find((l) => l.accountId === org.acc['6200'])?.functionalCredit.toFixed(2)).toBe('45000.00');

    expect((await ctx.http().post(`${org.base}/close/adjustments/${a.id}/post`).set(accountant.auth).expect(409)).body.error).toBe('NOT_POSTABLE');
    expect((await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Pay the rent').id}/post`).set(accountant.auth).expect(409)).body.error).toBe('NOT_POSTABLE');
    v = (await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Marketing').id}/reject`).set(accountant.auth).send({ note: 'Does not balance; nothing misposted' }).expect(200)).body;
    expect(adj(v, 'Marketing')).toMatchObject({ status: 'REJECTED', decisionNote: 'Does not balance; nothing misposted' });
    expect((await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Marketing').id}/reject`).set(accountant.auth).send({}).expect(409)).body.error).toBe('NOT_REJECTABLE');
    v = (await ctx.http().post(`${org.base}/close/adjustments/${adj(v, 'Depreciation').id}/post`).set(owner.auth).expect(200)).body;
    expect(adj(v, 'Depreciation').reversal).toBeNull();
    expect(check(v, 'DEPRECIATION_MISSING').ok).toBe(true);
  });

  it('keeps what the model proposed and what the review saw, in the database too', async () => {
    const v = await view();
    const open = adj(v, 'Pay the rent');
    await expect(raw(`UPDATE close_adjustments SET proposal = '{}' WHERE id = $1::uuid`, open.id)).rejects.toThrow(/AI model proposed cannot be changed/);
    await expect(raw(`DELETE FROM close_adjustments WHERE id = $1::uuid`, open.id)).rejects.toThrow(/cannot be removed/);
    await expect(raw(`UPDATE close_adjustments SET decision_note = 'x' WHERE id = $1::uuid`, adj(v, 'Accrue').id)).rejects.toThrow(/cannot be changed/);
    await expect(raw(`UPDATE close_ai_reviews SET summary = 'x' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/finished AI close review cannot be changed/);
    await expect(raw(`UPDATE close_adjustments SET status = 'POSTED', decided_by_id = $2::uuid, decided_at = now() WHERE id = $1::uuid`, open.id, owner.id)).rejects.toThrow(/close_adjustments_chk/);
  });
});

describe('closing and reopening', () => {
  it('will not close with blocking checks open, and only an owner or admin can close', async () => {
    await ctx.http().post(`${C}/close`).set(accountant.auth).send({ note: 'All good here' }).expect(403);
    const r = (await ctx.http().post(`${C}/close`).set(owner.auth).send({ note: 'All good here' }).expect(409)).body;
    expect(r.error).toBe('CLOSE_NOT_READY');
    expect(r.message).toContain('2 blocking checks not passed');
    await ctx.http().delete(`${org.base}/journals/${draftId}`).set(owner.auth).expect(204);
    await ctx.http().post(`${org.base}/banking/lines/${lineId}/exclude`).set(owner.auth).send({ reason: 'Bank error, reversed next day' }).expect(200);
    const again = (await ctx.http().post(`${C}/close`).set(owner.auth).send({}).expect(409)).body;
    expect(again.message).toMatch(/warnings? open: say why closing anyway is acceptable/);
  });

  it('closes with a note: the month is locked, open entries superseded, and a certification records the figures', async () => {
    const v = (await ctx.http().post(`${C}/close`).set(owner.auth).send({ note: 'Bank reconciled outside the system for this month; earlier months are pre-system.' }).expect(200)).body as CloseView;
    expect(v.close?.status).toBe('CLOSED');
    expect(v.period.status).toBe('LOCKED');
    expect(adj(v, 'Pay the rent').status).toBe('SUPERSEDED');
    expect(v.certifications).toHaveLength(1);
    expect(v.certifications[0]).toMatchObject({
      certifiedBy: 'Close Owner',
      totals: { currency: 'INR', revenue: '80000.00', expenses: '47000.00', netProfit: '33000.00', trialBalanceDebit: '882000.00', trialBalanceCredit: '882000.00', journalsPosted: 3 },
      reopenedBy: null,
    });
    expect(v.certifications[0].warningsAccepted).toEqual(expect.arrayContaining(['Bank accounts reconciled to the month end', 'Earlier months are closed']));

    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${M}-28`, memo: 'Late', post: true, lines: [{ accountId: org.acc['6500'], debit: '10.00' }, { accountId: org.acc['1120'], credit: '10.00' }] }).expect(409);
    expect((await ctx.http().post(`${org.base}/periods/${periodId}/unlock`).set(owner.auth).expect(409)).body.error).toBe('PERIOD_CLOSE_CERTIFIED');
    expect((await ctx.http().post(`${C}/reviews`).set(owner.auth).expect(409)).body.error).toBe('CLOSE_CLOSED');
    expect((await ctx.http().post(`${C}/tasks`).set(owner.auth).expect(409)).body.error).toBe('CLOSE_CLOSED');
    expect((await ctx.http().post(`${C}/close`).set(owner.auth).send({ note: 'again and again' }).expect(409)).body.error).toBe('CLOSE_CLOSED');
    const list = (await ctx.http().get(`${org.base}/close`).set(viewer.auth).expect(200)).body.periods as { id: string; closeStatus: string; closedBy: string | null }[];
    expect(list.find((p) => p.id === periodId)).toMatchObject({ closeStatus: 'CLOSED', closedBy: 'Close Owner' });
  });

  it('reopens with a reason, unlocking the month and keeping the certification', async () => {
    await ctx.http().post(`${C}/reopen`).set(accountant.auth).send({ reason: 'A late supplier invoice arrived' }).expect(403);
    await ctx.http().post(`${C}/reopen`).set(owner.auth).send({ reason: 'late' }).expect(400);
    const v = (await ctx.http().post(`${C}/reopen`).set(owner.auth).send({ reason: 'A late supplier invoice arrived for the month' }).expect(200)).body as CloseView;
    expect(v.close?.status).toBe('IN_PROGRESS');
    expect(v.period.status).toBe('OPEN');
    expect(v.certifications[0]).toMatchObject({ reopenedBy: 'Close Owner', reopenReason: 'A late supplier invoice arrived for the month' });
    await expect(raw(`UPDATE close_certifications SET note = 'x' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/reopened close certification cannot be changed/);
    await expect(raw(`DELETE FROM close_certifications WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/cannot be removed/);
    expect((await ctx.http().post(`${C}/reopen`).set(owner.auth).send({ reason: 'Again for no reason at all' }).expect(409)).body.error).toBe('CLOSE_NOT_CLOSED');
    // A posted adjustment is corrected by reversing it like a manual journal; an accrual already has its reversal.
    await ctx.http().post(`${org.base}/journals/${adj(v, 'Depreciation').journal!.id}/reverse`).set(owner.auth).send({ date: lastDay(M), memo: 'Depreciation starts next month' }).expect(201);
    expect((await ctx.http().post(`${org.base}/journals/${adj(v, 'Accrue').journal!.id}/reverse`).set(owner.auth).send({ date: lastDay(M) }).expect(409)).body.error).toBe('ALREADY_REVERSED');

    const actions = (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'close.' } }, orderBy: { id: 'asc' }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(['close.started', 'close.tasks_created', 'close.review_started', 'close.reviewed', 'close.adjustment_posted', 'close.adjustment_rejected', 'close.adjustment_posted', 'close.certified', 'close.reopened']);
  });

  it('records refusals and provider errors as failed reviews, and runs one review at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    model.steps.push(async () => {
      await gate;
      return reply([{ type: 'text', text: 'No.' }], 'refusal');
    });
    await ctx.http().post(`${C}/reviews`).set(owner.auth).expect(201);
    expect((await ctx.http().post(`${C}/reviews`).set(owner.auth).expect(409)).body.error).toBe('CLOSE_REVIEW_BUSY');
    expect((await ctx.http().post(`${C}/close`).set(owner.auth).send({ note: 'Closing while it runs' }).expect(409)).body.error).toBe('CLOSE_REVIEW_BUSY');
    release();
    await settle();
    expect((await view()).review).toMatchObject({ status: 'FAILED', errorCode: 'REFUSED' });
    const limited = new (Anthropic.RateLimitError as unknown as new (s: number, e: unknown, m: string, h: Headers) => Error)(429, { type: 'error', error: { type: 'rate_limit_error', message: 'test' } }, '429 test', new Headers());
    model.steps.push(() => Promise.reject(limited));
    await ctx.http().post(`${C}/reviews`).set(owner.auth).expect(201);
    await settle();
    expect((await view()).review).toMatchObject({ status: 'FAILED', errorCode: 'AI_RATE_LIMITED' });
  });

  it('lists each review in the AI activity log', async () => {
    const a = (await ctx.http().get(`${org.base}/ai-activity`).set(owner.auth).expect(200)).body;
    const rows = a.rows.filter((r: { feature: string }) => r.feature === 'CLOSE');
    expect(rows).toHaveLength(3);
    const name = (await view()).period.name;
    expect(rows.at(-1)).toMatchObject({ what: `Reviewed the ${name} close: 4 adjusting entries proposed`, outcome: 'COMPLETE', decision: 'Entries: 2 posted, 1 rejected, 1 superseded', inputTokens: 4200, link: `/close/${periodId}` });
    expect(rows[0]).toMatchObject({ outcome: 'FAILED', error: 'AI_RATE_LIMITED' });
  });
});
