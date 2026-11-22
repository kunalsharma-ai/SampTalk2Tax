import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { ACTION_KINDS, NEVER_ASSISTANT_ACTIONS } from '../src/copilot/copilot.actions';
import { CopilotService } from '../src/copilot/copilot.service';
import { CopilotTools } from '../src/copilot/copilot.tools';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * AP-036: the assistant may prepare payments but never execute or authorise them. Against the real
 * API and database with a scripted stand-in model: the assistant lists bills to pay and proposes a
 * draft batch; nothing exists until the member confirms; the batch it prepared is a draft that the
 * member who accepted it can never approve, even where self-approval is otherwise allowed; a second
 * person approves it. Proposals for bills already in a batch, past dates, other accounts or members
 * without the permission are refused, and no assistant action can approve, file or pay.
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
const reply = (content: unknown[], stop_reason: string): CopilotResponse =>
  ({ id: `msg_test_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const toolResult = (req: CopilotRequest) => {
  const last = req.messages[req.messages.length - 1] as { content: { type: string; content?: string; is_error?: boolean }[] };
  const b = last.content.find((x) => x.type === 'tool_result')!;
  return { error: !!b.is_error, body: b.is_error ? b.content : JSON.parse(b.content!) };
};

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
let ctx: Ctx;
const model = new ScriptedModel();
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let solo: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let soloOrg: Org;
const bills: Record<string, string> = {};
interface Action { id: string; kind: string; summary: string; sensitive: boolean; status: string; result: { path: string; label: string; batchId?: string } | null; error: string | null }
interface Conversation { id: string; messages: { sources: { tool: string; ok: boolean; error?: string }[] }[]; actions: Action[] }

const settle = () => Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
async function ask(o: Org, user: TestUser, question: string) {
  const c = (await ctx.http().post(`${o.base}/copilot/conversations`).set(user.auth).send({ question }).expect(201)).body as Conversation;
  await settle();
  return (await ctx.http().get(`${o.base}/copilot/conversations/${c.id}`).set(user.auth).expect(200)).body as Conversation;
}
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
async function vendorWithBills(o: Org, user: TestUser, verifier: TestUser, name: string, amounts: string[]) {
  const v = (await ctx.http().post(`${o.base}/contacts`).set(user.auth).send({ name, isVendor: true }).expect(201)).body.id as string;
  await ctx.http().put(`${o.base}/contacts/${v}/bank-details`).set(user.auth).send({ accountName: name, accountNumber: '123456789012', ifsc: 'HDFC0000001' }).expect(200);
  await ctx.http().post(`${o.base}/contacts/${v}/bank-details/verify`).set(verifier.auth).send({ note: 'Checked the cancelled cheque' }).expect(200);
  const ids: string[] = [];
  for (const [i, amount] of amounts.entries()) ids.push((await ctx.http().post(`${o.base}/purchases/documents`).set(user.auth).send({ kind: 'BILL', contactId: v, issueDate: addDays(T, -20 + i), dueDate: addDays(T, i), reference: `${name.slice(0, 3)}-${i}`, post: true, lines: [{ accountId: o.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body.id);
  return ids;
}

beforeAll(async () => {
  ctx = await bootApp({}, { copilotModel: model });
  owner = await registerUser(ctx, 'Guard Owner');
  approver = await registerUser(ctx, 'Guard Approver');
  viewer = await registerUser(ctx, 'Guard Viewer');
  solo = await registerUser(ctx, 'Guard Solo');
  org = await createOrg(ctx, owner, { name: 'Payment Guard Pvt Ltd' });
  soloOrg = await createOrg(ctx, solo, { name: 'Solo Guard Traders' });
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [o, u] of [[org, owner], [soloOrg, solo]] as const) await ctx.http().put(`${o.base}/copilot/settings`).set(u.auth).send({ enabled: true }).expect(200);
  [bills.p1, bills.p2] = await vendorWithBills(org, owner, approver, 'Paper Mart', ['2400.00', '1800.00']);
  [bills.s1] = await vendorWithBills(org, owner, approver, 'Swift Logistics', ['5000.00']);
  // One bill already in a batch prepared by hand.
  await ctx.http().post(`${org.base}/purchases/payment-batches`).set(owner.auth).send({ bankAccountId: org.acc['1120'], paymentDate: T, items: [{ documentId: bills.s1 }] }).expect(201);
  [bills.solo] = await vendorWithBills(soloOrg, solo, solo, 'Solo Vendor', ['700.00']);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
});

describe('the assistant prepares payments', () => {
  it('lists bills to pay and proposes a draft batch; nothing exists until the member confirms', async () => {
    model.steps.push(() => reply([toolUse('l1', 'list_payable_bills', {})], 'tool_use'));
    model.steps.push((req) => {
      const r = toolResult(req).body;
      expect(r.currency).toBe('INR');
      expect(r.bills.map((b: { number: string; vendor: string; amount_due: string; in_batch: string | null; vendor_bank_verified: boolean }) => [b.vendor, b.amount_due, b.in_batch, b.vendor_bank_verified])).toEqual([
        ['Paper Mart', '2400.00', null, true],
        ['Swift Logistics', '5000.00', 'PB-0001', true],
        ['Paper Mart', '1800.00', null, true],
      ]);
      // No bank account numbers reach the model.
      expect(JSON.stringify(r)).not.toContain('123456789012');
      expect(r.bank_accounts.map((a: { code: string }) => a.code)).toContain('1120');
      return reply([toolUse('p1', 'propose_payment_batch', { bank_account_ref: org.acc['1120'], payment_date: addDays(T, 1), bill_refs: [bills.p1, bills.p2] })], 'tool_use');
    });
    model.steps.push((req) => {
      expect(toolResult(req).body).toMatchObject({ proposed: true, done: false, sensitive: true });
      return reply([text('I have proposed a draft batch. Press Confirm to prepare it; an approver must still approve it.')], 'end_turn');
    });
    const c = await ask(org, owner, 'prepare payment for Paper Mart bills tomorrow');
    expect(c.messages[1]!.sources.map((s) => [s.tool, s.ok])).toEqual([['list_payable_bills', true], ['propose_payment_batch', true]]);
    const a = c.actions[0]!;
    expect(a).toMatchObject({ kind: 'PREPARE_PAYMENT_BATCH', status: 'PROPOSED', sensitive: true });
    const p1 = (await ctx.http().get(`${org.base}/purchases/documents/${bills.p1}`).set(owner.auth).expect(200)).body.number;
    expect(a.summary).toMatch(new RegExp(`^Prepare a draft payment batch from .+, dated ${addDays(T, 1)}, paying 2 bills for INR 4200\\.00 \\(${p1} Paper Mart 2400\\.00; .+ Paper Mart 1800\\.00\\)\\. Nothing is paid: someone other than you must approve the batch before a bank file can be made\\.$`));
    // Nothing prepared yet.
    expect((await ctx.http().get(`${org.base}/purchases/payment-batches`).set(owner.auth).expect(200)).body.batches).toHaveLength(1);

    const done = (await ctx.http().post(`${org.base}/copilot/actions/${a.id}/confirm`).set(owner.auth).expect(200)).body as Action;
    expect(done).toMatchObject({ status: 'DONE', result: { label: 'Payment batch PB-0002 (draft, waiting for approval)' } });
    const id = done.result!.batchId!;
    expect(done.result!.path).toBe(`/purchases/payment-batches/${id}`);
    const b = (await ctx.http().get(`${org.base}/purchases/payment-batches/${id}`).set(owner.auth).expect(200)).body;
    expect(b).toMatchObject({ status: 'DRAFT', total: '4200.00', createdById: owner.id, preparedWithCopilot: true, memo: 'Prepared with the assistant', approvedBy: null, paidAt: null });
    // No payment file until approved.
    await ctx.http().get(`${org.base}/purchases/payment-batches/${id}/file`).set(owner.auth).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    // The member who accepted it can never approve it; someone else does.
    expect((await ctx.http().post(`${org.base}/purchases/payment-batches/${id}/approve`).set(owner.auth).expect(409)).body).toMatchObject({ error: 'SAME_PERSON', message: 'This batch was prepared with the assistant, so someone other than the member who accepted it must approve it' });
    expect((await ctx.http().post(`${org.base}/purchases/payment-batches/${id}/approve`).set(approver.auth).expect(200)).body).toMatchObject({ status: 'APPROVED', selfApproved: false, preparedWithCopilot: true });
    // A batch prepared by hand is not marked.
    const manual = (await ctx.http().get(`${org.base}/purchases/payment-batches`).set(owner.auth).expect(200)).body.batches.find((x: { reference: string }) => x.reference === 'PB-0001');
    expect((await ctx.http().get(`${org.base}/purchases/payment-batches/${manual.id}`).set(owner.auth).expect(200)).body.preparedWithCopilot).toBe(false);
    const created = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'payment_batch.created' }, orderBy: { createdAt: 'asc' } });
    expect(created.map((e) => (e.data as { source?: string }).source ?? 'MEMBER')).toEqual(['MEMBER', 'COPILOT']);
  });

  it('is refused self-approval even where the only approver may approve their own batch', async () => {
    model.steps.push(() => reply([toolUse('s1', 'propose_payment_batch', { bank_account_ref: soloOrg.acc['1120'], payment_date: T, bill_refs: [bills.solo] })], 'tool_use'));
    model.steps.push(() => reply([text('Proposed.')], 'end_turn'));
    const c = await ask(soloOrg, solo, 'pay the solo vendor today');
    const done = (await ctx.http().post(`${soloOrg.base}/copilot/actions/${c.actions[0]!.id}/confirm`).set(solo.auth).expect(200)).body as Action;
    const id = done.result!.batchId!;
    expect((await ctx.http().post(`${soloOrg.base}/purchases/payment-batches/${id}/approve`).set(solo.auth).expect(409)).body.error).toBe('SAME_PERSON');
    // The same bills prepared by hand: the only approver may approve their own batch, marked as such.
    await ctx.http().delete(`${soloOrg.base}/purchases/payment-batches/${id}`).set(solo.auth).expect((r) => expect(r.status).toBeLessThan(300));
    const manual = (await ctx.http().post(`${soloOrg.base}/purchases/payment-batches`).set(solo.auth).send({ bankAccountId: soloOrg.acc['1120'], paymentDate: T, items: [{ documentId: bills.solo }] }).expect(201)).body;
    expect((await ctx.http().post(`${soloOrg.base}/purchases/payment-batches/${manual.id}/approve`).set(solo.auth).expect(200)).body).toMatchObject({ status: 'APPROVED', selfApproved: true });
  });
});

describe('what the assistant cannot do', () => {
  it('refuses bills already in a batch, past dates, other bank accounts and unknown bills', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ bank_account_ref: org.acc['1120'], payment_date: T, bill_refs: [bills.s1] }, /is already in batch PB-0001/],
      [{ bank_account_ref: org.acc['1120'], payment_date: addDays(T, -1), bill_refs: [bills.s1] }, /cannot be in the past/],
      [{ bank_account_ref: org.acc['6600'], payment_date: T, bill_refs: [bills.s1] }, /no such active bank account/],
      [{ bank_account_ref: org.acc['1120'], payment_date: T, bill_refs: [bills.solo] }, /not open for payment/],
    ];
    for (const [input, error] of cases) {
      model.steps.push(() => reply([toolUse('x', 'propose_payment_batch', input)], 'tool_use'));
      model.steps.push((req) => {
        const r = toolResult(req);
        expect(r.error).toBe(true);
        expect(r.body).toMatch(error);
        return reply([text('Could not propose it.')], 'end_turn');
      });
      const c = await ask(org, owner, 'pay this');
      expect(c.actions).toEqual([]);
    }
  });

  it('is not offered to members who cannot prepare payments', async () => {
    model.steps.push((req) => {
      const names = (req.tools ?? []).map((t) => (t as { name: string }).name);
      expect(names).toContain('list_payable_bills');
      expect(names).not.toContain('propose_payment_batch');
      return reply([text('You can see the bills, but preparing payments needs the purchases permission.')], 'end_turn');
    });
    await ask(org, viewer, 'pay the Paper Mart bills');
    const tools = ctx.app.get(CopilotTools);
    const r = await tools.run('propose_payment_batch', { bank_account_ref: org.acc['1120'], payment_date: T, bill_refs: [bills.p1] }, { orgId: org.orgId, role: 'VIEWER', today: T, fiscalYearStartMonth: 4 });
    expect(r.ok).toBe(false);
  });

  it('has no action that approves, files, records or transfers a payment', async () => {
    for (const k of NEVER_ASSISTANT_ACTIONS) expect(ACTION_KINDS as readonly string[]).not.toContain(k);
    const names = ctx.app.get(CopilotTools).names();
    expect(names.filter((x) => /approve|pay(?!able)|transfer|release|record|file/i.test(x) && x !== 'propose_payment_batch')).toEqual([]);
    // Even written straight into the database, such an action is refused.
    await expect(raw(`INSERT INTO copilot_actions (org_id, conversation_id, message_id, user_id, kind, input, summary, expires_at) SELECT org_id, conversation_id, message_id, user_id, 'APPROVE_PAYMENT_BATCH', '{}'::jsonb, 'x', now() + interval '1 hour' FROM copilot_actions WHERE org_id = $1::uuid LIMIT 1`, org.orgId)).rejects.toThrow(/copilot_actions_kind_check|kind/);
  });
});
