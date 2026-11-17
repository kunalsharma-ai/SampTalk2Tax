import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayIst } from '../src/cash-flow/cash-flow.service';
import { CfoService } from '../src/cfo/cfo.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotTools } from '../src/copilot/copilot.tools';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * The virtual CFO against the real API and database: the assessment and the nine questions worked
 * out from posted invoices, bills and journals; board packs and investor updates with commentary,
 * refresh and finalise; the AI summary through the AI control guard with its figure check (a
 * scripted model stands in for Claude); the copilot's CFO tools; permissions, tenant isolation,
 * the audit trail, and proof that nothing is posted.
 */
type Step = (req: CopilotRequest) => CopilotResponse;
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
const text = (t: string, stop_reason = 'end_turn') =>
  ({ id: `msg_cfo_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: t }], stop_reason, stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let L: string;
let P: string;
let boardId: string;
let journalsBefore = 0;

const T = todayIst();
const shift = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const journal = (date: string, debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const settle = () => Promise.all([...ctx.app.get(CfoService).inflight.values()]);
const ask = async (key: string, who: TestUser = viewer) => (await ctx.http().get(`${org.base}/cfo/questions/${key}`).set(who.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  L = shift(T.slice(0, 7), -1);
  P = shift(L, -1);
  owner = await registerUser(ctx, 'Cfo Owner');
  accountant = await registerUser(ctx, 'Cfo Accountant');
  viewer = await registerUser(ctx, 'Cfo Viewer');
  employee = await registerUser(ctx, 'Cfo Employee');
  outsider = await registerUser(ctx, 'Cfo Outsider');
  org = await createOrg(ctx, owner, { name: 'Virtual CFO Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other CFO Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  const acme = await contact('Acme Retail', 'isCustomer');
  const beta = await contact('Beta Stores', 'isCustomer');
  const parts = await contact('Granite Parts', 'isVendor');
  await journal(`${P}-15`, '1120', '3100', '500000.00', 'Capital');
  await journal(`${P}-15`, '6200', '1120', '20000.00', 'Rent');
  await journal(`${L}-15`, '6200', '1120', '50000.00', 'Rent and deposit top-up');
  await journal(`${L}-20`, '1120', '2300', '36000.00', 'Output tax collected');
  const invoice = (contactId: string, issueDate: string, dueDate: string, amount: string) =>
    ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate, dueDate, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);
  await invoice(acme, `${L}-01`, `${L}-10`, '300000.00');
  await invoice(beta, T, addDays(T, 30), '100000.00');
  const bill = (issueDate: string, reference: string, quantity: string, unitPrice: string) =>
    ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: parts, issueDate, reference, post: true, lines: [{ accountId: org.acc['5000'], description: 'Steel sheet', quantity, unitPrice }] }).expect(201);
  await bill(addDays(T, -150), 'GP-1', '10', '100.00');
  await bill(`${L}-05`, 'GP-2', '20', '115.00');
  journalsBefore = await ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } });
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
});

describe('assessment', () => {
  it('scores financial health and covers every area, from the posted books', async () => {
    const a = (await ctx.http().get(`${org.base}/cfo/assessment`).set(viewer.auth).expect(200)).body;
    expect(a.lastMonth).toBe(L);
    expect(a.health.score).toBe(a.health.components.reduce((s: number, c: { points: number }) => s + c.points, 0));
    expect(a.findings.map((f: { key: string }) => f.key)).toEqual(['LIQUIDITY', 'PROFITABILITY', 'WORKING_CAPITAL', 'GROWTH', 'COSTS', 'DEBT', 'CAPITAL', 'RISK', 'PLANNING']);
    const fig = (k: string, label: string) => a.findings.find((f: { key: string }) => f.key === k).figures.find((x: { label: string }) => x.label === label).value;
    // 500,000 capital − 20,000 − 50,000 rent + 36,000 tax collected.
    expect(fig('LIQUIDITY', 'Cash and bank')).toBe('466000.00');
    expect(fig('WORKING_CAPITAL', 'Overdue receivables')).toBe('300000.00');
    expect(fig('PROFITABILITY', 'Revenue')).toBe('300000.00');
    for (const f of a.findings) {
      expect(f.method).toBeTruthy();
      expect(f.sources.length).toBeGreaterThan(0);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(f.confidence);
    }
    expect(a.questions).toHaveLength(9);
    expect(a.questions.every((q: { allowed: boolean }) => q.allowed)).toBe(true);
  });

  it('is not open to members without reports access or to other organisations', async () => {
    await ctx.http().get(`${org.base}/cfo/assessment`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/cfo/assessment`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/cfo/questions/NOT_A_QUESTION`).set(viewer.auth).expect(400);
  });
});

describe('questions', () => {
  it('explains why profit changed last month, account by account', async () => {
    const r = await ask('PROFIT_CHANGE');
    // Sep: rent 20,000. Oct: sales 300,000, steel 2,300, rent 50,000.
    expect(r.figures.find((x: { label: string }) => x.label === 'Change').value).toBe('267700.00');
    expect(r.table.rows.map((x: { account: string; effect: string }) => [x.account, x.effect])).toEqual([
      ['4100 Sales Revenue', '300000.00'],
      ['6200 Rent', '-30000.00'],
      ['5000 Cost of Sales', '-2300.00'],
    ]);
    expect(r).toMatchObject({ method: expect.any(String), confidence: 'HIGH', period: { from: `${P}-01` } });
  });

  it('finds expenses to investigate, vendors charging more, tax owed and invoices likely to be late', async () => {
    const e = await ask('EXPENSES_TO_INVESTIGATE');
    expect(e.table.rows[0]).toMatchObject({ item: '6200 Rent', now: '50000.00' });
    const v = await ask('VENDOR_PRICES');
    expect(v.table.rows).toEqual([{ vendor: 'Granite Parts', item: 'Steel sheet', before: '100.00', recent: '115.00', change: '15.0', extra: '300.00' }]);
    const t = await ask('TAX_EXPOSURE');
    expect(t.figures[0]).toEqual({ label: 'Tax owed per the ledger', value: '36000.00', unit: 'MONEY' });
    const late = await ask('LATE_INVOICES');
    expect(late.table.rows.map((x: { customer: string }) => x.customer)).toEqual(['Acme Retail']);
    expect(late.actions[0].approval).toBe('A person reviews and sends each reminder');
  });

  it('answers the cash, salary, client and project questions', async () => {
    const cash = await ask('CASH_NEXT_QUARTER');
    expect(cash.figures[0]).toMatchObject({ label: 'Cash today', value: '466000.00' });
    const s = await ask('SALARY_RISE');
    expect(s.question).toBe('What happens if salaries increase by 10%?');
    expect(s.method).toContain('digital twin');
    const c = await ask('CLIENT_PROFITABILITY');
    expect(c.table.rows[0]).toMatchObject({ client: 'Acme Retail', revenue: '300000.00', overdue: '300000.00' });
    expect(c.confidence).toBe('LOW');
    const p = await ask('PROJECT_LOSSES');
    expect(p.verdict).toBe('NO_DATA');
  });
});

describe('board packs and investor updates', () => {
  it('only members who prepare CFO reports can make one, one of each kind a month', async () => {
    await ctx.http().post(`${org.base}/cfo/reports`).set(viewer.auth).send({ kind: 'BOARD' }).expect(403);
    const b = (await ctx.http().post(`${org.base}/cfo/reports`).set(accountant.auth).send({ kind: 'BOARD' }).expect(201)).body;
    boardId = b.id;
    expect(b).toMatchObject({ kind: 'BOARD', month: L, status: 'DRAFT', ai: { status: 'NONE' }, createdBy: 'Cfo Accountant' });
    expect(b.sections).toHaveLength(9);
    const dup = await ctx.http().post(`${org.base}/cfo/reports`).set(owner.auth).send({ kind: 'BOARD' }).expect(409);
    expect(dup.body).toMatchObject({ error: 'REPORT_EXISTS', details: { id: boardId } });
    const inv = (await ctx.http().post(`${org.base}/cfo/reports`).set(owner.auth).send({ kind: 'INVESTOR' }).expect(201)).body;
    expect(inv.assessment.findings.map((f: { key: string }) => f.key)).toEqual(['GROWTH', 'PROFITABILITY', 'LIQUIDITY', 'CAPITAL', 'DEBT']);
    await ctx.http().delete(`${org.base}/cfo/reports/${inv.id}`).set(owner.auth).expect(204);
    const list = (await ctx.http().get(`${org.base}/cfo/reports`).set(viewer.auth).expect(200)).body;
    expect(list.map((r: { id: string }) => r.id)).toEqual([boardId]);
  });

  it('keeps commentary on a draft and refreshes its figures', async () => {
    const c = (await ctx.http().put(`${org.base}/cfo/reports/${boardId}/commentary`).set(accountant.auth).send({ commentary: 'October was a strong month for sales.' }).expect(200)).body;
    expect(c.commentary).toBe('October was a strong month for sales.');
    const r = (await ctx.http().post(`${org.base}/cfo/reports/${boardId}/refresh`).set(accountant.auth).expect(200)).body;
    expect(r.commentary).toBe('October was a strong month for sales.');
  });

  it('needs AI set up and on before an AI summary', async () => {
    const off = await bare.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(owner.auth).expect(503);
    expect(off.body.error).toBe('AI_NOT_CONFIGURED');
    const disabled = await ctx.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(owner.auth).expect(409);
    expect(disabled.body.error).toBe('AI_OFF');
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    await ctx.http().put(`${org.base}/ai-control/agents/CFO`).set(owner.auth).send({ enabled: false, monthlyTokenLimit: null }).expect(200);
    expect((await ctx.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(owner.auth).expect(409)).body.error).toBe('AGENT_OFF');
    await ctx.http().put(`${org.base}/ai-control/agents/CFO`).set(owner.auth).send({ enabled: true, monthlyTokenLimit: null }).expect(200);
  });

  it('rejects an AI summary that quotes a figure not in the books', async () => {
    model.steps.push(() => text('Cash is ₹9,99,999 and the business is thriving.'));
    const started = (await ctx.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(accountant.auth).expect(202)).body;
    expect(started.ai.status).toBe('RUNNING');
    await settle();
    const r = (await ctx.http().get(`${org.base}/cfo/reports/${boardId}`).set(viewer.auth).expect(200)).body;
    expect(r.ai).toMatchObject({ status: 'FAILED', errorCode: 'FIGURE_CHECK_FAILED', summary: null });
    expect(r.ai.errorMessage).toContain('999999');
    // The model is given the pack's facts and the instructions, nothing else.
    const req = model.requests.at(-1)!;
    expect(req.system).toContain('Every figure you write must appear in the facts');
    expect((req.messages[0].content as { text: string }[])[0].text).toContain('₹4,66,000.00');
    expect(req.tools).toBeUndefined();
  });

  it('keeps an AI summary whose figures all come from the facts, then finalises the pack', async () => {
    model.steps.push(() => text('Cash and bank stood at ₹4,66,000.00 at the end of the month. Revenue of ₹3,00,000.00 is all still owed by Acme Retail, so chasing it comes first.'));
    await ctx.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(accountant.auth).expect(202);
    await settle();
    let r = (await ctx.http().get(`${org.base}/cfo/reports/${boardId}`).set(viewer.auth).expect(200)).body;
    expect(r.ai).toMatchObject({ status: 'DONE', errorCode: null, startedBy: 'Cfo Accountant', servedModel: 'claude-opus-5-5' });
    expect(r.ai.summary).toContain('₹4,66,000.00');
    r = (await ctx.http().post(`${org.base}/cfo/reports/${boardId}/finalise`).set(owner.auth).expect(200)).body;
    expect(r).toMatchObject({ status: 'FINAL', finalisedBy: 'Cfo Owner' });
    for (const call of [
      () => ctx.http().put(`${org.base}/cfo/reports/${boardId}/commentary`).set(owner.auth).send({ commentary: 'Changed' }),
      () => ctx.http().post(`${org.base}/cfo/reports/${boardId}/refresh`).set(owner.auth),
      () => ctx.http().post(`${org.base}/cfo/reports/${boardId}/summary`).set(owner.auth),
      () => ctx.http().delete(`${org.base}/cfo/reports/${boardId}`).set(owner.auth),
    ]) expect((await call().expect(409)).body.error).toBe('REPORT_FINAL');
    // The database refuses too.
    await expect(sqlWrite(ctx, `UPDATE cfo_reports SET commentary = 'x' WHERE id = $1::uuid`, [boardId], { bypass: true })).rejects.toThrow(/cannot be changed/);
  });

  it('shows the CFO agent and its use in the AI control center', async () => {
    const o = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body;
    const agent = o.agents.find((a: { key: string }) => a.key === 'CFO');
    expect(agent).toMatchObject({ name: 'Virtual CFO', enabled: true, usage: { calls: 1, tokens: 6800, failed: 0 } });
    const log = (await ctx.http().get(`${org.base}/ai-activity`).set(owner.auth).expect(200)).body;
    const rows = (log.rows ?? log.items ?? log).filter((x: { feature: string }) => x.feature === 'CFO');
    expect(rows[0]).toMatchObject({ outcome: 'COMPLETE', decision: expect.stringContaining('Finalised by Cfo Owner') });
  });

  it('keeps reports to their organisation and records every step', async () => {
    await ctx.http().get(`${other.base}/cfo/reports/${boardId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/cfo/reports`).set(outsider.auth).expect(200)).body).toEqual([]);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'cfo_report' }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual([
      'cfo_report.created',
      'cfo_report.created',
      'cfo_report.deleted',
      'cfo_report.commentary_saved',
      'cfo_report.refreshed',
      'cfo_report.summary_started',
      'cfo_report.summary_failed',
      'cfo_report.summary_started',
      'cfo_report.summarised',
      'cfo_report.finalised',
    ]);
    expect(await ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } })).toBe(journalsBefore);
  });
});

describe('copilot', () => {
  it('can read the CFO assessment and answers as tools', async () => {
    const tools = ctx.app.get(CopilotTools);
    expect(tools.names()).toEqual(expect.arrayContaining(['get_cfo_assessment', 'get_cfo_answer']));
    const c = { orgId: org.orgId, role: 'VIEWER' as const, today: T, fiscalYearStartMonth: 4 };
    const r = await tools.run('get_cfo_answer', { question: 'TAX_EXPOSURE' }, c);
    expect(r.ok).toBe(true);
    const body = JSON.parse(r.content);
    expect(body.key).toBe('TAX_EXPOSURE');
    expect(body.figures[0].value).toBe('36000.00');
    expect(r.source).toMatchObject({ label: 'Virtual CFO: What is our current tax exposure?', path: '/cfo?q=TAX_EXPOSURE' });
    const a = await tools.run('get_cfo_assessment', {}, c);
    expect(JSON.parse(a.content).health.score).toBeGreaterThanOrEqual(0);
    const bad = await tools.run('get_cfo_answer', { question: 'MADE_UP' }, c);
    expect(bad.ok).toBe(false);
  });
});
