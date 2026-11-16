import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Dashboards against the real API and database: a configuration checked by the engine, figures
 * worked out from posted invoices, bills and journals, saving, changing and deleting with the
 * audit trail, the AI drafting a dashboard from a description (a scripted model stands in for
 * Claude) and counted in the AI control center, permissions and tenant isolation.
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
const reply = (content: unknown[], stop_reason = 'tool_use') =>
  ({ id: `msg_db_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let dashboardId: string;

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const L = shift(T.slice(0, 7), -1);
const P = shift(L, -1);
const D = () => `${org.base}/dashboards`;
const config = {
  widgets: [
    { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' },
    { type: 'STAT', title: 'Cash', metric: 'cash', compare: 'NONE' },
    { type: 'BAR', title: 'Revenue and gross profit', metrics: ['revenue', 'grossProfit'], months: 3 },
    { type: 'TOP_CUSTOMERS', title: 'Largest customers', count: 3, months: 3 },
  ],
};

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  owner = await registerUser(ctx, 'Dash Owner');
  accountant = await registerUser(ctx, 'Dash Accountant');
  viewer = await registerUser(ctx, 'Dash Viewer');
  employee = await registerUser(ctx, 'Dash Employee');
  outsider = await registerUser(ctx, 'Dash Outsider');
  org = await createOrg(ctx, owner, { name: 'Dashboards Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Dash Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  const acme = await contact('Acme Retail', 'isCustomer');
  const beta = await contact('Beta Stores', 'isCustomer');
  const vendor = await contact('Granite Parts', 'isVendor');
  const journal = (date: string, debit: string, credit: string, amount: string) =>
    ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Opening', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
  const invoice = (contactId: string, date: string, amount: string) =>
    ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);
  await journal(`${P}-02`, '1120', '3100', '500000.00');
  await invoice(acme, `${P}-10`, '100000.00');
  await invoice(acme, `${L}-10`, '150000.00');
  await invoice(beta, `${L}-12`, '50000.00');
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: `${L}-05`, reference: 'GP-1', post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: '80000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('dashboards', () => {
  it('checks a configuration and works out its figures from the books without saving', async () => {
    const bad = await ctx.http().post(`${D()}/preview`).set(viewer.auth).send({ config: { widgets: [{ type: 'LINE', title: 'Mixed', metrics: ['revenue', 'grossMargin'], months: 6 }] } }).expect(422);
    expect(bad.body).toMatchObject({ error: 'INVALID_DASHBOARD', details: { issues: ['Widget 1: a chart can only show metrics measured the same way; these mix amounts and percentages'] } });
    const p = (await ctx.http().post(`${D()}/preview`).set(viewer.auth).send({ config }).expect(200)).body;
    expect(p.month).toBe(L);
    expect(p.descriptions[0]).toBe('Revenue: Revenue for the month, against the month before');
    const [rev, cash, chart, top] = p.widgets;
    expect(rev).toMatchObject({ type: 'STAT', value: '200000.00', compareMonth: P, compareValue: '100000.00', change: '100000.00', better: true });
    expect(cash).toMatchObject({ value: '500000.00' });
    expect(chart.rows.map((r: { month: string }) => r.month)).toEqual([shift(L, -2), P, L]);
    expect(chart.rows[2].values).toEqual({ revenue: '200000.00', grossProfit: '120000.00' });
    expect(top).toMatchObject({ type: 'TOP_CUSTOMERS', total: '300000.00' });
    expect(top.rows.map((r: { name: string; revenue: string }) => [r.name, r.revenue])).toEqual([['Acme Retail', '250000.00'], ['Beta Stores', '50000.00']]);
    // An earlier month can be shown.
    expect((await ctx.http().post(`${D()}/preview`).set(viewer.auth).send({ config, month: P }).expect(200)).body.widgets[0].value).toBe('100000.00');
    await ctx.http().post(`${D()}/preview`).set(viewer.auth).send({ config, month: '2999-01' }).expect(422);
  });

  it('saves, changes and deletes dashboards with the audit trail', async () => {
    await ctx.http().post(D()).set(viewer.auth).send({ name: 'Board', config }).expect(403);
    const d = (await ctx.http().post(D()).set(accountant.auth).send({ name: 'Monthly board view', description: 'For the board pack', config }).expect(201)).body;
    dashboardId = d.id;
    expect(d).toMatchObject({ number: 'DB-0001', version: 1, createdBy: 'Dash Accountant', month: L });
    expect(d.widgets[0].value).toBe('200000.00');
    await ctx.http().post(D()).set(accountant.auth).send({ name: 'Monthly board view', config }).expect(409);
    const seen = (await ctx.http().get(`${D()}/${dashboardId}`).set(viewer.auth).expect(200)).body;
    expect(seen.config.widgets).toHaveLength(4);
    const changed = (await ctx.http().put(`${D()}/${dashboardId}`).set(owner.auth).send({ name: 'Monthly board view', config: { widgets: config.widgets.slice(0, 2) }, baseVersion: 1 }).expect(200)).body;
    expect(changed).toMatchObject({ version: 2, updatedBy: 'Dash Owner' });
    expect((await ctx.http().put(`${D()}/${dashboardId}`).set(accountant.auth).send({ name: 'x', config, baseVersion: 1 }).expect(409)).body.error).toBe('DASHBOARD_CHANGED');
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE dashboards SET config = '{"widgets": []}' WHERE id = '${dashboardId}'`)).rejects.toThrow(/dashboards_config_check/);
    const list = (await ctx.http().get(D()).set(viewer.auth).expect(200)).body.items;
    expect(list.map((x: { number: string; descriptions: string[] }) => [x.number, x.descriptions.length])).toEqual([['DB-0001', 2]]);
    const temp = (await ctx.http().post(D()).set(owner.auth).send({ name: 'Scratch', config }).expect(201)).body;
    await ctx.http().delete(`${D()}/${temp.id}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${D()}/${temp.id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${D()}/${temp.id}`).set(owner.auth).expect(404);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'dashboard' }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['dashboard.created', 'dashboard.updated', 'dashboard.created', 'dashboard.deleted']);
  });

  it('drafts a dashboard from a description, works out its figures, and counts the tokens', async () => {
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    model.steps.push(() =>
      reply([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'propose_dashboard',
          input: {
            name: 'Cash and collections',
            description: 'How much cash we have and how fast customers pay.',
            widgets: [
              { type: 'STAT', title: 'Cash today', size: 'SMALL', metric: 'cash', compare: 'PREVIOUS_MONTH' },
              { type: 'STAT', title: 'Days to get paid', size: 'SMALL', metric: 'dso', compare: 'PREVIOUS_MONTH' },
              { type: 'LINE', title: 'Cash and receivables', size: 'LARGE', metrics: ['cash', 'receivables'], months: 6 },
            ],
            notes: ['Bank balances by account are not available; cash is all cash and bank accounts together.'],
            questions: ['Should overdue invoices be listed?'],
          },
        },
      ]),
    );
    const d = (await ctx.http().post(`${D()}/ai-draft`).set(accountant.auth).send({ request: 'Show me cash and how quickly customers pay us, by bank account.' }).expect(200)).body;
    expect(d).toMatchObject({ name: 'Cash and collections', issues: [], questions: ['Should overdue invoices be listed?'] });
    expect(d.notes[0]).toContain('Bank balances by account are not available');
    expect(d.descriptions[2]).toBe('Cash and receivables: line chart of Cash and bank, Receivables over 6 months');
    expect(d.data.widgets[0]).toMatchObject({ type: 'STAT', value: '500000.00' });
    expect(model.requests.at(-1)!.tool_choice).toEqual({ type: 'tool', name: 'propose_dashboard' });
    expect(JSON.stringify(model.requests.at(-1)!.system)).toContain('grossMargin');

    // Problems in a draft come back explained, with no figures.
    model.steps.push(() => reply([{ type: 'tool_use', id: 'toolu_2', name: 'propose_dashboard', input: { name: 'Bad', description: '', widgets: [{ type: 'STAT', title: 'EBITDA', metric: 'ebitda' }], notes: [], questions: [] } }]));
    const bad = (await ctx.http().post(`${D()}/ai-draft`).set(accountant.auth).send({ request: 'EBITDA please', conversation: [{ role: 'assistant', text: 'Which period?' }, { role: 'user', text: 'Monthly.' }] }).expect(200)).body;
    expect(bad.issues).toEqual(['Widget 1: "ebitda" is not an approved metric']);
    expect(bad.data).toBeNull();
    expect(model.requests.at(-1)!.messages).toHaveLength(3);

    model.steps.push(() => reply([{ type: 'text', text: 'No.' }], 'refusal'));
    expect((await ctx.http().post(`${D()}/ai-draft`).set(accountant.auth).send({ request: 'Something odd' }).expect(422)).body.error).toBe('REFUSED');
    await ctx.http().post(`${D()}/ai-draft`).set(viewer.auth).send({ request: 'x' }).expect(403);

    const o = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body;
    expect(o.agents.find((a: { key: string }) => a.key === 'COPILOT').usage).toMatchObject({ calls: 3, tokens: 6000, failed: 1 });
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'dashboard_ai_draft' }, orderBy: { id: 'asc' }, select: { action: true, data: true } });
    expect(audit.map((a) => a.action)).toEqual(['dashboard.ai_drafted', 'dashboard.ai_drafted', 'dashboard.ai_draft_failed']);
    expect(audit[0]!.data).toMatchObject({ promptVersion: 'dashboard-draft-1' });
  });

  it('is closed to members without reports access and to other organisations', async () => {
    await ctx.http().get(D()).set(employee.auth).expect(403);
    await ctx.http().get(`${D()}/${dashboardId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/dashboards/${dashboardId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/dashboards`).set(outsider.auth).expect(200)).body.items).toEqual([]);
    const cat = (await ctx.http().get(`${D()}/catalogue`).set(viewer.auth).expect(200)).body;
    expect(cat.metrics).toHaveLength(23);
    expect(cat.limits).toEqual({ widgets: 12, months: 24 });
  });
});
