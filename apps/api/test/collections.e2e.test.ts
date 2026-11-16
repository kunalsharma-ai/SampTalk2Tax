import Anthropic from '@anthropic-ai/sdk';
import { formatAmountText, formatDateText } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { CollectionsService, MAX_CUSTOMERS_PER_RUN } from '../src/collections/collections.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The AI collections agent against the real API, the real database and real SMTP. The
 * language model is a scripted stand-in that "drafts" what each test says; the test checks
 * what the agent sends it (the facts, from real postings), how each draft is checked against
 * the books, and that nothing reaches a customer until a person approves it.
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
const reply = (content: unknown[], stop_reason = 'tool_use', model = 'claude-opus-5-5') =>
  ({ id: `msg_c_${++n}`, type: 'message', role: 'assistant', model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 250, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;
const submit = (input: Record<string, unknown>) => reply([{ type: 'tool_use', id: `tu_${n}`, name: 'submit_reminder', input }]);

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const inr = (v: string) => formatAmountText(v, 'INR');

let ctx: Ctx;
let bare: Ctx;
let noMail: Ctx;
let smtp: SmtpStandIn;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let B: string;
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};

const settle = () => Promise.all([...ctx.app.get(CollectionsService).inflight.values()]);
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const invoice = async (key: string, who: string, amount: string, dueDate: string) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: addDays(dueDate, -15) < T ? addDays(dueDate, -15) : T, dueDate, reference: `PO-${key}`, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
  inv[key] = { id: d.id, number: d.number };
};
const receipt = (who: string, amount: string, allocations: { documentId: string; amount: string }[]) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date: T, bankAccountId: org.acc['1120'], amount, allocations, post: true }).expect(201);
const run = async (auth = owner.auth) => (await ctx.http().post(`${B}/runs`).set(auth).expect(201)).body;
const reminders = async (status?: string) => (await ctx.http().get(`${B}/reminders${status ? `?status=${status}` : ''}`).set(owner.auth).expect(200)).body as Reminder[];
const reminderFor = async (customer: string) => (await reminders()).find((r) => r.customer === customer)!;
const audits = async (prefix = 'collections.') => (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: prefix } }, orderBy: { createdAt: 'asc' } })).map((a) => a.action);

interface Reminder {
  id: string;
  customer: string;
  toEmail: string;
  status: string;
  risk: string | null;
  riskReasons: string[] | null;
  subject: string | null;
  body: string | null;
  aiSubject: string | null;
  edited: boolean;
  checks: { ok: boolean; label: string }[] | null;
  canSend: boolean;
  facts: { totalOverdue: string; averageDaysLate: number | null; lastPayment: { amount: string } | null; overdue: { number: string; balance: string; daysOverdue: number; documentId: string | null }[] };
  servedModel: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  errorCode: string | null;
  errorMessage: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  sendAttempts: number;
  sendLog: { ok: boolean; status: number | null }[] | null;
  sentAt: string | null;
}

/** A reminder that states Banyan's figures exactly as the books have them. */
const banyanBody = () =>
  [
    'Dear Banyan Retail,',
    '',
    `Thank you for your payment of ${inr('15000.00')}.`,
    `${inv.a.number} still has ${inr('45000.00')} to pay (due ${formatDateText(addDays(T, -40))}), and ${inv.b.number} has ${inr('12345.67')} (due ${formatDateText(addDays(T, -10))}).`,
    `The total still to pay is ${inr('57345.67')}. Please pay, or reply if something is wrong.`,
    '',
    'Accounts team',
  ].join('\n');

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  const mail = { SMTP_URL: smtp.url, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>' };
  ctx = await bootApp(mail, { copilotModel: model });
  bare = await bootApp(mail);
  noMail = await bootApp({ SMTP_URL: '', EMAIL_FROM: '' }, { copilotModel: model });
  owner = await registerUser(ctx, 'Collections Owner');
  accountant = await registerUser(ctx, 'Collections Accountant');
  viewer = await registerUser(ctx, 'Collections Viewer');
  employee = await registerUser(ctx, 'Collections Employee');
  org = await createOrg(ctx, owner, { name: 'Collections Test Pvt Ltd' });
  B = `${org.base}/collections`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [name, email] of [['Banyan Retail', 'accounts@banyan.test'], ['Cedar Mart', 'pay@cedar.test'], ['Lotus Stores', null], ['Teak Traders', 'ap@teak.test']] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true, ...(email ? { email } : {}) }).expect(201)).body.id;
  }
  await invoice('paid', 'Banyan Retail', '10000.00', addDays(T, -60));
  await invoice('a', 'Banyan Retail', '50000.00', addDays(T, -40));
  await invoice('b', 'Banyan Retail', '12345.67', addDays(T, -10));
  await invoice('cedar', 'Cedar Mart', '20000.00', addDays(T, -3));
  await invoice('lotus', 'Lotus Stores', '8000.00', addDays(T, -5));
  await invoice('teak', 'Teak Traders', '30000.00', addDays(T, 10));
  // Banyan paid one invoice in full, 60 days late, and part of another.
  await receipt('Banyan Retail', '15000.00', [{ documentId: inv.paid.id, amount: '10000.00' }, { documentId: inv.a.id, amount: '5000.00' }]);
});
afterAll(async () => {
  await settle();
  await ctx?.app.close();
  await bare?.app.close();
  await noMail?.app.close();
  await smtp?.close();
});

describe('setting up', () => {
  it('says clearly when the server has no AI key, and drafts nothing', async () => {
    const borg = await createOrg(bare, owner, { name: 'No Key Collections Ltd' });
    await bare.http().put(`${borg.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const o = (await bare.http().get(`${borg.base}/collections`).set(owner.auth).expect(200)).body;
    expect(o).toMatchObject({ aiConfigured: false, aiEnabled: true, emailReady: true, emailFrom: 'Talk2Tax <robot@talk2tax.test>' });
    const r = await bare.http().post(`${borg.base}/collections/runs`).set(owner.auth).expect(503);
    expect(r.body.error).toBe('AI_NOT_CONFIGURED');
    expect(r.body.message).toContain('ANTHROPIC_API_KEY');
    expect(await bare.prisma.collectionRun.count({ where: { orgId: borg.orgId } })).toBe(0);
  });

  it('needs AI turned on for the organisation, and only accountants and above can use it', async () => {
    const o = (await ctx.http().get(B).set(accountant.auth).expect(200)).body;
    expect(o).toMatchObject({ aiConfigured: true, aiEnabled: false, emailReady: true, canChangeAi: false, limits: { customersPerRun: MAX_CUSTOMERS_PER_RUN, remindAgainAfterDays: 7 }, latestRun: null });
    expect((await ctx.http().post(`${B}/runs`).set(owner.auth).expect(409)).body.error).toBe('AI_OFF');
    await ctx.http().get(B).set(viewer.auth).expect(403);
    await ctx.http().post(`${B}/runs`).set(employee.auth).expect(403);
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    expect(model.requests).toHaveLength(0);
  });
});

describe('drafting', () => {
  it('drafts one reminder per overdue customer from the books and skips those it cannot email', async () => {
    model.steps.push(
      () => submit({ risk: 'MEDIUM', riskReasons: ['Oldest invoice is 40 days overdue', 'Paid the last invoice 60 days late'], subject: `Payment reminder: ${inv.a.number} and ${inv.b.number}`, body: banyanBody() }),
      () => submit({ risk: 'LOW', riskReasons: ['Only 3 days overdue'], subject: `Reminder: ${inv.cedar.number}`, body: `Dear Cedar Mart,\n\n${inv.cedar.number} for ${inr('20000.00')} was due on ${formatDateText(addDays(T, -3))}. Please pay ${inr('20000.00')}, or reply if you already have.\n\nAccounts team` }),
    );
    const o = await run(accountant.auth);
    expect(o.latestRun).toMatchObject({ status: 'RUNNING', startedBy: 'Collections Accountant', drafts: 2 });
    expect(o.latestRun.skipped).toEqual([{ contactId: c['Lotus Stores'], name: 'Lotus Stores', reason: 'No email address on the customer' }]);
    await settle();

    const list = await reminders();
    expect(list.map((r) => [r.customer, r.status, r.risk])).toEqual(expect.arrayContaining([['Banyan Retail', 'READY', 'MEDIUM'], ['Cedar Mart', 'READY', 'LOW']]));
    expect(list).toHaveLength(2);
    const banyan = list.find((r) => r.customer === 'Banyan Retail')!;
    expect(banyan.toEmail).toBe('accounts@banyan.test');
    expect(banyan.facts.totalOverdue).toBe('57345.67');
    expect(banyan.facts.overdue.map((i) => [i.number, i.balance, i.daysOverdue, i.documentId])).toEqual([[inv.a.number, '45000.00', 40, inv.a.id], [inv.b.number, '12345.67', 10, inv.b.id]]);
    expect(banyan.facts.averageDaysLate).toBe(60);
    expect(banyan.facts.lastPayment?.amount).toBe('15000.00');
    expect(banyan.checks!.every((x) => x.ok)).toBe(true);
    expect(banyan).toMatchObject({ canSend: true, edited: false, servedModel: 'claude-opus-5-5', usage: { inputTokens: 900, outputTokens: 250 }, sendAttempts: 0, sentAt: null });
    expect(smtp.messages).toHaveLength(0);

    // What the model was given: the business, a forced submit, and the facts as text.
    const [first] = model.requests;
    expect(first.tool_choice).toEqual({ type: 'tool', name: 'submit_reminder' });
    expect(first.tools!.map((t) => (t as { name: string }).name)).toEqual(['submit_reminder']);
    expect(first.thinking).toBeUndefined();
    expect(first.system).toContain('"Collections Test Pvt Ltd"');
    expect(first.system).toContain('you never send anything');
    expect(first.metadata).toEqual({ user_id: accountant.id });
    const facts = (first.messages[0].content as { text: string }[])[0].text;
    expect(facts).toContain('Customer: Banyan Retail');
    expect(facts).toContain(`- ${inv.a.number} (their reference PO-a): issued`);
    expect(facts).toContain(`40 days overdue, invoice total ${inr('50000.00')}, still to pay ${inr('45000.00')}`);
    expect(facts).toContain(`total still to pay ${inr('57345.67')}`);
    expect(facts).toContain('on average 60 days after the due date');
    expect(facts).toContain(`Last payment received: ${inr('15000.00')}`);
    expect(facts).not.toContain('Teak');

    const o2 = (await ctx.http().get(B).set(owner.auth).expect(200)).body;
    expect(o2.latestRun.status).toBe('DONE');
    expect(o2.counts).toEqual({ READY: 2 });
    expect(await audits()).toEqual(['collections.drafting_started', 'collections.reminder_drafted', 'collections.reminder_drafted', 'collections.drafting_finished']);
  });

  it('does not draft again for a customer whose reminder is waiting for review', async () => {
    const o = await run();
    expect(o.latestRun).toMatchObject({ status: 'DONE', drafts: 0 });
    expect(o.latestRun.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason])).toEqual([
      ['Banyan Retail', 'A reminder is already waiting for review'],
      ['Cedar Mart', 'A reminder is already waiting for review'],
      ['Lotus Stores', 'No email address on the customer'],
    ]);
    expect(model.requests).toHaveLength(2);
  });
});

describe('reviewing and sending', () => {
  it('checks an edit against the books and refuses to send figures that are not in them', async () => {
    const r = await reminderFor('Banyan Retail');
    const wrong = banyanBody().replace(inr('45000.00'), inr('46000.00')).replace(`${inv.b.number} has`, 'INV-9999 has');
    const chk = (await ctx.http().post(`${B}/reminders/${r.id}/check`).set(owner.auth).send({ subject: 'Payment reminder', body: wrong }).expect(200)).body;
    expect(chk.passes).toBe(false);
    expect(chk.checks.filter((x: { ok: boolean }) => !x.ok).map((x: { label: string }) => x.label)).toEqual([`Amounts not in the books: ${inr('46000.00')}`, "Invoice numbers that are not this customer's: INV-9999", `Overdue invoices not mentioned: ${inv.b.number}`]);
    const res = await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({ subject: 'Payment reminder', body: wrong }).expect(422);
    expect(res.body.error).toBe('DRAFT_CHECKS_FAILED');
    expect(res.body.details.issues).toHaveLength(3);
    await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({ subject: 'Line one\nLine two' }).expect(422);
    expect(smtp.messages).toHaveLength(0);
    expect((await reminderFor('Banyan Retail')).status).toBe('READY');
  });

  it('sends an approved reminder, with the edits, once', async () => {
    const r = await reminderFor('Banyan Retail');
    const body = `${banyanBody()}\nPhone: 022 4000 1234`;
    const sent = (await ctx.http().post(`${B}/reminders/${r.id}/send`).set(accountant.auth).send({ subject: 'Overdue invoices from Collections Test', body }).expect(200)).body as Reminder;
    expect(sent).toMatchObject({ status: 'SENT', edited: true, decidedBy: 'Collections Accountant', sendAttempts: 1, canSend: false, aiSubject: `Payment reminder: ${inv.a.number} and ${inv.b.number}`, subject: 'Overdue invoices from Collections Test' });
    expect(sent.sentAt).toBeTruthy();
    expect(sent.sendLog).toEqual([expect.objectContaining({ ok: true, status: 250 })]);

    expect(smtp.messages).toHaveLength(1);
    const m = smtp.messages[0];
    expect(m.to).toEqual(['accounts@banyan.test']);
    expect(m.from).toBe('robot@talk2tax.test');
    expect(m.subject).toBe('Overdue invoices from Collections Test');
    expect(m.text).toContain(`${inv.a.number} still has ${inr('45000.00')} to pay`);
    expect(m.text).toContain('Phone: 022 4000 1234');
    expect(m.headers['message-id']).toBe(`<${r.id}@talk2tax.collections>`);
    expect(m.headers['x-t2t-reminder']).toBe(r.id);

    expect((await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({}).expect(409)).body.error).toBe('NOT_SENDABLE');
    expect((await ctx.http().post(`${B}/reminders/${r.id}/reject`).set(owner.auth).send({}).expect(409)).body.error).toBe('NOT_REJECTABLE');
    expect(smtp.messages).toHaveLength(1);
    const audit = await ctx.prisma.auditEvent.findFirstOrThrow({ where: { orgId: org.orgId, action: 'collections.reminder_sent' } });
    expect(audit.data).toMatchObject({ to: 'accounts@banyan.test', edited: true, invoices: [inv.a.number, inv.b.number], totalOverdue: '57345.67', smtpStatus: 250 });
  });

  it('keeps a sent reminder exactly as it went, in the database too', async () => {
    const r = await reminderFor('Banyan Retail');
    await expect(raw(`UPDATE collection_drafts SET body = 'changed' WHERE id = $1::uuid`, r.id)).rejects.toThrow(/cannot be changed/);
    await expect(raw(`DELETE FROM collection_drafts WHERE id = $1::uuid`, r.id)).rejects.toThrow(/cannot be removed/);
    await expect(raw(`UPDATE collection_drafts SET ai_body = 'x' WHERE status = 'READY' AND org_id = $1::uuid`, org.orgId)).rejects.toThrow(/AI model wrote cannot be changed/);
  });

  it('will not send a reminder the books have moved past, and records a rejection', async () => {
    const r = await reminderFor('Cedar Mart');
    await receipt('Cedar Mart', '5000.00', [{ documentId: inv.cedar.id, amount: '5000.00' }]);
    const res = await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({}).expect(409);
    expect(res.body).toMatchObject({ error: 'DRAFT_OUT_OF_DATE', details: { invoices: [inv.cedar.number] } });
    expect(res.body.message).toContain(`${inv.cedar.number} has been paid or changed`);
    const rej = (await ctx.http().post(`${B}/reminders/${r.id}/reject`).set(owner.auth).send({ note: 'Paid part, drafting again' }).expect(200)).body as Reminder;
    expect(rej).toMatchObject({ status: 'REJECTED', decidedBy: 'Collections Owner', decisionNote: 'Paid part, drafting again', canSend: false });
    expect(smtp.messages).toHaveLength(1);
  });

  it('cannot send without email set up on the server', async () => {
    const r = await reminderFor('Banyan Retail');
    const res = await noMail.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({}).expect(409);
    expect(res.body.error).toBe('EMAIL_NOT_SET_UP');
    expect((await noMail.http().get(B).set(owner.auth).expect(200)).body).toMatchObject({ emailReady: false, emailFrom: null });
  });
});

describe('when things go wrong', () => {
  it('records a refusal, an incomplete draft and a provider error as failed drafts', async () => {
    const one = async (step: Step) => {
      model.steps.push(step);
      const o = await run();
      // Banyan was reminded today, Lotus has no email: only Cedar is drafted.
      expect(o.latestRun.skipped.map((s: { name: string; reason: string }) => [s.name, s.reason])).toEqual([['Banyan Retail', `Reminded on ${T}`], ['Lotus Stores', 'No email address on the customer']]);
      await settle();
      return (await reminders('FAILED'))[0];
    };
    expect(await one(() => reply([{ type: 'text', text: 'No.' }], 'refusal'))).toMatchObject({ errorCode: 'REFUSED', status: 'FAILED', risk: null, subject: null, canSend: false });
    expect(await one(() => submit({ risk: 'SEVERE', riskReasons: [], subject: 'x', body: 'y' }))).toMatchObject({ errorCode: 'BAD_DRAFT' });
    const rateLimited = new (Anthropic.RateLimitError as unknown as new (s: number, e: unknown, m: string, h: Headers) => Error)(429, { type: 'error', error: { type: 'rate_limit_error', message: 'test' } }, '429 test', new Headers());
    const failed = await one(() => Promise.reject(rateLimited));
    expect(failed).toMatchObject({ errorCode: 'AI_RATE_LIMITED', usage: null });
    expect(failed.errorMessage).toContain('Draft again in a minute');
    expect(await audits('collections.drafting_failed')).toHaveLength(3);
  });

  it('runs one drafting run at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const body = `Dear Cedar Mart,\n\n${inv.cedar.number}: ${inr('15000.00')} is still to pay. Please pay ${inr('15000.00')}.\n\nAccounts team`;
    model.steps.push(async () => {
      await gate;
      return submit({ risk: 'LOW', riskReasons: ['Paid part already'], subject: `Reminder: ${inv.cedar.number}`, body });
    });
    await run();
    expect((await ctx.http().post(`${B}/runs`).set(owner.auth).expect(409)).body.error).toBe('COLLECTIONS_BUSY');
    expect((await reminders('DRAFTING')).map((r) => r.customer)).toEqual(['Cedar Mart']);
    release();
    await settle();
    expect((await reminderFor('Cedar Mart')).status).toBe('READY');
  });

  it('keeps a reminder the mail server refused, and sends it again exactly as approved', async () => {
    const r = await reminderFor('Cedar Mart');
    smtp.answers.set('pay@cedar.test', '550 5.1.1 No such mailbox');
    const failed = (await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({ subject: 'Cedar: one invoice overdue' }).expect(200)).body as Reminder;
    expect(failed).toMatchObject({ status: 'SEND_FAILED', canSend: true, sendAttempts: 1, sentAt: null, errorCode: 'SEND_FAILED', subject: 'Cedar: one invoice overdue' });
    expect(failed.errorMessage).toContain('550');
    smtp.answers.delete('pay@cedar.test');
    // A resend goes exactly as approved: an edit sent with it is ignored.
    const sent = (await ctx.http().post(`${B}/reminders/${r.id}/send`).set(owner.auth).send({ subject: 'Something else' }).expect(200)).body as Reminder;
    expect(sent).toMatchObject({ status: 'SENT', sendAttempts: 2, subject: 'Cedar: one invoice overdue', errorCode: null });
    expect(sent.sendLog!.map((l) => [l.ok, l.status])).toEqual([[false, 550], [true, 250]]);
    const delivered = smtp.messages.filter((m) => m.to.includes('pay@cedar.test'));
    expect(delivered.map((m) => m.subject)).toEqual(['Cedar: one invoice overdue']);
  });

  it('marks drafting cut off by a restart as interrupted on the next run', async () => {
    const stale = randomUUID();
    // A run left RUNNING an hour ago with a draft still drafting, and no work for it in this process.
    await raw(`INSERT INTO collection_runs (id, org_id, status, started_by_id, skipped, model, created_at) VALUES ($3::uuid, $1::uuid, 'RUNNING', $2::uuid, '[]', 'claude-opus-5-5', now() - interval '1 hour')`, org.orgId, owner.id, stale);
    await raw(`INSERT INTO collection_drafts (id, org_id, run_id, contact_id, to_email, facts, model, updated_at) VALUES (gen_random_uuid(), $1::uuid, $3::uuid, $2::uuid, 'ap@teak.test', '{"overdue":[]}', 'claude-opus-5-5', now())`, org.orgId, c['Teak Traders'], stale);
    const o = await run();
    expect(o.latestRun).toMatchObject({ status: 'DONE', drafts: 0 });
    const old = await ctx.prisma.collectionRun.findUniqueOrThrow({ where: { id: stale } });
    expect(old.status).toBe('DONE');
    const teak = await reminderFor('Teak Traders');
    expect(teak).toMatchObject({ status: 'FAILED', errorCode: 'INTERRUPTED' });
  });
});

describe('AI activity', () => {
  it('lists every AI call with the model, tokens, outcome and what a person decided', async () => {
    const a = (await ctx.http().get(`${org.base}/ai-activity`).set(owner.auth).expect(200)).body;
    const coll = a.rows.filter((r: { feature: string }) => r.feature === 'COLLECTIONS');
    expect(coll.length).toBeGreaterThanOrEqual(6);
    const banyan = coll.find((r: { what: string }) => r.what.includes('Banyan Retail'));
    expect(banyan).toMatchObject({ what: 'Drafted a payment reminder for Banyan Retail (risk medium)', by: 'Collections Accountant', model: 'claude-opus-5-5', servedModel: 'claude-opus-5-5', inputTokens: 900, outputTokens: 250, outcome: 'SENT', decision: 'Sent with edits by Collections Accountant' });
    expect(coll.map((r: { outcome: string }) => r.outcome)).toEqual(expect.arrayContaining(['FAILED', 'REJECTED']));
    expect(a.totals.calls).toBe(a.rows.length);
    await ctx.http().get(`${org.base}/ai-activity`).set(employee.auth).expect(403);
  });
});
