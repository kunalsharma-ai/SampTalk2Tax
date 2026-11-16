import { latestOccurrence } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { tenantStorage } from '../src/common/tenant-context';
import { loadConfig } from '../src/config';
import { IntegrationsService } from '../src/integrations/integrations.service';
import { EMAIL_NOT_SET_UP, MailerService } from '../src/workflows/email';
import { WorkflowRunnerService } from '../src/workflows/workflow-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Schedule triggers and email actions against the real API, the real database and real
 * SMTP: nodemailer delivers to a local SMTP server (test-support/smtp-stand-in.mjs) that
 * keeps what it accepts. The runner is driven by hand with a chosen clock, so "tomorrow"
 * and "in two hours" are tested without waiting.
 */
let ctx: Ctx;
let runner: WorkflowRunnerService;
let smtp: SmtpStandIn;
let owner: TestUser;
let accountant: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const workflowIds: string[] = [];

const H = 3_600_000;
const T = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const tick = (now?: Date) => tenantStorage.run({}, () => runner.tick({ now }));
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const invoice = async (who: string, amount: string, dueDate: string, reference: string) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate: dueDate < T ? addDays(dueDate, -7) : T, dueDate, reference, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
const wf = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/workflows`).set(owner.auth).send(body);
const create = async (body: Record<string, unknown>) => {
  const w = (await wf(body).expect(201)).body;
  workflowIds.push(w.id);
  return w;
};
const turnOn = (id: string) => ctx.http().post(`${org.base}/workflows/${id}/turn-on`).set(owner.auth).expect(200);
const runsOf = async (id: string) => (await ctx.http().get(`${org.base}/workflows/${id}/runs`).set(owner.auth).expect(200)).body as Run[];
const to = (addr: string) => smtp.messages.filter((m) => m.to.includes(addr.toLowerCase()));

interface Run {
  id: string;
  status: string;
  error: string | null;
  occurrenceKey: string | null;
  eventId: string | null;
  link: { label: string } | null;
  facts: { key: string; value: string | null }[];
  actions: { position: number; type: string; status: string; error: string | null; attempts: number; nextAttemptAt: string | null; input: Record<string, unknown>; history: { status: number | null; ok: boolean; responseSnippet: string | null }[]; canRetry: boolean }[];
}

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  ctx = await bootApp({ SMTP_URL: smtp.url, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>', APP_URL: 'https://app.talk2tax.test/' });
  runner = ctx.app.get(WorkflowRunnerService);
  owner = await registerUser(ctx, 'Sched Owner');
  accountant = await registerUser(ctx, 'Sched Accountant');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  for (const [name, kind, email] of [
    ['Banyan Retail', 'isCustomer', 'accounts@banyan.test'],
    ['No Mail Traders', 'isCustomer', null],
    ['Teak Supplies', 'isVendor', 'billing@teak.test'],
  ] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true, ...(email ? { email } : {}) }).expect(201)).body.id;
  }
});
afterAll(async () => {
  // Leave nothing on in the shared test database for later runs to pick up.
  for (const id of workflowIds) await ctx.http().post(`${org.base}/workflows/${id}/turn-off`).set(owner.auth);
  await ctx?.app.close();
  await smtp?.close();
});

describe('building schedule workflows', () => {
  it('offers schedule triggers and says email is set up', async () => {
    const cat = (await ctx.http().get(`${org.base}/workflows/catalogue`).set(owner.auth).expect(200)).body;
    expect(cat.triggers.filter((t: { kind: string }) => t.kind === 'schedule').map((t: { key: string }) => t.key)).toEqual(['SCHEDULE', 'INVOICE_OVERDUE', 'BILL_DUE_SOON']);
    expect(cat.triggers.find((t: { key: string }) => t.key === 'INVOICE_OVERDUE').emailsContact).toBe(true);
    expect(cat.email).toEqual({ ready: true, from: 'Talk2Tax <robot@talk2tax.test>', source: 'SERVER' });
    expect(cat.schedule.weekdays[0]).toEqual({ value: 1, label: 'Monday' });
  });

  it('lists every problem with a schedule or an email', async () => {
    const res = await wf({
      name: 'Broken',
      trigger: 'SCHEDULE',
      triggerParams: { frequency: 'WEEKLY', time: '9am' },
      conditions: [],
      actions: [{ type: 'SEND_EMAIL', to: { contact: true }, subject: 'Hi {{number}}', body: '' }],
    }).expect(422);
    expect(res.body.details.issues).toEqual([
      'Schedule: enter a time as HH:MM (24-hour, India time)',
      'Schedule: choose a weekday',
      'Action 1: write the email',
      'Action 1: {{number}} is not available for on a schedule',
      'Action 1: on a schedule has no customer or vendor to email',
    ]);
    const stranger = await registerUser(ctx, 'Not A Member');
    const res2 = await wf({ name: 'Nobody', trigger: 'INVOICE_OVERDUE', triggerParams: { days: 3 }, conditions: [], actions: [{ type: 'SEND_EMAIL', to: { userId: stranger.id }, subject: 'x', body: 'y' }] }).expect(422);
    expect(res2.body.details.issues).toEqual(['Action 1: that person is not a member of the organisation']);
    // Settings that do not apply to a trigger are dropped, and the database refuses them outright.
    const plain = await create({ name: 'Plain', trigger: 'BILL_POSTED', triggerParams: { days: 4 }, conditions: [], actions: [{ type: 'CREATE_TASK', title: 'x', assignTo: { role: 'OWNER' }, dueInDays: null }] });
    expect(plain.triggerParams).toEqual({});
    await expect(raw(`INSERT INTO workflow_versions (id, org_id, workflow_id, version, trigger, trigger_params, conditions, actions, created_by_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 9, 'BILL_POSTED', '{"days": 4}', '[]', '[{}]', $3::uuid)`, org.orgId, plain.id, owner.id)).rejects.toThrow(/workflow_versions_chk/);
  });
});

describe('an invoice is overdue', () => {
  let w: { id: string };
  const inv: Record<string, { id: string; number: string }> = {};

  it('emails the customer and gives a task on the day an invoice reaches 3 days overdue, once', async () => {
    inv.a = await invoice('Banyan Retail', '150000.00', addDays(T, -3), 'PO-A');
    inv.b = await invoice('No Mail Traders', '2000.00', addDays(T, -3), 'PO-B');
    inv.old = await invoice('Banyan Retail', '5000.00', addDays(T, -10), 'PO-OLD'); // reached 3 days before the workflow was on
    inv.soon = await invoice('Banyan Retail', '700.00', addDays(T, -2), 'PO-SOON'); // reaches 3 days tomorrow
    inv.paid = await invoice('Banyan Retail', '900.00', addDays(T, -3), 'PO-PAID');
    await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c['Banyan Retail'], date: T, bankAccountId: org.acc['1120'], amount: '900.00', allocations: [{ documentId: inv.paid.id, amount: '900.00' }] }).expect(201);
    inv.future = await invoice('Banyan Retail', '10000.00', addDays(T, 30), 'PO-FUT');
    // Under an open dispute: held out of the overdue trigger.
    inv.disputed = await invoice('Banyan Retail', '3000.00', addDays(T, -3), 'PO-DISP');
    await ctx.http().post(`${org.base}/sales/disputes`).set(owner.auth).send({ documentId: inv.disputed.id, reason: 'PRICE', description: 'Rate not as agreed' }).expect(201);

    w = await create({
      name: 'Overdue reminder',
      trigger: 'INVOICE_OVERDUE',
      triggerParams: { days: 3 },
      conditions: [{ fact: 'balance', op: 'gt', value: '0' }],
      actions: [
        { type: 'SEND_EMAIL', to: { contact: true }, subject: 'Reminder: invoice {{number}} is overdue', body: 'Dear {{contactName}},\n\n{{balance}} on invoice {{number}} (due {{dueDate}}) is still to pay.' },
        { type: 'CREATE_TASK', title: 'Call {{contactName}} about {{number}}', assignTo: { role: 'ACCOUNTANT' }, dueInDays: 1 },
      ],
    });
    expect((await ctx.http().get(`${org.base}/workflows/${w.id}`).set(owner.auth).expect(200)).body.triggerLabel).toBe('An invoice is 3 days overdue');
    await tick(); // off: nothing happens
    expect(await runsOf(w.id)).toEqual([]);
    await turnOn(w.id);

    await tick();
    const runs = await runsOf(w.id);
    expect(runs.map((r) => r.link?.label).sort()).toEqual([`Invoice ${inv.a.number}`, `Invoice ${inv.b.number}`].sort());
    const a = runs.find((r) => r.link?.label === `Invoice ${inv.a.number}`)!;
    expect(a.occurrenceKey).toBe(`doc:${inv.a.id}:3`);
    expect(a.eventId).toBeNull();
    expect(a.status).toBe('SUCCEEDED');
    expect(Object.fromEntries(a.facts.map((f) => [f.key, f.value]))).toMatchObject({ number: inv.a.number, contactEmail: 'accounts@banyan.test', balance: '150000.00', dueDate: addDays(T, -3) });
    expect(a.actions[0]).toMatchObject({ type: 'SEND_EMAIL', status: 'SUCCEEDED', attempts: 1, input: { to: ['accounts@banyan.test'], recipientLabel: 'Banyan Retail' } });
    expect(a.actions[0].history[0]).toMatchObject({ ok: true, status: 250 });
    expect(a.actions[0].history[0].responseSnippet).toMatch(/queued as stand-in-/);

    // The email as the customer receives it: amounts and dates for people, no link into the app.
    const [mail] = to('accounts@banyan.test');
    expect(mail.subject).toBe(`Reminder: invoice ${inv.a.number} is overdue`);
    expect(mail.headers.from).toBe('Talk2Tax <robot@talk2tax.test>');
    expect(mail.headers['auto-submitted']).toBe('auto-generated');
    expect(mail.headers['message-id']).toMatch(/@talk2tax\.workflow>$/);
    const due = new Date(`${addDays(T, -3)}T00:00:00Z`);
    expect(mail.text).toBe(
      `Dear Banyan Retail,\n\n₹1,50,000.00 on invoice ${inv.a.number} (due ${due.getUTCDate()} ${due.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${due.getUTCFullYear()}) is still to pay.\n\n--\nSent by Acme Test Pvt Ltd.`,
    );
    expect(mail.text).not.toContain('app.talk2tax.test');

    // A customer with no email address: that action fails with the reason; the task is still given.
    const b = runs.find((r) => r.link?.label === `Invoice ${inv.b.number}`)!;
    expect(b.status).toBe('FAILED');
    expect(b.error).toBe('Action 1: No Mail Traders has no email address');
    expect(b.actions.map((x) => x.status)).toEqual(['FAILED', 'SUCCEEDED']);
    const tasks = (await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all' }).set(owner.auth).expect(200)).body.tasks;
    expect(tasks.map((t: { title: string }) => t.title).sort()).toEqual([`Call Banyan Retail about ${inv.a.number}`, `Call No Mail Traders about ${inv.b.number}`].sort());

    // Once only: another pass the same day does nothing; tomorrow the next invoice reaches 3 days.
    const sent = smtp.messages.length;
    await tick();
    expect(await runsOf(w.id)).toHaveLength(2);
    await tick(new Date(Date.now() + 24 * H));
    const later = await runsOf(w.id);
    expect(later).toHaveLength(3);
    expect(later[0].link?.label).toBe(`Invoice ${inv.soon.number}`);
    expect(smtp.messages.length).toBe(sent + 1);

    // Turning it off and on again neither repeats a reminder nor picks up the older invoice.
    await ctx.http().post(`${org.base}/workflows/${w.id}/turn-off`).set(owner.auth).expect(200);
    await turnOn(w.id);
    await tick(new Date(Date.now() + 24 * H));
    expect(await runsOf(w.id)).toHaveLength(3);
  });

  it('tests on a real overdue invoice and sends the test email to the tester only', async () => {
    const before = to('accounts@banyan.test').length;
    const res = (await ctx.http().post(`${org.base}/workflows/${w.id}/test`).set(owner.auth).send({ sendWebhooks: true }).expect(200)).body;
    expect(res.matched).toBe(true);
    expect(res.run.status).toBe('TEST');
    const email = res.run.actions[0];
    expect(email).toMatchObject({ status: 'SUCCEEDED', input: { testSentTo: owner.email } });
    expect(to('accounts@banyan.test').length).toBe(before);
    const mine = to(owner.email).at(-1)!;
    expect(mine.subject).toMatch(/^\[Test\] Reminder: invoice INV-\d+ is overdue$/);
    expect(mine.text).toMatch(/^This is a test of the automation "Overdue reminder"\. The real email would go to /);
    expect(mine.headers['x-t2t-test']).toBe('true');
  });

  it('retries a busy mail server, stops on a refusal, and an owner can send again', async () => {
    smtp.answers.set('busy@banyan.test', '451 4.3.0 Mailbox busy, try later');
    smtp.answers.set('gone@banyan.test', '550 5.1.1 No such mailbox');
    const busy = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Busy Mart', isCustomer: true, email: 'busy@banyan.test' }).expect(201)).body.id;
    const gone = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Gone Ltd', isCustomer: true, email: 'gone@banyan.test' }).expect(201)).body.id;
    c['Busy Mart'] = busy;
    c['Gone Ltd'] = gone;
    // Due 3 days ago, so they reach the trigger today (the workflow was turned on today).
    const bi = await invoice('Busy Mart', '100.00', addDays(T, -3), 'B');
    const gi = await invoice('Gone Ltd', '100.00', addDays(T, -3), 'G');
    await tick();
    const runs = await runsOf(w.id);
    const busyRun = runs.find((r) => r.link?.label === `Invoice ${bi.number}`)!;
    const goneRun = runs.find((r) => r.link?.label === `Invoice ${gi.number}`)!;
    expect(busyRun.status).toBe('RUNNING');
    expect(busyRun.actions[0]).toMatchObject({ status: 'PENDING', attempts: 1, error: 'The mail server answered 451' });
    expect(Date.parse(busyRun.actions[0].nextAttemptAt!) - Date.now()).toBeGreaterThan(50_000);
    expect(goneRun.status).toBe('FAILED');
    expect(goneRun.actions[0]).toMatchObject({ status: 'FAILED', attempts: 1, error: 'The mail server answered 550', canRetry: true });
    expect(goneRun.actions[0].history[0].responseSnippet).toContain('No such mailbox');

    // The mailbox frees up; the retry is due.
    smtp.answers.delete('busy@banyan.test');
    await raw(`UPDATE workflow_action_runs SET next_attempt_at = now() WHERE run_id = $1::uuid AND status = 'PENDING'`, busyRun.id);
    await tick();
    const busyAfter = (await ctx.http().get(`${org.base}/workflow-runs/${busyRun.id}`).set(owner.auth).expect(200)).body as Run;
    expect(busyAfter.status).toBe('SUCCEEDED');
    expect(busyAfter.actions[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(busyAfter.actions[0].history.map((h) => h.status)).toEqual([451, 250]);
    expect(to('busy@banyan.test')).toHaveLength(1);

    // The address is fixed at the receiving end; the owner sends it again.
    smtp.answers.delete('gone@banyan.test');
    await ctx.http().post(`${org.base}/workflow-runs/${goneRun.id}/actions/0/retry`).set(owner.auth).expect(200);
    await tick();
    const goneAfter = (await ctx.http().get(`${org.base}/workflow-runs/${goneRun.id}`).set(owner.auth).expect(200)).body as Run;
    expect(goneAfter.actions[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    expect(goneAfter.status).toBe('SUCCEEDED');
    expect(to('gone@banyan.test')).toHaveLength(1);

    // An email with no address cannot be sent again: the workflow has to change.
    const noMail = runs.find((r) => r.error === 'Action 1: No Mail Traders has no email address')!;
    const r = await ctx.http().post(`${org.base}/workflow-runs/${noMail.id}/actions/0/retry`).set(owner.auth).expect(409);
    expect(r.body.error).toBe('NO_RECIPIENTS');
  });

  it('the database keeps each occurrence to one run', async () => {
    const [run] = await runsOf(w.id);
    await expect(
      raw(`INSERT INTO workflow_runs (id, org_id, workflow_id, version, trigger, occurrence_key, facts, conditions, status, finished_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, 'INVOICE_OVERDUE', $3, '{}', '[]', 'SKIPPED', now())`, org.orgId, w.id, run.occurrenceKey),
    ).rejects.toThrow(/23505/); // workflow_runs_once_per_occurrence
    await expect(
      raw(`INSERT INTO workflow_runs (id, org_id, workflow_id, version, trigger, event_id, occurrence_key, facts, conditions, status, finished_at) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 1, 'INVOICE_OVERDUE', 1, 'x', '{}', '[]', 'SKIPPED', now())`, org.orgId, w.id),
    ).rejects.toThrow(/workflow_runs_chk/);
    await expect(raw(`UPDATE workflow_runs SET occurrence_key = 'other' WHERE id = $1::uuid`, run.id)).rejects.toThrow(/finished workflow run cannot be changed/);
  });
});

describe('a bill is due soon', () => {
  it('emails the vendor five days before the due date and links members to the bill', async () => {
    const bill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c['Teak Supplies'], issueDate: T, dueDate: addDays(T, 5), reference: 'TS-77', post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '42000.00' }] }).expect(201)).body;
    const w = await create({
      name: 'Bills to pay',
      trigger: 'BILL_DUE_SOON',
      triggerParams: { days: 5 },
      conditions: [],
      actions: [{ type: 'SEND_EMAIL', to: { userId: accountant.id }, subject: 'Pay {{contactName}} by {{dueDate}}', body: '{{number}} ({{reference}}): {{balance}} to pay.' }],
    });
    await turnOn(w.id);
    await tick();
    const [run] = await runsOf(w.id);
    expect(run.status).toBe('SUCCEEDED');
    const [mail] = to(accountant.email).filter((m) => m.subject.startsWith('Pay Teak'));
    expect(mail.text).toContain(`${bill.number} (TS-77): ₹42,000.00 to pay.`);
    expect(mail.text).toContain(`Sent by the automation "Bills to pay" in Talk2Tax for Acme Test Pvt Ltd.\nBill ${bill.number}: https://app.talk2tax.test/orgs/${org.orgId}/purchases/bills/${bill.id}`);
  });
});

describe('on a schedule', () => {
  it('sends a digest to everyone with a role each time the schedule comes round, from when it was turned on', async () => {
    const now = Date.now();
    const at = new Date(now + 5.5 * H + 2 * H);
    const time = at.toISOString().slice(11, 16); // two hours from now, India time
    const w = await create({
      name: 'Daily digest',
      trigger: 'SCHEDULE',
      triggerParams: { frequency: 'DAILY', time },
      conditions: [],
      actions: [{ type: 'SEND_EMAIL', to: { role: 'OWNER' }, subject: 'Receivables on {{date}} ({{weekday}})', body: 'Overdue: {{overdueReceivables}}\nOutstanding: {{receivablesOutstanding}}\nBills overdue: {{overduePayables}}' }],
    });
    await turnOn(w.id);
    const detail = (await ctx.http().get(`${org.base}/workflows/${w.id}`).set(owner.auth).expect(200)).body;
    expect(detail.triggerLabel).toBe(`Every day at ${time} India time`);
    expect(Math.abs(Date.parse(detail.nextOccurrence) - (now + 2 * H))).toBeLessThan(61_000);

    // The last time it came round was before it was turned on: nothing to send yet.
    await tick(new Date(now));
    expect(await runsOf(w.id)).toEqual([]);
    // Two hours on, it comes round: one digest, once.
    await tick(new Date(now + 2 * H + 60_000));
    await tick(new Date(now + 3 * H));
    const runs = await runsOf(w.id);
    expect(runs).toHaveLength(1);
    const occ = latestOccurrence({ frequency: 'DAILY', time }, new Date(now + 3 * H));
    expect(runs[0].occurrenceKey).toBe(`at:${occ.at.toISOString()}`);
    expect(runs[0].link).toBeNull();
    const facts = Object.fromEntries(runs[0].facts.map((f) => [f.key, f.value]));
    // Open invoices due before the day: 150000 + 2000 + 5000 + 700 + 100 + 100 + 3000 disputed (still owed; the paid one is not open, PO-FUT is not due).
    expect(facts).toMatchObject({ date: occ.date, overdueReceivables: '160900.00', receivablesOutstanding: '170900.00', overduePayables: '0.00' });
    const digest = to(owner.email).filter((m) => m.subject.startsWith('Receivables on'));
    expect(digest).toHaveLength(1);
    expect(digest[0].text.split('\n').slice(0, 3)).toEqual(['Overdue: ₹1,60,900.00', 'Outstanding: ₹1,70,900.00', 'Bills overdue: ₹0.00']);
    // The next day it comes round again.
    await tick(new Date(now + 26 * H + 60_000));
    expect(await runsOf(w.id)).toHaveLength(2);
  });
});

describe('without a mail server', () => {
  it('says email is not set up, and an email action fails with that reason', async () => {
    expect(() => loadConfig({ ...process.env, DATABASE_URL: 'postgres://x', MONGODB_URL: 'mongodb://x', JWT_SECRET: 'x'.repeat(40), SMTP_URL: 'smtp://localhost:25', EMAIL_FROM: '' })).toThrow(/EMAIL_FROM is required when SMTP_URL is set/);
    expect(() => loadConfig({ ...process.env, DATABASE_URL: 'postgres://x', MONGODB_URL: 'mongodb://x', JWT_SECRET: 'x'.repeat(40), SMTP_URL: 'http://mail', EMAIL_FROM: 'a@b' })).toThrow(/SMTP_URL must start with smtp:\/\//);

    // No mail server of the organisation's own and none on the server.
    const appMailer = ctx.app.get(MailerService);
    const spy = vi.spyOn(ctx.app.get(IntegrationsService), 'mail').mockResolvedValue({ source: 'NONE', from: null });
    expect(await appMailer.status(org.orgId)).toEqual({ ready: false, from: null, source: 'NONE' });
    expect(await appMailer.send(org.orgId, { to: ['a@b.test'], subject: 's', text: 't', messageId: '<x@y>' })).toMatchObject({ ok: false, retryable: false, error: EMAIL_NOT_SET_UP });
    try {
      const inv = await invoice('Banyan Retail', '321.00', addDays(T, -3), 'NO-SMTP');
      await tick();
      const runs = await (async () => {
        const all: Run[] = [];
        for (const id of workflowIds) all.push(...(await runsOf(id)));
        return all;
      })();
      const run = runs.find((r) => r.link?.label === `Invoice ${inv.number}`)!;
      expect(run.status).toBe('FAILED');
      expect(run.actions[0]).toMatchObject({ status: 'FAILED', attempts: 0, error: EMAIL_NOT_SET_UP });
      const cat = (await ctx.http().get(`${org.base}/workflows/catalogue`).set(owner.auth).expect(200)).body;
      expect(cat.email).toEqual({ ready: false, from: null, source: 'NONE' });
    } finally {
      spy.mockRestore();
    }
  });
});
