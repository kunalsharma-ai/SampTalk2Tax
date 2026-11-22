import { formatAmountText, formatDateText } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { CollectionsService } from '../src/collections/collections.service';
import { tenantStorage } from '../src/common/tenant-context';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../src/copilot/copilot.model';
import { MailerService } from '../src/workflows/email';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * AR-043: email to customers and vendors respects what they asked for and what the
 * organisation allows. Against the real API, the real database and real SMTP: a contact who
 * opted out gets nothing from collections, automations or any other sender, and an owner can
 * stop automations emailing contacts at all. Members still get their own emails.
 */
type Step = (req: CopilotRequest) => CopilotResponse;
class ScriptedModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  steps: Step[] = [];
  async send(req: CopilotRequest): Promise<CopilotResponse> {
    const step = this.steps.shift();
    if (!step) throw new Error('The test did not script this step');
    return step(req);
  }
}
let n = 0;
const submit = (input: Record<string, unknown>) =>
  ({ id: `msg_cp_${++n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `tu_cp_${n}`, name: 'submit_reminder', input }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 500, output_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) as unknown as CopilotResponse;

const H = 3_600_000;
const T = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 10);
const addDays = (iso: string, d: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
const inr = (v: string) => formatAmountText(v, 'INR');

let ctx: Ctx;
let smtp: SmtpStandIn;
const model = new ScriptedModel();
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const inv: Record<string, { id: string; number: string }> = {};
const workflowIds: string[] = [];

const consentUrl = (who: string) => `${org.base}/contacts/${c[who]}/email-consent`;
const optOut = (who: string, reason = 'Asked us by phone to stop emailing', auth = owner.auth) => ctx.http().post(consentUrl(who)).set(auth).send({ status: 'OPTED_OUT', reason });
const optIn = (who: string, reason = 'Asked to hear from us again', auth = owner.auth) => ctx.http().post(consentUrl(who)).set(auth).send({ status: 'OPTED_IN', reason });
const setPolicy = (automationsToContacts: string, auth = owner.auth) => ctx.http().put(`${org.base}/communication-policy`).set(auth).send({ automationsToContacts });
const to = (addr: string) => smtp.messages.filter((m) => m.to.includes(addr.toLowerCase()));
const audits = async (prefix: string) => (await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: { startsWith: prefix } }, orderBy: { createdAt: 'asc' } })).map((a) => ({ action: a.action, data: a.data as Record<string, unknown> }));
const tick = (now?: Date) => tenantStorage.run({}, () => ctx.app.get(WorkflowRunnerService).tick({ now }));
const settle = () => Promise.all([...ctx.app.get(CollectionsService).inflight.values()]);
const invoice = async (key: string, who: string, amount: string, dueDate: string) => {
  const d = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: addDays(dueDate, -10), dueDate, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
  inv[key] = { id: d.id, number: d.number };
};
const overdueWorkflow = async (name: string) => {
  const w = (await ctx.http().post(`${org.base}/workflows`).set(owner.auth).send({
    name,
    trigger: 'INVOICE_OVERDUE',
    triggerParams: { days: 5 },
    conditions: [],
    actions: [
      { type: 'SEND_EMAIL', to: { contact: true }, subject: `${name}: invoice {{number}}`, body: 'Dear {{contactName}},\n\n{{balance}} is still to pay.' },
      { type: 'SEND_EMAIL', to: { role: 'OWNER' }, subject: `${name}: {{number}} for the owner`, body: '{{contactName}} owes {{balance}}.' },
    ],
  }).expect(201)).body;
  workflowIds.push(w.id);
  await ctx.http().post(`${org.base}/workflows/${w.id}/turn-on`).set(owner.auth).expect(200);
  return w.id as string;
};
const runsOf = async (id: string) => (await ctx.http().get(`${org.base}/workflows/${id}/runs`).set(owner.auth).expect(200)).body as { link: { label: string } | null; actions: { status: string; error: string | null; input: { to: string[] } }[] }[];

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  ctx = await bootApp({ SMTP_URL: smtp.url, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>' }, { copilotModel: model });
  owner = await registerUser(ctx, 'Consent Owner');
  accountant = await registerUser(ctx, 'Consent Accountant');
  viewer = await registerUser(ctx, 'Consent Viewer');
  org = await createOrg(ctx, owner, { name: 'Consent Test Pvt Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [name, email] of [['Mango Retail', 'accounts@mango.test'], ['Neem Stores', 'pay@neem.test'], ['Peepal Mart', 'ap@peepal.test']] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true, email }).expect(201)).body.id;
  }
  await invoice('mango', 'Mango Retail', '40000.00', addDays(T, -5));
  await invoice('neem', 'Neem Stores', '25000.00', addDays(T, -5));
  await invoice('peepal', 'Peepal Mart', '18000.00', addDays(T, -5));
});
afterAll(async () => {
  for (const id of workflowIds) await ctx?.http().post(`${org.base}/workflows/${id}/turn-off`).set(owner.auth);
  await settle();
  await ctx?.app.close();
  await smtp?.close();
});

describe('recording consent', () => {
  it('starts with everyone receiving email and automations allowed', async () => {
    const o = (await ctx.http().get(`${org.base}/communication-policy`).set(viewer.auth).expect(200)).body;
    expect(o).toEqual({ policy: { automationsToContacts: 'ALLOWED', updatedAt: null, updatedBy: null }, optedOut: [], canManage: false });
    expect((await ctx.http().get(consentUrl('Mango Retail')).set(viewer.auth).expect(200)).body).toEqual({ contactId: c['Mango Retail'], status: 'OPTED_IN', history: [], canManage: false });
  });

  it('records an opt-out with a reason, keeps the history, and audits it', async () => {
    await optOut('Mango Retail', 'x').expect(400);
    await optOut('Mango Retail', 'Asked by phone', viewer.auth).expect(403);
    await ctx.http().post(consentUrl('Mango Retail')).set(owner.auth).send({ status: 'MAYBE', reason: 'Not sure' }).expect(400);
    await ctx.http().get(`${org.base}/contacts/00000000-0000-4000-8000-000000000000/email-consent`).set(owner.auth).expect(404);

    const out = (await optOut('Mango Retail', 'Asked by phone to stop all email', accountant.auth).expect(201)).body;
    expect(out).toMatchObject({ status: 'OPTED_OUT', canManage: true, history: [{ status: 'OPTED_OUT', reason: 'Asked by phone to stop all email', recordedBy: 'Consent Accountant' }] });
    expect((await optOut('Mango Retail').expect(409)).body.error).toBe('NO_CHANGE');

    // Changing their mind is a new record, not an edit of the old one.
    await optIn('Mango Retail', 'Wrote back asking for statements').expect(201);
    const back = (await optOut('Mango Retail', 'Changed their mind again').expect(201)).body;
    expect(back.status).toBe('OPTED_OUT');
    expect(back.history.map((h: { status: string }) => h.status)).toEqual(['OPTED_OUT', 'OPTED_IN', 'OPTED_OUT']);

    const o = (await ctx.http().get(`${org.base}/communication-policy`).set(owner.auth).expect(200)).body;
    expect(o.optedOut).toEqual([{ contactId: c['Mango Retail'], name: 'Mango Retail', email: 'accounts@mango.test', ledger: 'SALES', reason: 'Changed their mind again', since: expect.any(String) }]);
    expect((await audits('contact.email_opt')).map((a) => a.action)).toEqual(['contact.email_opted_out', 'contact.email_opted_in', 'contact.email_opted_out']);
  });

  it('lets only an owner or admin change the policy, and audits the change', async () => {
    await setPolicy('BLOCKED', accountant.auth).expect(403);
    await setPolicy('SOMETIMES').expect(400);
    const o = (await setPolicy('BLOCKED').expect(200)).body;
    expect(o.policy).toMatchObject({ automationsToContacts: 'BLOCKED', updatedBy: 'Consent Owner' });
    expect(o.canManage).toBe(true);
    await setPolicy('ALLOWED').expect(200);
    expect((await audits('communication_policy.')).map((a) => a.data.automationsToContacts)).toEqual([{ from: 'ALLOWED', to: 'BLOCKED' }, { from: 'BLOCKED', to: 'ALLOWED' }]);
  });
});

describe('automations', () => {
  it('emails customers who receive email and never one who opted out; members still hear', async () => {
    const id = await overdueWorkflow('Overdue nudge');
    await tick();
    const runs = await runsOf(id);
    const byInvoice = (key: string) => runs.find((r) => r.link?.label === `Invoice ${inv[key].number}`)!;
    // Positive: Neem receives email, so it goes.
    expect(byInvoice('neem').actions[0]).toMatchObject({ status: 'SUCCEEDED', input: { to: ['pay@neem.test'] } });
    expect(to('pay@neem.test').map((m) => m.subject)).toEqual([`Overdue nudge: invoice ${inv.neem.number}`]);
    // Negative: Mango opted out, so nothing goes, and the run says why.
    expect(byInvoice('mango').actions[0]).toMatchObject({ status: 'FAILED', error: 'Not sent: Mango Retail has opted out of email' });
    expect(to('accounts@mango.test')).toHaveLength(0);
    // The owner's own copy is not a message to a contact, so it still goes.
    expect(byInvoice('mango').actions[1].status).toBe('SUCCEEDED');
    expect(to(owner.email).map((m) => m.subject)).toContain(`Overdue nudge: ${inv.mango.number} for the owner`);
  });

  it('sends nothing to any contact while the policy blocks automations', async () => {
    await setPolicy('BLOCKED').expect(200);
    const id = await overdueWorkflow('Blocked nudge');
    await tick();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(3);
    for (const r of runs) {
      // Mango's own opt-out is the reason given for Mango; the policy is the reason for the rest.
      const why = r.link?.label === `Invoice ${inv.mango.number}` ? 'Mango Retail has opted out of email' : 'Your communication policy does not let automations email customers or vendors';
      expect(r.actions[0]).toMatchObject({ status: 'FAILED', error: `Not sent: ${why}` });
      expect(r.actions[1].status).toBe('SUCCEEDED');
    }
    expect(smtp.messages.filter((m) => m.subject.startsWith('Blocked nudge: invoice'))).toHaveLength(0);
    await setPolicy('ALLOWED').expect(200);
  });
});

describe('collections', () => {
  it('skips a customer who opted out, and will not send a reminder after an opt-out', async () => {
    await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
    const due = formatDateText(addDays(T, -5));
    const body = (who: string, key: string, amt: string) => `Dear ${who},\n\n${inv[key].number} for ${inr(amt)} was due on ${due}. Please pay ${inr(amt)}, or reply if you already have.\n\nAccounts team`;
    model.steps.push(
      (req) => {
        const facts = (req.messages[0].content as { text: string }[])[0].text;
        return facts.includes('Neem') ? submit({ risk: 'LOW', riskReasons: ['Only 5 days overdue'], subject: `Reminder: ${inv.neem.number}`, body: body('Neem Stores', 'neem', '25000.00') }) : submit({ risk: 'LOW', riskReasons: ['Only 5 days overdue'], subject: `Reminder: ${inv.peepal.number}`, body: body('Peepal Mart', 'peepal', '18000.00') });
      },
      (req) => {
        const facts = (req.messages[0].content as { text: string }[])[0].text;
        return facts.includes('Neem') ? submit({ risk: 'LOW', riskReasons: ['Only 5 days overdue'], subject: `Reminder: ${inv.neem.number}`, body: body('Neem Stores', 'neem', '25000.00') }) : submit({ risk: 'LOW', riskReasons: ['Only 5 days overdue'], subject: `Reminder: ${inv.peepal.number}`, body: body('Peepal Mart', 'peepal', '18000.00') });
      },
    );
    const run = (await ctx.http().post(`${org.base}/collections/runs`).set(owner.auth).expect(201)).body;
    expect(run.latestRun.skipped).toEqual([{ contactId: c['Mango Retail'], name: 'Mango Retail', reason: 'Opted out of email' }]);
    expect(run.latestRun.drafts).toBe(2);
    await settle();
    const list = (await ctx.http().get(`${org.base}/collections/reminders`).set(owner.auth).expect(200)).body as { id: string; customer: string; status: string }[];
    const neem = list.find((r) => r.customer === 'Neem Stores')!;
    const peepal = list.find((r) => r.customer === 'Peepal Mart')!;
    expect([neem.status, peepal.status]).toEqual(['READY', 'READY']);

    // Positive: an approved reminder to a customer who receives email goes.
    expect((await ctx.http().post(`${org.base}/collections/reminders/${neem.id}/send`).set(owner.auth).send({}).expect(200)).body.status).toBe('SENT');
    expect(to('pay@neem.test').map((m) => m.subject)).toContain(`Reminder: ${inv.neem.number}`);

    // Negative: Peepal opts out after the draft was written: the approval cannot send it.
    await optOut('Peepal Mart', 'Replied asking us to stop').expect(201);
    const res = await ctx.http().post(`${org.base}/collections/reminders/${peepal.id}/send`).set(owner.auth).send({}).expect(409);
    expect(res.body).toMatchObject({ error: 'OPTED_OUT', message: 'Not sent: Peepal Mart has opted out of email.' });
    expect(to('ap@peepal.test').filter((m) => m.subject.startsWith('Reminder:'))).toHaveLength(0);
    expect((await ctx.http().get(`${org.base}/collections/reminders`).set(owner.auth).expect(200)).body.find((r: { id: string }) => r.id === peepal.id).status).toBe('READY');
    const blocked = await audits('communication.blocked');
    expect(blocked.at(-1)!.data).toMatchObject({ source: 'COLLECTION_REMINDER', code: 'OPTED_OUT', recipients: 1 });
  });
});

describe('every sender', () => {
  it('refuses any email to an opted-out address, whatever the case, and sends the rest', async () => {
    const mailer = ctx.app.get(MailerService);
    const refused = await mailer.send(org.orgId, { to: ['Accounts@Mango.test'], subject: 'Statement', text: 'Your statement', messageId: '<cp-1@talk2tax.test>' });
    expect(refused).toMatchObject({ ok: false, retryable: false, error: 'Not sent: Mango Retail has opted out of email' });
    const sent = await mailer.send(org.orgId, { to: ['pay@neem.test'], subject: 'Statement for Neem', text: 'Your statement', messageId: '<cp-2@talk2tax.test>' });
    expect(sent.ok).toBe(true);
    expect(to('pay@neem.test').map((m) => m.subject)).toContain('Statement for Neem');
    expect(to('accounts@mango.test')).toHaveLength(0);
  });
});
