import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BankAiService, MAX_LINES_PER_RUN } from '../src/bank-ai/bank-ai.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AI reconciliation against the real API and database. The language model is a scripted
 * stand-in: each step reads the text the agent sent and picks references from it, so the
 * test checks what the model is shown, how each proposal is checked, and that nothing is
 * recorded until a person accepts it, through the same code as matching by hand.
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
  ({ id: `msg_b_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const submit = (input: Record<string, unknown>) => reply([{ type: 'tool_use', id: `tu_${n}`, name: 'submit_suggestion', input }]);
const textOf = (req: CopilotRequest) => (req.messages[0].content as { text: string }[])[0].text;
const refIn = (text: string, re: RegExp) => {
  const m = re.exec(text);
  if (!m) throw new Error(`No reference for ${re} in:\n${text}`);
  return m[1];
};

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
let A: string;
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};

interface Suggestion {
  id: string;
  status: string;
  line: { id: string; description: string; amount: string; status: string };
  lineOpen: boolean;
  action: string | null;
  resolved: Record<string, unknown> | null;
  confidence: string | null;
  reason: string | null;
  checks: { ok: boolean; label: string }[];
  canAccept: boolean;
  shown: { ledger: number; documents: number; accounts: number; history: number };
  errorCode: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  result: Record<string, unknown> | null;
}

const settle = () => Promise.all([...ctx.app.get(BankAiService).inflight.values()]);
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const run = async () => (await ctx.http().post(`${A}/runs`).set(owner.auth).expect(201)).body;
const suggestions = async (status?: string) => (await ctx.http().get(`${A}/suggestions${status ? `?status=${status}` : ''}`).set(owner.auth).expect(200)).body as Suggestion[];
const forLine = async (text: string, status?: string) => (await suggestions(status)).find((s) => s.line.description.includes(text))!;
const S = (id: string) => `${org.base}/banking/ai-suggestions/${id}`;

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Bank AI Owner');
  accountant = await registerUser(ctx, 'Bank AI Accountant');
  viewer = await registerUser(ctx, 'Bank AI Viewer');
  employee = await registerUser(ctx, 'Bank AI Employee');
  org = await createOrg(ctx, owner, { name: 'Reconcile Test Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  bank = org.acc['1120'];
  A = `${org.base}/banking/accounts/${bank}/ai`;
  for (const [name, kind] of [['Lotus Retail', 'isCustomer'], ['Banyan Traders', 'isCustomer'], ['Teak Supplies', 'isVendor']] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id;
  }
  const doc = async (key: string, kind: 'INVOICE' | 'BILL', who: string, amount: string) => {
    const path = kind === 'INVOICE' ? 'sales' : 'purchases';
    const d = (await ctx.http().post(`${org.base}/${path}/documents`).set(owner.auth).send({ kind, contactId: c[who], issueDate: addDays(T, -30), dueDate: addDays(T, -10), ...(kind === 'BILL' ? { reference: `TS-${key}` } : {}), post: true, lines: [{ accountId: org.acc[kind === 'INVOICE' ? '4100' : '6400'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
    inv[key] = { id: d.id, number: d.number };
  };
  await doc('a', 'INVOICE', 'Lotus Retail', '45000.00');
  await doc('b', 'INVOICE', 'Lotus Retail', '10000.00');
  await doc('bill', 'BILL', 'Teak Supplies', '8000.00');
  // Already in the books: capital, and two cheques from Banyan banked together.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(T, -10), memo: 'Capital introduced', post: true, lines: [{ accountId: bank, debit: '500000.00' }, { accountId: org.acc['3100'], credit: '500000.00' }] }).expect(201);
  for (const amount of ['12000.00', '8000.00']) {
    await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c['Banyan Traders'], date: addDays(T, -7), bankAccountId: bank, amount, allocations: [] }).expect(201);
  }
  const csv = [
    'Date,Narration,Ref,Amount',
    `${dmy(addDays(T, -10))},CAPITAL INFUSION,,500000.00`,
    `${dmy(addDays(T, -6))},NEFT CR LOTUS RETAIL ${inv.a.number},UTR77,50000.00`,
    `${dmy(addDays(T, -5))},CHQ DEPOSIT 2 CHQS BANYAN,,20000.00`,
    `${dmy(addDays(T, -4))},ACCOUNT MAINT CHARGES Q3,,-590.00`,
    `${dmy(addDays(T, -3))},MISC CREDIT 77,,123.45`,
    `${dmy(addDays(T, -2))},IMPS TEAK SUPPLIES TS-bill,,-8000.00`,
  ].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'oct.csv', csv, mapping }).expect(201);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
});

describe('setting up', () => {
  it('says clearly when the server has no AI key, and needs AI on for the organisation', async () => {
    const borg = await createOrg(bare, owner, { name: 'No Key Bank Ltd' });
    const r = await bare.http().post(`${borg.base}/banking/accounts/${borg.acc['1120']}/ai/runs`).set(owner.auth).expect(503);
    expect(r.body.error).toBe('AI_NOT_CONFIGURED');
    expect((await bare.http().get(`${borg.base}/banking/accounts/${borg.acc['1120']}/ai`).set(owner.auth).expect(200)).body).toMatchObject({ aiConfigured: false, latestRun: null });

    const o = (await ctx.http().get(A).set(viewer.auth).expect(200)).body;
    expect(o).toMatchObject({ account: { code: '1120' }, aiConfigured: true, aiEnabled: false, canChangeAi: false, limits: { linesPerRun: MAX_LINES_PER_RUN }, latestRun: null });
    expect((await ctx.http().post(`${A}/runs`).set(owner.auth).expect(409)).body.error).toBe('AI_OFF');
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    await ctx.http().post(`${A}/runs`).set(viewer.auth).expect(403);
    await ctx.http().get(A).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/banking/accounts/${org.acc['4100']}/ai`).set(owner.auth).expect(404);
    expect(model.requests).toHaveLength(0);
  });
});

describe('suggesting', () => {
  it('asks about each unmatched line without an exact match, showing references and never ids', async () => {
    model.steps.push(
      (req) => {
        const t = textOf(req);
        return submit({ action: 'PAYMENT', contactRef: refIn(t, /Lotus Retail \((C\d+)\)/), allocations: [{ documentRef: refIn(t, new RegExp(`- (D\\d+): ${inv.a.number}`)), amount: '45000.00' }, { documentRef: refIn(t, new RegExp(`- (D\\d+): ${inv.b.number}`)), amount: '5000.00' }], confidence: 'HIGH', reason: `The text names Lotus Retail and ${inv.a.number}; 45,000 settles it and 5,000 goes to ${inv.b.number}.` });
      },
      (req) => {
        const t = textOf(req);
        return submit({ action: 'MATCH', ledgerRefs: [refIn(t, /- (L\d+): [^\n]*\+₹12,000\.00/), refIn(t, /- (L\d+): [^\n]*\+₹8,000\.00/)], confidence: 'MEDIUM', reason: 'Two Banyan receipts recorded two days earlier add up to the deposit.' });
      },
      () => submit({ action: 'ENTRY', accountCode: '6900', entryDescription: 'Account maintenance charges Q3', confidence: 'HIGH', reason: 'A bank fee.' }),
      () => submit({ action: 'NONE', confidence: 'LOW', reason: 'Nothing in the books or the text explains this credit.' }),
      (req) => {
        const t = textOf(req);
        return submit({ action: 'PAYMENT', contactRef: refIn(t, /Teak Supplies \((C\d+)\)/), allocations: [{ documentRef: refIn(t, /- (D\d+): BILL-/), amount: '9000.00' }], confidence: 'MEDIUM', reason: 'Names Teak Supplies.' });
      },
    );
    const o = await run();
    expect(o.latestRun).toMatchObject({ status: 'RUNNING', startedBy: 'Bank AI Owner', suggestions: 5 });
    expect(o.latestRun.skipped.map((s: { description: string; reason: string }) => [s.description, s.reason])).toEqual([['CAPITAL INFUSION', 'Has an exact match: use "Match suggested"']]);
    await settle();

    // What the model was given.
    expect(model.requests).toHaveLength(5);
    const first = model.requests[0];
    expect(first.tool_choice).toEqual({ type: 'tool', name: 'submit_suggestion' });
    expect(first.system).toContain('"Reconcile Test Pvt Ltd"');
    expect(first.system).toContain('you never change the books');
    const t = textOf(first);
    expect(t).toContain(`money in ₹50,000.00, text "NEFT CR LOTUS RETAIL ${inv.a.number}", bank reference "UTR77"`);
    expect(t).toMatch(new RegExp(`- D\\d+: ${inv.a.number}, Lotus Retail \\(C\\d+\\), due .*, still to pay ₹45,000\\.00`));
    expect(t).toContain('- 6900 Bank Charges (expense)');
    expect(t).not.toContain('- 1120 ');
    expect(t).not.toContain('Accounts Receivable');
    expect(t).not.toContain('BILL-');
    expect(t).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(textOf(model.requests[4])).toContain('Open bills (vendors we owe)');

    const all = await suggestions();
    expect(all.map((s) => [s.line.description.split(' ')[0], s.status, s.action, s.confidence, s.canAccept])).toEqual(
      expect.arrayContaining([
        ['NEFT', 'READY', 'PAYMENT', 'HIGH', true],
        ['CHQ', 'READY', 'MATCH', 'MEDIUM', true],
        ['ACCOUNT', 'READY', 'ENTRY', 'HIGH', true],
        ['MISC', 'READY', 'NONE', 'LOW', false],
        ['IMPS', 'READY', 'PAYMENT', 'MEDIUM', false],
      ]),
    );
    const lotus = all.find((s) => s.line.description.startsWith('NEFT'))!;
    expect(lotus.resolved).toEqual({ action: 'PAYMENT', contactId: c['Lotus Retail'], contactName: 'Lotus Retail', allocations: [{ documentId: inv.a.id, number: inv.a.number, amount: '45000.00' }, { documentId: inv.b.id, number: inv.b.number, amount: '5000.00' }], unallocated: '0.00' });
    expect(lotus.checks.every((x) => x.ok)).toBe(true);
    const teak = all.find((s) => s.line.description.startsWith('IMPS'))!;
    expect(teak.resolved).toBeNull();
    expect(teak.checks.filter((x) => !x.ok).map((x) => x.label)).toEqual([`${inv.bill.number} only has ₹8,000.00 still to pay`]);

    // Nothing was recorded.
    expect((await ctx.prisma.bankStatementLine.count({ where: { orgId: org.orgId, status: 'MATCHED' } }))).toBe(0);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: 'bank_ai.' } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['bank_ai.run_started', ...Array(5).fill('bank_ai.suggested'), 'bank_ai.run_finished']);
  });
});

describe('accepting', () => {
  it('records the receipt against both invoices and matches the line', async () => {
    const s = await forLine('LOTUS');
    const done = (await ctx.http().post(`${S(s.id)}/accept`).set(accountant.auth).expect(200)).body as Suggestion;
    expect(done).toMatchObject({ status: 'ACCEPTED', decidedBy: 'Bank AI Accountant', canAccept: false, lineOpen: false, line: { status: 'MATCHED' } });
    expect(done.result).toMatchObject({ paymentNumber: expect.stringMatching(/^RCPT-/) });
    const p = await ctx.prisma.payment.findFirstOrThrow({ where: { id: done.result!.paymentId as string }, include: { allocations: true } });
    expect(p).toMatchObject({ contactId: c['Lotus Retail'], kind: 'RECEIPT', memo: 'Suggested by AI reconciliation' });
    expect(p.allocations.map((x) => [x.targetId, x.amount.toFixed(2)]).sort()).toEqual([[inv.a.id, '45000.00'], [inv.b.id, '5000.00']].sort());
    const audit = await ctx.prisma.auditEvent.findFirstOrThrow({ where: { orgId: org.orgId, action: 'bank_ai.suggestion_accepted' } });
    expect(audit.data).toMatchObject({ action: 'PAYMENT', confidence: 'HIGH' });
    expect((await ctx.http().post(`${S(s.id)}/accept`).set(owner.auth).expect(409)).body.error).toBe('NOT_ACCEPTABLE');
  });

  it('matches a deposit to two receipts already in the books', async () => {
    const s = await forLine('BANYAN');
    const done = (await ctx.http().post(`${S(s.id)}/accept`).set(owner.auth).expect(200)).body as Suggestion;
    expect(done.status).toBe('ACCEPTED');
    const matches = await ctx.prisma.bankMatch.findMany({ where: { statementLineId: s.line.id, removedAt: null }, include: { journalLine: true } });
    expect(matches.map((m) => m.journalLine.functionalDebit.toFixed(2)).sort()).toEqual(['12000.00', '8000.00']);
    expect(matches.every((m) => m.origin === 'EXISTING')).toBe(true);
  });

  it('posts an entry to the account it chose', async () => {
    const s = await forLine('MAINT');
    const done = (await ctx.http().post(`${S(s.id)}/accept`).set(owner.auth).expect(200)).body as Suggestion;
    const entryId = (done.result!.journalEntryIds as string[])[0];
    const je = await ctx.prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: true } });
    expect(je.source).toBe('BANK');
    expect(je.lines.find((l) => l.accountId === org.acc['6900'])?.functionalDebit.toFixed(2)).toBe('590.00');
    expect(je.lines.find((l) => l.accountId === bank)?.functionalCredit.toFixed(2)).toBe('590.00');
    expect(je.lines[0].description).toBe('Account maintenance charges Q3');
  });

  it('will not apply "could not tell" or a proposal that fails its checks, and records a dismissal', async () => {
    for (const text of ['MISC', 'TEAK']) {
      const s = await forLine(text);
      expect((await ctx.http().post(`${S(s.id)}/accept`).set(owner.auth).expect(409)).body.error).toBe('NOT_ACCEPTABLE');
    }
    const teak = await forLine('TEAK');
    const d = (await ctx.http().post(`${S(teak.id)}/dismiss`).set(owner.auth).send({ note: 'Wrong amount' }).expect(200)).body as Suggestion;
    expect(d).toMatchObject({ status: 'DISMISSED', decidedBy: 'Bank AI Owner', decisionNote: 'Wrong amount' });
    expect((await ctx.http().post(`${S(teak.id)}/dismiss`).set(owner.auth).send({}).expect(409)).body.error).toBe('NOT_DISMISSABLE');
    await ctx.http().post(`${S(teak.id)}/accept`).set(viewer.auth).expect(403);
  });

  it('keeps what the model proposed, in the database too', async () => {
    const s = await forLine('LOTUS');
    await expect(raw(`UPDATE bank_ai_suggestions SET reason = 'x' WHERE id = $1::uuid`, s.id)).rejects.toThrow(/cannot be changed/);
    await expect(raw(`DELETE FROM bank_ai_suggestions WHERE id = $1::uuid`, s.id)).rejects.toThrow(/cannot be removed/);
    const misc = await forLine('MISC');
    await expect(raw(`UPDATE bank_ai_suggestions SET proposal = '{}' WHERE id = $1::uuid`, misc.id)).rejects.toThrow(/AI model proposed cannot be changed/);
    await expect(raw(`UPDATE bank_ai_suggestions SET status = 'ACCEPTED', decided_by_id = $2::uuid, decided_at = now(), result = '{}' WHERE id = $1::uuid`, misc.id, owner.id)).rejects.toThrow(/bank_ai_suggestions_chk/);
  });
});

describe('the next run', () => {
  it('learns from the entries a person made, and refuses a suggestion for a line dealt with another way', async () => {
    model.steps.push((req) => {
      const t = textOf(req);
      return submit({ action: 'PAYMENT', contactRef: refIn(t, /Teak Supplies \((C\d+)\)/), allocations: [{ documentRef: refIn(t, /- (D\d+): BILL-/), amount: '8000.00' }], confidence: 'HIGH', reason: 'Names Teak Supplies and the bill reference.' });
    });
    const o = await run();
    expect(o.latestRun.skipped.map((s: { description: string; reason: string }) => [s.description, s.reason])).toEqual([
      ['CAPITAL INFUSION', 'Has an exact match: use "Match suggested"'],
      ['MISC CREDIT 77', 'A suggestion is already waiting for review'],
    ]);
    await settle();
    expect(textOf(model.requests.at(-1)!)).toContain('- "ACCOUNT MAINT CHARGES Q3", -₹590.00 → 6900 Bank Charges');
    const s = await forLine('TEAK', 'READY');
    expect(s.canAccept).toBe(true);
    await ctx.http().post(`${org.base}/banking/lines/${s.line.id}/exclude`).set(owner.auth).send({ reason: 'Paid from petty cash in error' }).expect(200);
    const after = (await ctx.http().get(S(s.id)).set(owner.auth).expect(200)).body as Suggestion;
    expect(after).toMatchObject({ lineOpen: false, canAccept: false });
    expect((await ctx.http().post(`${S(s.id)}/accept`).set(owner.auth).expect(409)).body.error).toBe('LINE_EXCLUDED');
    expect(await ctx.prisma.payment.count({ where: { orgId: org.orgId, contactId: c['Teak Supplies'] } })).toBe(0);
    await ctx.http().post(`${S(s.id)}/dismiss`).set(owner.auth).send({ note: 'Excluded' }).expect(200);
    await ctx.http().post(`${org.base}/banking/lines/${s.line.id}/include`).set(owner.auth).expect(200);
  });

  it('records refusals and provider errors as failed, and runs one at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    model.steps.push(async () => {
      await gate;
      return reply([{ type: 'text', text: 'No.' }], 'refusal');
    });
    await run();
    expect((await ctx.http().post(`${A}/runs`).set(owner.auth).expect(409)).body.error).toBe('BANK_AI_BUSY');
    release();
    await settle();
    expect(await forLine('TEAK', 'FAILED')).toMatchObject({ errorCode: 'REFUSED', action: null, canAccept: false });

    const limited = new (Anthropic.RateLimitError as unknown as new (s: number, e: unknown, m: string, h: Headers) => Error)(429, { type: 'error', error: { type: 'rate_limit_error', message: 'test' } }, '429 test', new Headers());
    model.steps.push(() => Promise.reject(limited));
    await run();
    await settle();
    const failed = (await suggestions('FAILED')).map((s) => s.errorCode).sort();
    expect(failed).toEqual(['AI_RATE_LIMITED', 'REFUSED']);
  });

  it('lists every call in the AI activity log', async () => {
    const a = (await ctx.http().get(`${org.base}/ai-activity`).set(owner.auth).expect(200)).body;
    const rows = a.rows.filter((r: { feature: string }) => r.feature === 'BANKING');
    expect(rows).toHaveLength(8);
    expect(rows.find((r: { what: string }) => r.what.includes('LOTUS'))).toMatchObject({ what: `Suggested a receipt or payment for "NEFT CR LOTUS RETAIL ${inv.a.number}" (high confidence)`, outcome: 'ACCEPTED', decision: 'Accepted by Bank AI Accountant', inputTokens: 1500, link: expect.stringMatching(new RegExp(`^/banking/${bank}/ai\\?suggestion=`)) });
  });
});
