import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantStorage } from '../src/common/tenant-context';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Either/or branches in workflow automations (WFLOW-005): conditions joined by "any of",
 * and actions done instead when the conditions do not hold. Real API, real database; the
 * runner is ticked by hand.
 */
let ctx: Ctx;
let runner: WorkflowRunnerService;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

const tick = () => tenantStorage.run({}, () => runner.tick());
const invoice = async (who: string, amount: string) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
const wf = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/workflows`).set(owner.auth).send(body);
const runsOf = async (id: string) => (await ctx.http().get(`${org.base}/workflows/${id}/runs`).set(owner.auth).expect(200)).body.filter((r: { status: string }) => r.status !== 'TEST');
const taskTitles = async () => ((await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all', status: 'ALL' }).set(owner.auth).expect(200)).body.tasks as { title: string }[]).map((t) => t.title).sort();

const task = (title: string) => ({ type: 'CREATE_TASK', title, assignTo: { role: 'OWNER' }, dueInDays: null });
const big = { fact: 'total', op: 'gte', value: '100000' };
const keyCustomer = { fact: 'contactName', op: 'contains', value: 'banyan' };

beforeAll(async () => {
  ctx = await bootApp();
  runner = ctx.app.get(WorkflowRunnerService);
  owner = await registerUser(ctx, 'Branch Owner');
  org = await createOrg(ctx, owner);
  for (const name of ['Banyan Retail', 'Small Shop']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('either/or branches', () => {
  let id: string;

  it('refuses otherwise actions with no condition, and checks them like the others', async () => {
    const none = await wf({ name: 'No condition', trigger: 'INVOICE_POSTED', conditions: [], actions: [task('a')], otherwise: [task('b')] }).expect(422);
    expect(none.body.details.issues).toEqual(['Add a condition before adding actions for when it does not hold']);
    const bad = await wf({ name: 'Bad', trigger: 'INVOICE_POSTED', conditions: [big], actions: [task('a')], otherwise: [task('Check {{vendorName}}')] }).expect(422);
    expect(bad.body.details.issues).toEqual(['Otherwise action 1: {{vendorName}} is not available for an invoice is posted']);
    await wf({ name: 'Bad match', trigger: 'INVOICE_POSTED', match: 'SOME', conditions: [big], actions: [task('a')] }).expect(400);
    const cat = (await ctx.http().get(`${org.base}/workflows/catalogue`).set(owner.auth).expect(200)).body;
    expect(cat.matches.map((m: { value: string }) => m.value)).toEqual(['ALL', 'ANY']);
  });

  it('runs the main actions when any condition holds and the otherwise actions when none does', async () => {
    const res = await wf({
      name: 'Large or key invoices',
      trigger: 'INVOICE_POSTED',
      match: 'ANY',
      conditions: [big, keyCustomer],
      actions: [task('Review {{number}} closely')],
      otherwise: [task('Spot-check {{number}}')],
    }).expect(201);
    id = res.body.id;
    expect(res.body).toMatchObject({ match: 'ANY', otherwise: [{ type: 'CREATE_TASK', title: 'Spot-check {{number}}' }] });
    expect((await ctx.http().get(`${org.base}/workflows`).set(owner.auth).expect(200)).body.find((w: { id: string }) => w.id === id)).toMatchObject({ match: 'ANY', actions: ['CREATE_TASK'], otherwise: ['CREATE_TASK'] });
    await ctx.http().post(`${org.base}/workflows/${id}/turn-on`).set(owner.auth).expect(200);
    await tick();

    const key = await invoice('Banyan Retail', '5000.00');
    const large = await invoice('Small Shop', '250000.00');
    const small = await invoice('Small Shop', '800.00');
    await tick();
    const runs = await runsOf(id);
    const byNumber = (n: string) => runs.find((r: { link: { label: string } }) => r.link.label === `Invoice ${n}`);
    expect(byNumber(key.number)).toMatchObject({ status: 'SUCCEEDED', branch: 'THEN', conditions: [{ passed: false }, { passed: true }] });
    expect(byNumber(large.number)).toMatchObject({ status: 'SUCCEEDED', branch: 'THEN', conditions: [{ passed: true }, { passed: false }] });
    expect(byNumber(small.number)).toMatchObject({ status: 'SUCCEEDED', branch: 'OTHERWISE', conditions: [{ passed: false }, { passed: false }], actions: [{ position: 0, type: 'CREATE_TASK', status: 'SUCCEEDED' }] });
    expect(await taskTitles()).toEqual([`Review ${key.number} closely`, `Review ${large.number} closely`, `Spot-check ${small.number}`].sort());
  });

  it('a test run shows the branch the event would take', async () => {
    const test = (await ctx.http().post(`${org.base}/workflows/${id}/test`).set(owner.auth).send({}).expect(200)).body;
    expect(test).toMatchObject({ matched: false, branch: 'OTHERWISE', run: { status: 'TEST', branch: 'OTHERWISE', actions: [{ type: 'CREATE_TASK', status: 'SKIPPED' }] } });
    expect(test.run.actions[0].input.title).toMatch(/^Spot-check /);
  });

  it('switching to all of the conditions makes a new version; without otherwise actions a miss is skipped', async () => {
    const cur = (await ctx.http().get(`${org.base}/workflows/${id}`).set(owner.auth).expect(200)).body;
    const saved = await ctx.http().put(`${org.base}/workflows/${id}`).set(owner.auth).send({ name: cur.name, trigger: cur.trigger, match: 'ALL', conditions: cur.conditions, actions: cur.actions, otherwise: cur.otherwise, baseVersion: cur.version }).expect(200);
    expect(saved.body).toMatchObject({ version: 2, match: 'ALL' });
    const same = await ctx.http().put(`${org.base}/workflows/${id}`).set(owner.auth).send({ name: cur.name, trigger: cur.trigger, match: 'ALL', conditions: cur.conditions, actions: cur.actions, otherwise: cur.otherwise, baseVersion: 2 }).expect(200);
    expect(same.body.version).toBe(2);
    const plain = await ctx.http().put(`${org.base}/workflows/${id}`).set(owner.auth).send({ name: cur.name, trigger: cur.trigger, conditions: cur.conditions, actions: cur.actions, baseVersion: 2 }).expect(200);
    expect(plain.body).toMatchObject({ version: 3, match: 'ALL', otherwise: [] });

    const key = await invoice('Banyan Retail', '6000.00');
    await tick();
    const run = (await runsOf(id)).find((r: { link: { label: string } }) => r.link.label === `Invoice ${key.number}`);
    expect(run).toMatchObject({ version: 3, status: 'SKIPPED', branch: null, actions: [] });
  });

  it('a version saved before branches existed reads as all of the conditions with no otherwise actions', async () => {
    await ctx.db.collection('workflow_versions').updateMany({ workflowId: id }, { $unset: { match: '', otherwise: '' } });
    const w = (await ctx.http().get(`${org.base}/workflows/${id}`).set(owner.auth).expect(200)).body;
    expect(w).toMatchObject({ match: 'ALL', otherwise: [] });
    const large = await invoice('Small Shop', '400000.00');
    await tick();
    expect((await runsOf(id)).find((r: { link: { label: string } }) => r.link.label === `Invoice ${large.number}`)).toMatchObject({ status: 'SKIPPED', branch: null });
  });
});
