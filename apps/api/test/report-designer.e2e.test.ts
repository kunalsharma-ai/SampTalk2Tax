import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The report designer against the real API and database: layouts checked by the engine, reports
 * produced from posted books with their figures frozen, commentary written by the AI (a scripted
 * model stands in for Claude) and rejected when it quotes numbers not in the report, commentary
 * written by people, finalising into a record the database will not change, the AI drafting a
 * layout from instructions, the audit trail, permissions and tenant isolation.
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
const tool = (name: string, input: unknown) =>
  ({ id: `msg_rd_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${n}`, name, input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let designId: string;
let reportId: string;

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const L = shift(T.slice(0, 7), -1);
const P = shift(L, -1);
const R = () => `${org.base}/report-designer`;
const layout = {
  sections: [
    { type: 'HEADING', text: 'Monthly results' },
    { type: 'COMMENTARY', instruction: 'How revenue and gross profit moved.' },
    { type: 'WIDGET', widget: { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' } },
    { type: 'WIDGET', widget: { type: 'TABLE', title: 'Profit and loss', metrics: ['revenue', 'costOfSales', 'grossProfit'], months: 2 } },
    { type: 'TEXT', text: 'Prepared by the finance team.' },
  ],
};

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  owner = await registerUser(ctx, 'Report Owner');
  accountant = await registerUser(ctx, 'Report Accountant');
  viewer = await registerUser(ctx, 'Report Viewer');
  outsider = await registerUser(ctx, 'Report Outsider');
  org = await createOrg(ctx, owner, { name: 'Report Designer Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Report Co' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const acme = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Acme Retail', isCustomer: true }).expect(201)).body.id;
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Parts', isVendor: true }).expect(201)).body.id;
  for (const [d, amt] of [[`${P}-10`, '100000.00'], [`${L}-10`, '150000.00']]) await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: acme, issueDate: d, dueDate: d, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amt }] }).expect(201);
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: `${L}-05`, reference: 'GP-1', post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: '60000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('designs', () => {
  it('checks layouts, previews them from the books and saves them', async () => {
    const bad = await ctx.http().post(`${R()}/preview`).set(viewer.auth).send({ layout: { sections: [{ type: 'TEXT', text: 'Words only' }] } }).expect(422);
    expect(bad.body.details.issues).toEqual(['Add at least one section of figures, so the report has something to report']);
    const p = (await ctx.http().post(`${R()}/preview`).set(viewer.auth).send({ layout }).expect(200)).body;
    expect(p.month).toBe(L);
    expect(p.widgets[0]).toMatchObject({ value: '150000.00', compareValue: '100000.00' });
    await ctx.http().post(`${R()}/designs`).set(viewer.auth).send({ name: 'x', layout }).expect(403);
    const d = (await ctx.http().post(`${R()}/designs`).set(accountant.auth).send({ name: 'Monthly management report', layout }).expect(201)).body;
    designId = d.id;
    expect(d).toMatchObject({ number: 'RD-0001', version: 1, reports: [] });
    expect(d.descriptions[1]).toBe('Commentary: How revenue and gross profit moved.');
  });
});

describe('reports', () => {
  it('without the AI, produces the report with commentary left for a person', async () => {
    const r = (await ctx.http().post(`${R()}/designs/${designId}/reports`).set(accountant.auth).send({ month: L }).expect(201)).body;
    expect(r).toMatchObject({ number: 'RPT-0001', status: 'DRAFT', month: L, title: `Monthly management report, ${L}` });
    expect(r.commentary).toEqual([{ section: 1, instruction: 'How revenue and gross profit moved.', text: '', source: 'NONE', issues: ['Not written by the AI: AI is turned off for this organisation. An owner or admin can turn it on in the copilot settings.'] }]);
    expect(r.facts).toContain(`Revenue for ${L} is INR 150000.00; ${P} was INR 100000.00, a change of INR 50000.00.`);
    // A person writes it; a number not in the report is flagged.
    const e = (await ctx.http().put(`${R()}/reports/${r.id}/commentary`).set(accountant.auth).send({ section: 1, text: 'Revenue rose by ₹50,000 to ₹1,50,000, about 50% more.', baseVersion: 1 }).expect(200)).body;
    expect(e.commentary[0]).toMatchObject({ source: 'PERSON', issues: ["Numbers not in the report's figures: 50. Check them before finalising."] });
    await ctx.http().delete(`${R()}/reports/${r.id}`).set(accountant.auth).expect(204);
  });

  it('with the AI, writes commentary from the report figures and rejects invented numbers', async () => {
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    model.steps.push(() => tool('write_commentary', { sections: [{ section: 2, text: 'Revenue rose to ₹1,50,000 in the month, up ₹50,000 on the month before, and gross profit was ₹90,000.' }] }));
    const r = (await ctx.http().post(`${R()}/designs/${designId}/reports`).set(accountant.auth).send({ month: L }).expect(201)).body;
    reportId = r.id;
    expect(r.commentary[0]).toMatchObject({ source: 'AI', issues: [], text: 'Revenue rose to ₹1,50,000 in the month, up ₹50,000 on the month before, and gross profit was ₹90,000.' });
    const req = model.requests.at(-1)!;
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'write_commentary' });
    expect(JSON.stringify(req.system)).toContain('INR 150000.00');

    // Asked again, the AI invents a growth rate: the text is not used.
    model.steps.push(() => tool('write_commentary', { sections: [{ section: 2, text: 'Revenue grew 50% to ₹1,50,000.' }] }));
    const again = (await ctx.http().post(`${R()}/reports/${reportId}/write-commentary`).set(accountant.auth).send({ baseVersion: 1 }).expect(200)).body;
    expect(again.commentary[0]).toMatchObject({ text: '', source: 'NONE', issues: ["The AI's text quoted numbers not in the report (50), so it was not used; write it yourself or ask again"] });
    const fin = await ctx.http().post(`${R()}/reports/${reportId}/finalise`).set(accountant.auth).send({ baseVersion: 2 }).expect(422);
    expect(fin.body).toMatchObject({ error: 'COMMENTARY_MISSING', details: { issues: ['Section 2: How revenue and gross profit moved.'] } });
    await ctx.http().put(`${R()}/reports/${reportId}/commentary`).set(accountant.auth).send({ section: 1, text: 'Revenue was ₹1,50,000, up ₹50,000.', baseVersion: 1 }).expect(409);
    await ctx.http().put(`${R()}/reports/${reportId}/commentary`).set(accountant.auth).send({ section: 1, text: 'Revenue was ₹1,50,000, up ₹50,000.', baseVersion: 2 }).expect(200);
  });

  it('finalises a report into a record that can never change', async () => {
    await ctx.http().post(`${R()}/reports/${reportId}/finalise`).set(viewer.auth).send({ baseVersion: 3 }).expect(403);
    const f = (await ctx.http().post(`${R()}/reports/${reportId}/finalise`).set(owner.auth).send({ baseVersion: 3 }).expect(200)).body;
    expect(f).toMatchObject({ status: 'FINAL', finalisedBy: 'Report Owner' });
    await ctx.http().put(`${R()}/reports/${reportId}/commentary`).set(owner.auth).send({ section: 1, text: 'x', baseVersion: 4 }).expect(409);
    await ctx.http().delete(`${R()}/reports/${reportId}`).set(owner.auth).expect(409);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE report_runs SET title = 'changed' WHERE id = '${reportId}'`)).rejects.toThrow(/final report cannot be changed/);
    // Its figures stay as they were, even after the books change.
    const acme = (await ctx.prisma.contact.findFirst({ where: { orgId: org.orgId, name: 'Acme Retail' } }))!.id;
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: acme, issueDate: `${L}-20`, dueDate: `${L}-20`, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '1000.00' }] }).expect(201);
    expect((await ctx.http().get(`${R()}/reports/${reportId}`).set(viewer.auth).expect(200)).body.widgets[0].value).toBe('150000.00');
    // The design is kept while reports use it.
    expect((await ctx.http().delete(`${R()}/designs/${designId}`).set(owner.auth).expect(409)).body.error).toBe('DESIGN_IN_USE');
    const d = (await ctx.http().get(`${R()}/designs/${designId}`).set(viewer.auth).expect(200)).body;
    expect(d.reports.map((x: { number: string; status: string }) => `${x.number} ${x.status}`)).toEqual(['RPT-0001 FINAL']);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: { in: ['report_design', 'report_run'] } }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['report_design.created', 'report.produced', 'report.commentary_edited', 'report.deleted', 'report.produced', 'report.commentary_written', 'report.commentary_edited', 'report.finalised']);
  });
});

describe('drafting a layout with the AI', () => {
  it('drafts a layout from instructions, previews it, and counts the tokens', async () => {
    model.steps.push(() =>
      tool('propose_report', {
        name: 'Board pack',
        description: 'Monthly results for the board.',
        sections: [
          { type: 'HEADING', text: 'Results' },
          { type: 'WIDGET', widget: { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' } },
          { type: 'COMMENTARY', instruction: 'Explain revenue.' },
        ],
        notes: ['Budgets are not available yet.'],
        questions: ['Should customers be listed?'],
      }),
    );
    const d = (await ctx.http().post(`${R()}/ai-draft`).set(accountant.auth).send({ request: 'A board pack with results against budget' }).expect(200)).body;
    expect(d).toMatchObject({ name: 'Board pack', issues: [], notes: ['Budgets are not available yet.'], questions: ['Should customers be listed?'] });
    expect(d.descriptions).toEqual(['Heading: Results', 'Revenue: Revenue for the month, against the month before', 'Commentary: Explain revenue.']);
    expect(d.preview.widgets[0].value).toBe('151000.00');
    await ctx.http().post(`${R()}/ai-draft`).set(viewer.auth).send({ request: 'x' }).expect(403);
    const o = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body;
    expect(o.agents.find((a: { key: string }) => a.key === 'COPILOT').usage).toMatchObject({ calls: 3, tokens: 3900, failed: 0 });
    const calls = await ctx.prisma.reportAiCall.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' }, select: { kind: true, status: true } });
    expect(calls.map((c) => `${c.kind} ${c.status}`)).toEqual(['COMMENTARY DONE', 'COMMENTARY DONE', 'DESIGN DONE']);
  });

  it('is closed to other organisations', async () => {
    await ctx.http().get(`${R()}/designs/${designId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/report-designer/reports/${reportId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/report-designer/designs`).set(outsider.auth).expect(200)).body.items).toEqual([]);
  });
});
