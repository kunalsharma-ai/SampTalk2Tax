import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The policy studio against the real API and database: a policy written by an accountant with
 * rules and tests, approval by someone else turning the rules into running workflows, a new
 * version updating those workflows, retirement turning them off, a back-test against posted
 * bills, the AI drafting rules (a scripted model stands in for Claude) and counted in the AI
 * control center, kept versions that cannot be changed, permissions and tenant isolation.
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
  ({ id: `msg_pol_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 2000, output_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

let ctx: Ctx;
let bare: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let admin: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let vendor: string;
let policyId: string;

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const bigBills = { name: 'Review large bills', trigger: 'BILL_POSTED', conditions: [{ fact: 'total', op: 'gt', value: '500000' }], actions: [{ type: 'CREATE_TASK', title: 'Review bill {{number}} from {{contactName}}', assignTo: { role: 'APPROVER' }, dueInDays: 2 }] };
const journals = { name: 'Tell owners about large journals', trigger: 'JOURNAL_POSTED', conditions: [{ fact: 'total', op: 'gte', value: '100000' }], actions: [{ type: 'SEND_EMAIL', to: { role: 'OWNER' }, subject: 'Manual journal {{number}} posted', body: '{{postedBy}} posted {{total}}.' }] };
const tests = [
  { rule: 1, label: 'A ₹6 lakh bill needs review', facts: { total: '600000.00' }, expect: 'ACTS' },
  { rule: 1, label: 'Exactly ₹5 lakh does not', facts: { total: '500000.00' }, expect: 'DOES_NOT_ACT' },
];
const P = () => `${org.base}/policies`;
const bill = (reference: string, amount: string) =>
  ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, reference, post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  bare = await bootApp();
  owner = await registerUser(ctx, 'Policy Owner');
  admin = await registerUser(ctx, 'Policy Admin');
  accountant = await registerUser(ctx, 'Policy Accountant');
  viewer = await registerUser(ctx, 'Policy Viewer');
  employee = await registerUser(ctx, 'Policy Employee');
  outsider = await registerUser(ctx, 'Policy Outsider');
  org = await createOrg(ctx, owner, { name: 'Policy Studio Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Policy Co' });
  for (const [u, role] of [[admin, 'ADMIN'], [accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Parts', isVendor: true }).expect(201)).body.id;
  await bill('GP-1', '650000.00');
  await bill('GP-2', '120000.00');
  await bill('GP-3', '900000.00');
});
afterAll(async () => {
  await ctx?.app.close();
  await bare?.app.close();
});

describe('writing and approving a policy', () => {
  it('checks the policy and explains every problem', async () => {
    const r = await ctx.http().post(P()).set(accountant.auth).send({ name: 'Spending', statement: 'Large bills need review.', rules: [{ ...bigBills, conditions: [{ fact: 'colour', op: 'eq', value: 'red' }] }], tests: [{ rule: 2, label: 'x', facts: {}, expect: 'ACTS' }] }).expect(422);
    expect(r.body.error).toBe('INVALID_POLICY');
    expect(r.body.details.issues).toContain('Test 1: choose a rule from 1 to 1');
    expect(r.body.details.issues.some((i: string) => i.startsWith('Rule 1: ') && /colour/.test(i))).toBe(true);
    // Policies give work to roles, so they keep working when people change.
    const personal = await ctx.http().post(P()).set(accountant.auth).send({ name: 'Spending', statement: 'x', rules: [{ ...bigBills, actions: [{ type: 'CREATE_TASK', title: 'Review', assignTo: { userId: owner.id }, dueInDays: 1 }] }], tests: [] }).expect(422);
    expect(personal.body.details.issues).toEqual(['Rule 1, action 1: give policy tasks to a role, not to one person']);
  });

  it('checks a policy being edited without saving it', async () => {
    const c = (await ctx.http().post(`${P()}/check`).set(viewer.auth).send({ name: '', statement: '', rules: [bigBills], tests: [...tests, { rule: 1, label: 'Wrong', facts: { total: '10.00' }, expect: 'ACTS' }] }).expect(200)).body;
    expect(c.issues).toEqual(['Give the policy a name', 'Write the policy in words']);
    expect(c.descriptions[0]).toContain('total is more than INR 500000.00');
    expect(c.testResults.map((t: { passed: boolean }) => t.passed)).toEqual([true, true, false]);
    expect(c.testResults[2].conditions[0]).toMatchObject({ passed: false, actual: '10.00' });
  });

  it('saves a draft with its rules described in words and its tests run', async () => {
    const p = (await ctx.http().post(P()).set(accountant.auth).send({ name: 'Spending control', statement: 'Bills over ₹5 lakh need an approver’s review within two days.', rules: [bigBills], tests, note: 'First draft' }).expect(201)).body;
    policyId = p.id;
    expect(p).toMatchObject({ number: 'POL-0001', status: 'DRAFT', version: 1, activeVersion: null, testsPassing: true, workflows: [] });
    expect(p.rules[0].description).toBe('A bill is posted, and total is more than INR 500000.00: give Approvers a task "Review bill {{number}} from {{contactName}}", due in 2 days.');
    expect(p.testResults.map((t: { passed: boolean }) => t.passed)).toEqual([true, true]);
    expect(p.versions).toMatchObject([{ version: 1, event: 'CREATED', note: 'First draft' }]);
    await ctx.http().post(P()).set(accountant.auth).send({ name: 'Spending control', statement: 'x', rules: [bigBills], tests: [] }).expect(409);
    const list = (await ctx.http().get(P()).set(viewer.auth).expect(200)).body.items;
    expect(list.map((x: { number: string }) => x.number)).toEqual(['POL-0001']);
  });

  it('back-tests rules against what was posted in the last 90 days', async () => {
    const b = (await ctx.http().get(`${P()}/${policyId}/backtest`).set(viewer.auth).expect(200)).body;
    expect(b.days).toBe(90);
    expect(b.rules[0]).toMatchObject({ rule: 1, supported: true, checked: 3, acted: 2 });
    expect(b.rules[0].examples.map((e: { facts: { total: string } }) => e.facts.total).sort()).toEqual(['650000.00', '900000.00']);
    const draft = (await ctx.http().post(`${P()}/backtest`).set(accountant.auth).send({ rules: [{ ...bigBills, conditions: [{ fact: 'total', op: 'gt', value: '100000' }] }, { name: 'Weekly', trigger: 'SCHEDULE', triggerParams: { frequency: 'WEEKLY', time: '09:00', weekday: 1 }, conditions: [], actions: bigBills.actions }] }).expect(200)).body;
    expect(draft.rules[0]).toMatchObject({ checked: 3, acted: 3 });
    expect(draft.rules[1]).toMatchObject({ supported: false });
  });

  it('cannot be approved by its last editor, by an accountant, or with tests failing', async () => {
    // Accountants write policies but cannot turn rules on.
    await ctx.http().post(`${P()}/${policyId}/approve`).set(accountant.auth).send({ version: 1 }).expect(403);
    await ctx.http().post(`${P()}/${policyId}/approve`).set(owner.auth).send({ version: 2 }).expect(409);
    const failing = (await ctx.http().put(`${P()}/${policyId}`).set(owner.auth).send({ name: 'Spending control', statement: 'Bills over ₹5 lakh need review.', rules: [bigBills], tests: [...tests, { rule: 1, label: 'Wrong', facts: { total: '10.00' }, expect: 'ACTS' }], baseVersion: 1 }).expect(200)).body;
    expect(failing).toMatchObject({ version: 2, testsPassing: false });
    const self = await ctx.http().post(`${P()}/${policyId}/approve`).set(owner.auth).send({ version: 2 }).expect(403);
    expect(self.body.error).toBe('SELF_APPROVAL');
    const red = await ctx.http().post(`${P()}/${policyId}/approve`).set(admin.auth).send({ version: 2 }).expect(422);
    expect(red.body).toMatchObject({ error: 'TESTS_FAILING', details: { issues: ['Test 3 (Wrong): expected the rule to act'] } });
    // A stale edit is refused.
    const stale = await ctx.http().put(`${P()}/${policyId}`).set(accountant.auth).send({ name: 'Spending control', statement: 'x', rules: [bigBills], tests, baseVersion: 1 }).expect(409);
    expect(stale.body.error).toBe('POLICY_CHANGED');
    await ctx.http().put(`${P()}/${policyId}`).set(accountant.auth).send({ name: 'Spending control', statement: 'Bills over ₹5 lakh need an approver’s review within two days.', rules: [bigBills], tests, baseVersion: 2 }).expect(200);
  });

  it('on approval runs each rule as an enabled workflow, and a later version updates them', async () => {
    const a = (await ctx.http().post(`${P()}/${policyId}/approve`).set(owner.auth).send({ version: 3, note: 'Agreed at the finance meeting' }).expect(200)).body;
    expect(a).toMatchObject({ status: 'ACTIVE', activeVersion: 3, approvedById: owner.id });
    expect(a.workflows).toHaveLength(1);
    expect(a.workflows[0]).toMatchObject({ rule: 1, name: 'POL-0001 · Review large bills', enabled: true, currentVersion: 1 });
    const wid = a.workflows[0].id;
    const w = (await ctx.http().get(`${org.base}/workflows/${wid}`).set(owner.auth).expect(200)).body;
    expect(w).toMatchObject({ trigger: 'BILL_POSTED', enabled: true });
    await ctx.http().post(`${P()}/${policyId}/approve`).set(admin.auth).send({ version: 3 }).expect(409);

    // A new version waits for approval while the approved one keeps running.
    const v4 = (await ctx.http().put(`${P()}/${policyId}`).set(accountant.auth).send({ name: 'Spending control', statement: 'Bills over ₹5 lakh need review; owners hear about large journals.', rules: [{ ...bigBills, conditions: [{ fact: 'total', op: 'gt', value: '400000' }] }, journals], tests: [{ rule: 1, label: 'A ₹4.5 lakh bill', facts: { total: '450000.00' }, expect: 'ACTS' }, { rule: 2, label: 'A ₹1 lakh journal', facts: { total: '100000.00' }, expect: 'ACTS' }], baseVersion: 3 }).expect(200)).body;
    expect(v4).toMatchObject({ status: 'DRAFT', version: 4, activeVersion: 3 });
    expect(v4.workflows[0].enabled).toBe(true);
    const b = (await ctx.http().post(`${P()}/${policyId}/approve`).set(admin.auth).send({ version: 4 }).expect(200)).body;
    expect(b.workflows.map((x: { name: string; enabled: boolean; currentVersion: number }) => [x.name, x.enabled, x.currentVersion])).toEqual([
      ['POL-0001 · Review large bills', true, 2],
      ['POL-0001 · Tell owners about large journals', true, 1],
    ]);
    expect(b.workflows[0].id).toBe(wid);
    const w2 = (await ctx.http().get(`${org.base}/workflows/${wid}`).set(owner.auth).expect(200)).body;
    expect(w2.conditions[0].value).toBe('400000');

    // Dropping a rule turns its workflow off when the next version is approved.
    await ctx.http().put(`${P()}/${policyId}`).set(accountant.auth).send({ name: 'Spending control', statement: 'Bills over ₹4 lakh need review.', rules: [{ ...bigBills, conditions: [{ fact: 'total', op: 'gt', value: '400000' }] }], tests: [], baseVersion: 4 }).expect(200);
    const c = (await ctx.http().post(`${P()}/${policyId}/approve`).set(admin.auth).send({ version: 5 }).expect(200)).body;
    expect(c.workflows.map((x: { enabled: boolean }) => x.enabled)).toEqual([true, false]);
    expect(c.versions.map((v: { version: number; event: string }) => `${v.version} ${v.event}`)).toEqual(['5 APPROVED', '5 EDITED', '4 APPROVED', '4 EDITED', '3 APPROVED', '3 EDITED', '2 EDITED', '1 CREATED']);
  });

  it('retiring turns every workflow off and keeps the history', async () => {
    await ctx.http().post(`${P()}/${policyId}/retire`).set(accountant.auth).send({}).expect(403);
    const r = (await ctx.http().post(`${P()}/${policyId}/retire`).set(owner.auth).send({ note: 'Replaced by the procurement manual' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'RETIRED', activeVersion: null });
    expect(r.workflows.every((w: { enabled: boolean }) => !w.enabled)).toBe(true);
    expect(r.versions[0]).toMatchObject({ event: 'RETIRED', note: 'Replaced by the procurement manual' });
    await ctx.http().post(`${P()}/${policyId}/retire`).set(owner.auth).send({}).expect(409);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'policy' }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['policy.created', 'policy.updated', 'policy.updated', 'policy.approved', 'policy.updated', 'policy.approved', 'policy.updated', 'policy.approved', 'policy.retired']);
  });

  it('keeps every version as it was', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE policy_versions SET note = 'changed' WHERE policy_id = '${policyId}'`)).rejects.toThrow(/cannot be changed/i);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM policy_versions WHERE policy_id = '${policyId}'`)).rejects.toThrow(/cannot be changed/i);
  });
});

describe('drafting with the AI', () => {
  it('drafts rules and tests from words, checks them, and counts the tokens', async () => {
    // Drafting is done by the copilot, so it follows the copilot's switch.
    await ctx.http().post(`${P()}/ai-draft`).set(accountant.auth).send({ statement: 'x' }).expect(409);
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    model.steps.push(() =>
      reply([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'propose_policy',
          input: {
            name: 'Expense claim control',
            summary: 'Large bills get a review task.',
            rules: [{ name: 'Review bills over ₹2 lakh', trigger: 'BILL_POSTED', conditions: [{ fact: 'total', op: 'gt', value: '200000' }], actions: [{ type: 'CREATE_TASK', title: 'Review bill {{number}}', assignTo: { role: 'APPROVER' }, dueInDays: 3 }] }],
            tests: [{ rule: 1, label: 'A ₹3 lakh bill', facts: { total: '300000.00' }, expect: 'ACTS' }, { rule: 1, label: 'A ₹1 lakh bill', facts: { total: '100000.00' }, expect: 'DOES_NOT_ACT' }],
            questions: ['Should bills from regular suppliers be left out?'],
          },
        },
      ]),
    );
    const d = (await ctx.http().post(`${P()}/ai-draft`).set(accountant.auth).send({ statement: 'Any bill over two lakh rupees needs an approver to look at it within three days.' }).expect(200)).body;
    expect(d).toMatchObject({ name: 'Expense claim control', issues: [], questions: ['Should bills from regular suppliers be left out?'] });
    expect(d.descriptions[0]).toBe('A bill is posted, and total is more than INR 200000.00: give Approvers a task "Review bill {{number}}", due in 3 days.');
    expect(d.testResults.map((t: { passed: boolean }) => t.passed)).toEqual([true, true]);
    const req = model.requests.at(-1)!;
    expect(req.tool_choice).toEqual({ type: 'tool', name: 'propose_policy' });
    expect(JSON.stringify(req.system)).toContain('BILL_POSTED');
    // Nothing was saved as a policy.
    expect((await ctx.http().get(P()).set(viewer.auth).expect(200)).body.items).toHaveLength(1);

    // A draft with problems comes back with them explained, not hidden.
    model.steps.push(() => reply([{ type: 'tool_use', id: 'toolu_2', name: 'propose_policy', input: { name: 'Bad', summary: '', rules: [{ name: 'x', trigger: 'BILL_POSTED', conditions: [{ fact: 'colour', op: 'eq', value: 'red' }], actions: [] }], tests: [], questions: [] } }]));
    const bad = (await ctx.http().post(`${P()}/ai-draft`).set(accountant.auth).send({ statement: 'Red bills.', conversation: [{ role: 'assistant', text: 'Which bills?' }, { role: 'user', text: 'Red ones.' }] }).expect(200)).body;
    expect(bad.issues.some((i: string) => /colour/.test(i))).toBe(true);
    expect(model.requests.at(-1)!.messages).toHaveLength(3);

    model.steps.push(() => reply([{ type: 'text', text: 'I cannot help with that.' }], 'refusal'));
    const refused = await ctx.http().post(`${P()}/ai-draft`).set(accountant.auth).send({ statement: 'Something odd.' }).expect(422);
    expect(refused.body.error).toBe('REFUSED');

    const drafts = await ctx.prisma.policyAiDraft.findMany({ where: { orgId: org.orgId }, orderBy: { createdAt: 'asc' } });
    expect(drafts.map((x) => x.status)).toEqual(['DONE', 'DONE', 'FAILED']);
    const o = (await ctx.http().get(`${org.base}/ai-control`).set(owner.auth).expect(200)).body;
    expect(o.agents.find((a: { key: string }) => a.key === 'COPILOT').usage).toMatchObject({ calls: 3, tokens: 7800, failed: 1 });
  });

  it('says when AI is not set up or switched off, and who may draft', async () => {
    expect((await ctx.http().get(`${P()}/ai-status`).set(viewer.auth).expect(200)).body).toMatchObject({ configured: true });
    await ctx.http().post(`${P()}/ai-draft`).set(viewer.auth).send({ statement: 'x' }).expect(403);
    const b = await createOrg(bare, owner, { name: 'No AI Co' });
    expect((await bare.http().get(`${b.base}/policies/ai-status`).set(owner.auth).expect(200)).body).toMatchObject({ configured: false });
    expect((await bare.http().post(`${b.base}/policies/ai-draft`).set(owner.auth).send({ statement: 'x' }).expect(503)).body.error).toBe('AI_NOT_CONFIGURED');
    await ctx.http().post(`${org.base}/ai-control/stop`).set(owner.auth).send({ reason: 'Pause all AI for the audit' }).expect(200);
    await ctx.http().post(`${P()}/ai-draft`).set(accountant.auth).send({ statement: 'x' }).expect(409);
    await ctx.http().post(`${org.base}/ai-control/resume`).set(owner.auth).send({}).expect(200);
  });
});

describe('access', () => {
  it('needs reports access to read, and is closed to other organisations', async () => {
    await ctx.http().get(P()).set(employee.auth).expect(403);
    await ctx.http().post(P()).set(viewer.auth).send({ name: 'x', statement: 'x', rules: [bigBills], tests: [] }).expect(403);
    await ctx.http().get(`${P()}/${policyId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/policies/${policyId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/policies`).set(outsider.auth).expect(200)).body.items).toEqual([]);
    const cat = (await ctx.http().get(`${P()}/catalogue`).set(viewer.auth).expect(200)).body;
    expect(cat.triggers.find((t: { key: string }) => t.key === 'BILL_POSTED').facts.some((f: { key: string }) => f.key === 'total')).toBe(true);
    expect(cat.policyLimits).toEqual({ rules: 10, tests: 30, backtestDays: 90 });
    expect(cat.members).toEqual([]);
  });
});
