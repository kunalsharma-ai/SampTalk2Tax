import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantStorage } from '../src/common/tenant-context';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Workflow automations and tasks against the real API and database, with a real HTTP
 * receiver for webhooks on localhost. The runner is driven by hand (tick) instead of on a
 * timer, so each step is seen in order.
 */
let ctx: Ctx;
let runner: WorkflowRunnerService;
let owner: TestUser;
let accountant: TestUser;
let approver: TestUser;
let viewer: TestUser;
let employee: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- a webhook receiver
interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}
const received: Received[] = [];
const replies: number[] = [];
let receiver: http.Server;
let hookUrl: string;

// Run as the server does: outside any request, where the default context sees no tenant rows.
const tick = () => tenantStorage.run({}, () => runner.tick());
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const invoice = async (who: string, amount: string, extra: Record<string, unknown> = {}) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: T, dueDate: addDays(T, 30), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }], ...extra }).expect(201)).body;
const tasksOf = async (u: TestUser, q: Record<string, string> = {}) => (await ctx.http().get(`${org.base}/tasks`).query(q).set(u.auth).expect(200)).body;
const wf = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/workflows`).set(owner.auth).send(body);
const get = async (id: string) => (await ctx.http().get(`${org.base}/workflows/${id}`).set(owner.auth).expect(200)).body;
const runsOf = async (id: string, q: Record<string, string> = {}) => (await ctx.http().get(`${org.base}/workflows/${id}/runs`).query(q).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (b: Buffer) => chunks.push(b));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      const status = replies.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'thanks' : `nope ${status}`);
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/talk2tax`;

  ctx = await bootApp();
  runner = ctx.app.get(WorkflowRunnerService);
  owner = await registerUser(ctx, 'Flow Owner');
  accountant = await registerUser(ctx, 'Flow Accountant');
  approver = await registerUser(ctx, 'Flow Approver');
  viewer = await registerUser(ctx, 'Flow Viewer');
  employee = await registerUser(ctx, 'Flow Employee');
  stranger = await registerUser(ctx, 'Flow Stranger');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [approver, 'APPROVER'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [name, kind] of [['Banyan Retail', 'isCustomer'], ['Small Shop', 'isCustomer'], ['Teak Supplies', 'isVendor']] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id;
  }
});
afterAll(async () => {
  await ctx?.app.close();
  await new Promise((r) => receiver?.close(r));
});

describe('workflow automations', () => {
  let bigId: string;
  let firstInvoice: { id: string; number: string };

  it('offers triggers, facts, operators and the members a task can go to, to owners and admins only', async () => {
    const cat = (await ctx.http().get(`${org.base}/workflows/catalogue`).set(owner.auth).expect(200)).body;
    expect(cat.triggers.map((t: { key: string }) => t.key)).toEqual(['INVOICE_POSTED', 'BILL_POSTED', 'DOCUMENT_VOIDED', 'RECEIPT_RECORDED', 'VENDOR_PAYMENT_RECORDED', 'JOURNAL_POSTED', 'EXPENSE_CLAIM_SUBMITTED', 'ALERT_OPENED', 'SCHEDULE', 'INVOICE_OVERDUE', 'BILL_DUE_SOON']);
    expect(cat.triggers[0].facts.find((f: { key: string }) => f.key === 'total')).toEqual({ key: 'total', label: 'Total', type: 'money' });
    expect(cat.operators.money.map((o: { op: string }) => o.op)).toEqual(['gt', 'gte', 'lt', 'lte', 'eq']);
    // Employees cannot be given tasks.
    expect(cat.members.map((m: { name: string }) => m.name)).toEqual(['Flow Owner', 'Flow Accountant', 'Flow Approver', 'Flow Viewer']);
    expect(cat.limits).toMatchObject({ conditions: 10, actions: 5, webhookAttempts: 6, retryDelaysSeconds: [60, 300, 1800, 7200, 21600] });
    await ctx.http().get(`${org.base}/workflows`).set(accountant.auth).expect(403);
    await ctx.http().get(`${org.base}/workflows`).set(viewer.auth).expect(403);
    await ctx.http().get(`${org.base}/workflows`).set(stranger.auth).expect(404);
    await ctx.http().get(`${org.base}/tasks`).set(employee.auth).expect(403);
  });

  it('refuses a workflow with mistakes, listing every one', async () => {
    const res = await wf({
      name: 'Broken',
      trigger: 'INVOICE_POSTED',
      conditions: [
        { fact: 'amount', op: 'gt', value: '10' },
        { fact: 'total', op: 'gt', value: 'lots' },
        { fact: 'number', op: 'in', value: ['x'] },
      ],
      actions: [
        { type: 'CREATE_TASK', title: 'Check {{vendorName}}', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 400 },
        { type: 'CREATE_TASK', title: 'Someone', assignTo: { userId: stranger.id }, dueInDays: null },
        { type: 'WEBHOOK', url: 'ftp://example.com/x' },
      ],
    }).expect(422);
    expect(res.body.error).toBe('INVALID_WORKFLOW');
    expect(res.body.details.issues).toEqual([
      'Condition 1: "amount" is not available for an invoice is posted',
      'Condition 2: enter an amount for total',
      'Condition 3: Invoice number cannot use "in"',
      'Action 1: {{vendorName}} is not available for an invoice is posted',
      'Action 1: due in 0 to 365 days, or no due date',
      'Action 3: the address must start with https://',
    ]);
    // The member check runs once the definition itself is valid.
    const who = await wf({ name: 'Who', trigger: 'INVOICE_POSTED', conditions: [], actions: [{ type: 'CREATE_TASK', title: 'x', assignTo: { userId: stranger.id }, dueInDays: null }] }).expect(422);
    expect(who.body.message).toBe('Action 1: that person is not a member who can work on tasks');
    await wf({ name: 'Nothing', trigger: 'INVOICE_POSTED', conditions: [], actions: [] }).expect(422);
    await wf({ name: 'Bad trigger', trigger: 'PAYDAY', conditions: [], actions: [] }).expect(400);
  });

  it('a new workflow starts off, and a test run on a real invoice shows what it would do without doing it', async () => {
    firstInvoice = await invoice('Banyan Retail', '250000.00');
    const res = await wf({
      name: 'Large invoices',
      description: 'Check large invoices before they go out',
      trigger: 'INVOICE_POSTED',
      conditions: [{ fact: 'total', op: 'gte', value: '100000' }],
      actions: [
        { type: 'CREATE_TASK', title: 'Check {{number}} for {{contactName}} ({{total}})', description: 'Due {{dueDate}}. Reference: {{reference}}', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 2 },
        { type: 'WEBHOOK', url: hookUrl },
      ],
    }).expect(201);
    bigId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Large invoices', enabled: false, version: 1, triggerLabel: 'An invoice is posted', conditions: [{ fact: 'total', op: 'gte', value: '100000' }] });
    expect(res.body.signingSecret).toMatch(/^whsec_[0-9a-f]{48}$/);

    const test = (await ctx.http().post(`${org.base}/workflows/${bigId}/test`).set(owner.auth).send({}).expect(200)).body;
    expect(test.matched).toBe(true);
    expect(test.run).toMatchObject({ status: 'TEST', testedBy: 'Flow Owner', link: { path: `/sales/invoices/${firstInvoice.id}`, label: `Invoice ${firstInvoice.number}` } });
    expect(test.run.facts.find((f: { key: string }) => f.key === 'total').value).toBe('250000.00');
    expect(test.run.conditions).toEqual([{ condition: { fact: 'total', op: 'gte', value: '100000' }, label: 'Total is at least 100000', passed: true, actual: '250000.00' }]);
    expect(test.run.actions[0]).toMatchObject({ type: 'CREATE_TASK', status: 'SKIPPED', input: { title: `Check ${firstInvoice.number} for Banyan Retail (250000.00)`, description: `Due ${addDays(T, 30)}. Reference: —`, assigneeLabel: 'Accountants', dueDate: addDays(T, 2) } });
    expect(test.run.actions[1]).toMatchObject({ type: 'WEBHOOK', status: 'SKIPPED' });
    expect(received).toHaveLength(0);
    expect((await tasksOf(owner, { scope: 'all', status: 'ALL' })).tasks).toHaveLength(0);

    // Sending the webhook in a test marks it as a test, signed like a real one.
    const sent = (await ctx.http().post(`${org.base}/workflows/${bigId}/test`).set(owner.auth).send({ sendWebhooks: true }).expect(200)).body;
    expect(sent.run.actions[1]).toMatchObject({ status: 'SUCCEEDED', attempts: 1, history: [{ status: 200, ok: true, responseSnippet: 'thanks' }] });
    expect(received).toHaveLength(1);
    expect(received[0].json).toMatchObject({ test: true, event: 'INVOICE_POSTED', organizationId: org.orgId, workflow: { id: bigId, name: 'Large invoices', version: 1 }, entity: { type: 'document', id: firstInvoice.id }, data: { total: '250000.00', contactName: 'Banyan Retail' } });
    expect(received[0].json.data).not.toHaveProperty('_link');
    received.length = 0;
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'workflow' }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['workflow.created', 'workflow.tested', 'workflow.tested']);
  });

  it('once turned on, acts only on what happens afterwards: a task for large invoices, nothing for small ones', async () => {
    await tick();
    expect(await runsOf(bigId, { status: 'SUCCEEDED' })).toEqual([]);
    expect((await ctx.http().post(`${org.base}/workflows/${bigId}/turn-on`).set(owner.auth).expect(200)).body.enabled).toBe(true);
    await tick();
    // The invoice posted before it was turned on is not acted on.
    expect((await runsOf(bigId)).filter((r: { status: string }) => r.status !== 'TEST')).toEqual([]);

    const big = await invoice('Banyan Retail', '150000.00', { reference: 'PO-77' });
    const small = await invoice('Small Shop', '5000.00');
    const r1 = await tick();
    expect(r1.runs).toBe(2);
    const runs = (await runsOf(bigId)).filter((r: { status: string }) => r.status !== 'TEST');
    const skipped = runs.find((r: { status: string }) => r.status === 'SKIPPED');
    const acted = runs.find((r: { status: string }) => r.status !== 'SKIPPED');
    expect(skipped).toMatchObject({ link: { label: `Invoice ${small.number}` }, conditions: [{ label: 'Total is at least 100000', passed: false, actual: '5000.00' }], actions: [] });
    expect(acted.link.label).toBe(`Invoice ${big.number}`);
    // The webhook was sent in the same tick, after the task.
    expect(acted.status).toBe('SUCCEEDED');
    expect(acted.actions.map((a: { type: string; status: string }) => [a.type, a.status])).toEqual([
      ['CREATE_TASK', 'SUCCEEDED'],
      ['WEBHOOK', 'SUCCEEDED'],
    ]);

    // The task went to accountants, not to the viewer.
    const mine = await tasksOf(accountant);
    expect(mine.counts).toEqual({ mineOpen: 1, mineOverdue: 0 });
    expect(mine.tasks[0]).toMatchObject({
      title: `Check ${big.number} for Banyan Retail (150000.00)`,
      description: `Due ${addDays(T, 30)}. Reference: PO-77`,
      assignee: { type: 'role', role: 'ACCOUNTANT', label: 'Accountants' },
      dueDate: addDays(T, 2),
      link: { path: `/sales/invoices/${big.id}` },
      workflow: { id: bigId, name: 'Large invoices', runId: acted.id },
      createdBy: null,
      canClose: true,
    });
    expect((await tasksOf(viewer)).tasks).toEqual([]);
    await ctx.http().get(`${org.base}/tasks/${mine.tasks[0].id}`).set(viewer.auth).expect(404);

    // The receiver got a signed body it can check with the workflow's secret.
    expect(received).toHaveLength(1);
    const h = received[0].headers;
    const { t, v1 } = Object.fromEntries(String(h['t2t-signature']).split(',').map((p) => p.split('='))) as { t: string; v1: string };
    const secret = (await get(bigId)).signingSecret;
    expect(createHmac('sha256', secret).update(`${t}.${received[0].body}`).digest('hex')).toBe(v1);
    expect(Math.abs(+t - Date.now() / 1000)).toBeLessThan(60);
    expect(h['t2t-event']).toBe('INVOICE_POSTED');
    expect(h['t2t-delivery']).toBe(received[0].json.id);
    expect(h['t2t-attempt']).toBe('1');
    expect(received[0].json).toMatchObject({ test: false, data: { number: big.number, total: '150000.00', reference: 'PO-77' } });
    received.length = 0;

    // Nothing is done twice.
    expect((await tick()).runs).toBe(0);
    expect((await tasksOf(accountant)).tasks).toHaveLength(1);
  });

  it('retries a webhook that fails, stops on an answer that will not change, and can be retried by hand', async () => {
    replies.push(503);
    await invoice('Banyan Retail', '300000.00');
    await tick();
    let run = (await runsOf(bigId, { status: 'RUNNING' }))[0];
    const hook = run.actions[1];
    expect(hook).toMatchObject({ status: 'PENDING', attempts: 1, error: 'Answered 503', history: [{ status: 503, ok: false, responseSnippet: 'nope 503' }] });
    // The next try is a minute later.
    const wait = Date.parse(hook.nextAttemptAt) - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThan(61_000);
    await tick();
    expect(received).toHaveLength(1);

    // Time passes; the receiver now refuses the request outright, which is not retried.
    await raw(`UPDATE workflow_action_runs SET next_attempt_at = now() - interval '1 second' WHERE run_id = $1::uuid AND status = 'PENDING'`, run.id);
    replies.push(410);
    await tick();
    run = (await ctx.http().get(`${org.base}/workflow-runs/${run.id}`).set(owner.auth).expect(200)).body;
    expect(run).toMatchObject({ status: 'FAILED', error: 'Action 2: Answered 410' });
    expect(run.actions[1]).toMatchObject({ status: 'FAILED', attempts: 2, nextAttemptAt: null, canRetry: true });
    expect(received.map((r) => r.headers['t2t-attempt'])).toEqual(['1', '2']);
    // The same delivery, byte for byte.
    expect(received[1].body).toBe(received[0].body);
    expect((await ctx.http().get(`${org.base}/workflows`).set(owner.auth).expect(200)).body[0]).toMatchObject({ name: 'Large invoices', lastRun: { status: 'FAILED' }, last30Days: { acted: 1, skipped: 1, failed: 1 } });

    // Retry now: the run is running again until the delivery succeeds.
    await ctx.http().post(`${org.base}/workflow-runs/${run.id}/actions/0/retry`).set(owner.auth).expect(409);
    await ctx.http().post(`${org.base}/workflow-runs/${run.id}/actions/1/retry`).set(accountant.auth).expect(403);
    const again = (await ctx.http().post(`${org.base}/workflow-runs/${run.id}/actions/1/retry`).set(owner.auth).expect(200)).body;
    expect(again).toMatchObject({ status: 'RUNNING', error: null, actions: [{}, { status: 'PENDING' }] });
    await tick();
    run = (await ctx.http().get(`${org.base}/workflow-runs/${run.id}`).set(owner.auth).expect(200)).body;
    expect(run).toMatchObject({ status: 'SUCCEEDED', actions: [{}, { status: 'SUCCEEDED', attempts: 3 }] });
    expect(run.actions[1].history.map((x: { status: number }) => x.status)).toEqual([503, 410, 200]);
    await ctx.http().post(`${org.base}/workflow-runs/${run.id}/actions/1/retry`).set(owner.auth).expect(409);
    received.length = 0;
  });

  it('a network failure is retried, and six failed attempts end the delivery', async () => {
    const dead = await wf({ name: 'Dead end', trigger: 'BILL_POSTED', conditions: [], actions: [{ type: 'WEBHOOK', url: 'http://127.0.0.1:1/nothing-here' }] }).expect(201);
    await ctx.http().post(`${org.base}/workflows/${dead.body.id}/turn-on`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c['Teak Supplies'], issueDate: T, reference: 'TS-1', post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '999.00' }] }).expect(201);
    await tick();
    for (let i = 0; i < 5; i++) {
      await raw(`UPDATE workflow_action_runs a SET next_attempt_at = now() - interval '1 second' FROM workflow_runs r WHERE r.id = a.run_id AND r.workflow_id = $1::uuid AND a.status = 'PENDING'`, dead.body.id);
      await tick();
    }
    const [run] = await runsOf(dead.body.id);
    expect(run).toMatchObject({ status: 'FAILED', facts: expect.arrayContaining([expect.objectContaining({ key: 'reference', value: 'TS-1' })]) });
    expect(run.actions[0]).toMatchObject({ status: 'FAILED', attempts: 6, error: 'The connection was refused' });
    expect(run.actions[0].history).toHaveLength(6);
    await ctx.http().post(`${org.base}/workflows/${dead.body.id}/turn-off`).set(owner.auth).expect(200);
  });

  it('a change makes a new version; runs keep the version they ran; a stale edit is refused', async () => {
    const w = await get(bigId);
    const body = { name: w.name, description: w.description, trigger: w.trigger, conditions: [{ fact: 'total', op: 'gt', value: '400000' }], actions: w.actions, baseVersion: 1, note: 'Only very large invoices' };
    const v2 = (await ctx.http().put(`${org.base}/workflows/${bigId}`).set(owner.auth).send(body).expect(200)).body;
    expect(v2).toMatchObject({ version: 2, conditions: [{ value: '400000' }], versions: [{ version: 2, note: 'Only very large invoices', createdBy: 'Flow Owner' }, { version: 1 }] });
    const stale = await ctx.http().put(`${org.base}/workflows/${bigId}`).set(owner.auth).send(body).expect(409);
    expect(stale.body.error).toBe('WORKFLOW_CHANGED');
    // A new name alone is not a new version.
    expect((await ctx.http().put(`${org.base}/workflows/${bigId}`).set(owner.auth).send({ ...body, name: 'Very large invoices', baseVersion: 2 }).expect(200)).body).toMatchObject({ name: 'Very large invoices', version: 2 });
    await invoice('Banyan Retail', '200000.00');
    await tick();
    const runs = (await runsOf(bigId)).filter((r: { status: string }) => r.status !== 'TEST');
    expect(runs[0]).toMatchObject({ version: 2, status: 'SKIPPED', conditions: [{ label: 'Total is more than 400000', passed: false }] });
    expect(runs.slice(1).every((r: { version: number }) => r.version === 1)).toBe(true);
    await ctx.http().post(`${org.base}/workflows/${bigId}/turn-off`).set(owner.auth).expect(200);
    await invoice('Banyan Retail', '500000.00');
    expect((await tick()).runs).toBe(0);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'workflow', entityId: bigId }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['workflow.created', 'workflow.tested', 'workflow.tested', 'workflow.turned_on', 'workflow.updated', 'workflow.updated', 'workflow.turned_off']);
  });

  it('every trigger reads its facts from the real records', async () => {
    const flows: Record<string, string> = {};
    const add = async (trigger: string, title: string, conditions: unknown[] = []) => {
      const res = await wf({ name: `On ${trigger}`, trigger, conditions, actions: [{ type: 'CREATE_TASK', title, assignTo: { userId: approver.id }, dueInDays: null }] }).expect(201);
      await ctx.http().post(`${org.base}/workflows/${res.body.id}/turn-on`).set(owner.auth).expect(200);
      flows[trigger] = res.body.id;
    };
    await add('RECEIPT_RECORDED', 'Receipt {{number}}: {{amount}} from {{contactName}} on {{date}}');
    await add('VENDOR_PAYMENT_RECORDED', 'Paid {{contactName}} {{amount}}');
    await add('JOURNAL_POSTED', 'Journal {{number}} by {{postedBy}}: {{memo}} ({{total}})', [{ fact: 'memo', op: 'contains', value: 'accrual' }]);
    await add('DOCUMENT_VOIDED', 'Voided {{number}} ({{kind}}): {{reason}}', [{ fact: 'kind', op: 'in', value: ['INVOICE'] }]);
    await add('EXPENSE_CLAIM_SUBMITTED', 'Claim {{number}} by {{claimant}}: {{title}} {{total}}');
    await add('ALERT_OPENED', '{{severity}} alert from {{check}}: {{title}}', [{ fact: 'severity', op: 'in', value: ['CRITICAL', 'WARNING'] }]);

    const inv = await invoice('Small Shop', '11800.00');
    await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c['Small Shop'], date: T, bankAccountId: org.acc['1120'], amount: '11800.00', reference: 'UTR-1', allocations: [{ documentId: inv.id, amount: '11800.00' }] }).expect(201);
    await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: c['Teak Supplies'], date: T, bankAccountId: org.acc['1120'], amount: '999.00', allocations: [] }).expect(201);
    const accrualRes = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'Month-end accrual', lines: [{ accountId: org.acc['6400'], debit: '2500.00' }, { accountId: org.acc['2200'], credit: '2500.00' }] }).expect(201);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, post: true, memo: 'Something else', lines: [{ accountId: org.acc['6400'], debit: '10.00' }, { accountId: org.acc['2200'], credit: '10.00' }] }).expect(201);
    const toVoid = await invoice('Small Shop', '700.00');
    await ctx.http().post(`${org.base}/sales/documents/${toVoid.id}/void`).set(owner.auth).send({ date: T, reason: 'Raised twice' }).expect(200);
    const claim = (await ctx.http().post(`${org.base}/expense-claims`).set(owner.auth).send({ title: 'Client visit', lines: [{ date: T, accountId: org.acc['6600'], merchant: 'Cabs', amount: '450.00' }] }).expect(201)).body;
    await ctx.http().post(`${org.base}/expense-claims/${claim.id}/submit`).set(owner.auth).send({}).expect(200);
    // An overdue invoice for the checks to find.
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c['Small Shop'], issueDate: addDays(T, -90), dueDate: addDays(T, -75), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '64000.00' }] }).expect(201);
    await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
    await tick();

    const titles = (await tasksOf(approver)).tasks.map((t: { title: string }) => t.title).sort();
    const accrual = accrualRes.body.entry ?? accrualRes.body;
    expect(titles).toEqual(
      [
        `Claim ${claim.number} by Flow Owner: Client visit 450.00`,
        'Paid Teak Supplies 999.00',
        `Receipt RCPT-000001: 11800.00 from Small Shop on ${T}`,
        `Journal #${accrual.entryNumber} by Flow Owner: Month-end accrual (2500.00)`,
        `Voided ${toVoid.number} (INVOICE): Raised twice`,
        'WARNING alert from Overdue customer invoices: Small Shop owes ₹64,000 more than 30 days overdue',
      ].sort(),
    );
    // Journals made by other modules (the invoices and payments above) are not manual journals.
    const journalRuns = await runsOf(flows.JOURNAL_POSTED);
    expect(journalRuns.map((r: { status: string }) => r.status).sort()).toEqual(['SKIPPED', 'SUCCEEDED']);
  });

  it('a task for someone who has left fails that action and says why', async () => {
    const res = await wf({ name: 'For the viewer', trigger: 'RECEIPT_RECORDED', conditions: [], actions: [{ type: 'CREATE_TASK', title: 'Thank {{contactName}}', assignTo: { userId: viewer.id }, dueInDays: 0 }] }).expect(201);
    await ctx.http().post(`${org.base}/workflows/${res.body.id}/turn-on`).set(owner.auth).expect(200);
    await ctx.http().delete(`${org.base}/members/${viewer.id}`).set(owner.auth).expect((r) => expect([200, 204]).toContain(r.status));
    await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c['Banyan Retail'], date: T, bankAccountId: org.acc['1120'], amount: '100.00', allocations: [] }).expect(201);
    await tick();
    const [run] = await runsOf(res.body.id);
    expect(run).toMatchObject({ status: 'FAILED', error: 'Action 1: The person this task is for is not a member who can work on tasks', actions: [{ status: 'FAILED', input: { assigneeLabel: 'Someone no longer in the organisation' } }] });
  });
});

describe('tasks', () => {
  let taskId: string;

  it('members give each other tasks and close their own; others cannot', async () => {
    const t = (await ctx.http().post(`${org.base}/tasks`).set(accountant.auth).send({ title: 'Send the TDS certificates', description: 'Form 16A for Q2', assignTo: { userId: approver.id }, dueDate: addDays(T, -1) }).expect(201)).body;
    taskId = t.id;
    expect(t).toMatchObject({ status: 'OPEN', assignee: { type: 'user', label: 'Flow Approver' }, createdBy: 'Flow Accountant', overdue: true, workflow: null, link: null });
    expect((await tasksOf(approver)).counts.mineOverdue).toBe(1);
    await ctx.http().post(`${org.base}/tasks`).set(accountant.auth).send({ title: 'x', assignTo: { userId: stranger.id } }).expect(422);
    await ctx.http().post(`${org.base}/tasks`).set(accountant.auth).send({ title: 'x', assignTo: { role: 'EMPLOYEE' } }).expect(400);
    await ctx.http().post(`${org.base}/tasks`).set(accountant.auth).send({ title: 'x', assignTo: { role: 'VIEWER' }, dueDate: '2026-02-30' }).expect(400);
    // The accountant (creator) sees it but it is not "mine"; accountants' role tasks are.
    expect((await tasksOf(accountant)).tasks.map((x: { id: string }) => x.id)).not.toContain(taskId);
    expect((await ctx.http().get(`${org.base}/tasks/${taskId}`).set(accountant.auth).expect(200)).body.canClose).toBe(true);
    await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all' }).set(accountant.auth).expect(403);
    expect((await tasksOf(owner, { scope: 'all', status: 'ALL' })).tasks.length).toBeGreaterThan(5);

    const done = (await ctx.http().post(`${org.base}/tasks/${taskId}/complete`).set(approver.auth).send({ note: 'Sent by email' }).expect(200)).body;
    expect(done).toMatchObject({ status: 'DONE', closedBy: 'Flow Approver', closeNote: 'Sent by email', overdue: false, canClose: false });
    expect((await ctx.http().post(`${org.base}/tasks/${taskId}/cancel`).set(approver.auth).send({}).expect(409)).body.error).toBe('TASK_CLOSED');
    expect((await tasksOf(approver, { status: 'DONE' })).tasks.map((x: { id: string }) => x.id)).toContain(taskId);
    expect((await ctx.http().get(`${org.base}/tasks/count`).set(approver.auth).expect(200)).body.open).toBe((await tasksOf(approver)).tasks.length);

    const roleTask = (await ctx.http().post(`${org.base}/tasks`).set(owner.auth).send({ title: 'Approvers: review the policy', assignTo: { role: 'APPROVER' } }).expect(201)).body;
    await ctx.http().post(`${org.base}/tasks/${roleTask.id}/complete`).set(accountant.auth).send({}).expect(404);
    expect((await ctx.http().post(`${org.base}/tasks/${roleTask.id}/cancel`).set(approver.auth).send({ note: 'Not needed' }).expect(200)).body.status).toBe('CANCELLED');
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'task', entityId: { in: [taskId, roleTask.id] } }, orderBy: { id: 'asc' }, select: { action: true, actorId: true } });
    expect(audit).toEqual([
      { action: 'task.created', actorId: accountant.id },
      { action: 'task.completed', actorId: approver.id },
      { action: 'task.created', actorId: owner.id },
      { action: 'task.cancelled', actorId: approver.id },
    ]);
  });

  it('the database refuses changes to history and keeps organisations apart', async () => {
    const run = await ctx.prisma.workflowRun.findFirstOrThrow({ where: { orgId: org.orgId, status: 'SUCCEEDED' } });
    const version = await ctx.prisma.workflowVersion.findFirstOrThrow({ where: { orgId: org.orgId } });
    const w = await ctx.prisma.workflow.findFirstOrThrow({ where: { orgId: org.orgId } });
    await expect(raw(`UPDATE workflow_versions SET conditions = '[]' WHERE id = $1::uuid`, version.id)).rejects.toThrow(/workflow version cannot be changed/);
    await expect(raw(`DELETE FROM workflows WHERE id = $1::uuid`, w.id)).rejects.toThrow(/turn it off instead/);
    await expect(raw(`UPDATE workflow_runs SET status = 'FAILED', error = 'x' WHERE id = $1::uuid`, run.id)).rejects.toThrow(/finished workflow run cannot be changed/);
    await expect(raw(`UPDATE workflow_runs SET facts = '{}' WHERE id = $1::uuid`, run.id)).rejects.toThrow(/finished workflow run/);
    await expect(raw(`UPDATE workflow_action_runs SET status = 'PENDING', finished_at = NULL WHERE run_id = $1::uuid`, run.id)).rejects.toThrow(/finished workflow action cannot be changed/);
    await expect(raw(`UPDATE workflow_cursors SET last_event_id = 0 WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/only moves forward/);
    await expect(raw(`UPDATE tasks SET title = 'changed' WHERE id = $1::uuid`, taskId)).rejects.toThrow(/closed task cannot be changed/);
    await expect(raw(`DELETE FROM tasks WHERE id = $1::uuid`, taskId)).rejects.toThrow(/cancel it instead/);
    await expect(raw(`INSERT INTO tasks (id, org_id, title, assignee_user_id, assignee_role, updated_at) VALUES ($1::uuid, $2::uuid, 'both', $3::uuid, 'VIEWER', now())`, randomUUID(), org.orgId, owner.id)).rejects.toThrow(/tasks_chk/);
    await expect(raw(`INSERT INTO workflow_runs (id, org_id, workflow_id, version, trigger, facts, conditions, status) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'INVOICE_POSTED', '{}', '[]', 'SUCCEEDED')`, randomUUID(), org.orgId, w.id)).rejects.toThrow(/workflow_runs_chk/);

    // Another organisation sees none of these rows, even reading the tables directly.
    const other = await createOrg(ctx, stranger, { name: 'Other Co' });
    const seen = await ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', '', true), set_config('t2t.org_id', $1, true)`, other.orgId);
      const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT (SELECT count(*) FROM tasks) + (SELECT count(*) FROM workflows) + (SELECT count(*) FROM workflow_runs) + (SELECT count(*) FROM workflow_action_runs) + (SELECT count(*) FROM workflow_versions) + (SELECT count(*) FROM workflow_cursors) AS n`);
      return Number(rows[0].n);
    });
    expect(seen).toBe(0);
    await ctx.http().get(`${org.base}/tasks/${taskId}`).set(stranger.auth).expect(404);
  });
});
