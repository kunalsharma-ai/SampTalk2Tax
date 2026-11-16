import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Alerts and leakage checks against the real API and database. Every check is given
 * something to find, then alerts are acknowledged, dismissed, cleared by fixing the cause,
 * reopened, and turned off, with the history and audit trail checked at each step.
 */
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const ids: Record<string, string> = {};
let M: string;

// The checks work in India time, as the server does.
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;

interface Alert {
  id: string;
  rule: string;
  severity: string;
  title: string;
  summary: string;
  amount: string | null;
  status: string;
  statusNote: string | null;
  reopenCount: number;
  evidence: { facts: { label: string; value: string }[]; links: { kind: string; id?: string; path?: string; label: string }[]; rows?: { columns: string[]; items: { cells: string[]; link?: { id: string } }[] } };
}
const list = async (auth = owner.auth, status = 'ACTIVE') => (await ctx.http().get(`${org.base}/alerts`).query({ status }).set(auth).expect(200)).body as { lastScan: { automatic: boolean; found: number; opened: number; cleared: number; reopened: number; failures: unknown[] } | null; summary: Record<string, number>; alerts: Alert[] };
const scan = async () => (await ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200)).body;
const byRule = (alerts: Alert[], rule: string) => alerts.filter((a) => a.rule === rule);
const journal = (date: string, debit: string, credit: string, amount: string, memo = 'Alert test') =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const invoice = async (who: string, issueDate: string, dueDate: string, amount: string) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Alert Owner');
  approver = await registerUser(ctx, 'Alert Approver');
  viewer = await registerUser(ctx, 'Alert Viewer');
  stranger = await registerUser(ctx, 'Alert Stranger');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  M = shift(T.slice(0, 7), -1);
  const fy = fiscalYearForDate(T, 4);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy - 1 });
  for (const [name, kind] of [['Acme Retail', 'isCustomer'], ['Late Payers', 'isCustomer'], ['Once Ltd', 'isCustomer'], ['Granite Supplies', 'isVendor']] as const) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id;
  }
  // Manual journals: five ordinary ones months ago, then one twenty times their size today.
  for (let i = 0; i < 5; i++) await journal(addDays(T, -150 + i * 5), '1120', '3100', '10000.00', `Capital ${i + 1}`);
  ids.bigJournal = (await journal(T, '1120', '3100', '200000.00', 'Large capital top-up')).body.id;
  // A customer billed every month for three months and not in the last complete month.
  for (const k of [-3, -2, -1]) ids[`acme${k}`] = (await invoice('Acme Retail', `${shift(M, k)}-10`, addDays(T, 15), '30000.00')).id;
  // Revenue in M, from a one-off customer.
  await invoice('Once Ltd', `${M}-05`, addDays(T, 20), '20000.00');
  // A customer 70 days overdue.
  ids.late = (await invoice('Late Payers', addDays(T, -80), addDays(T, -70), '50000.00')).id;
  // The same vendor billed twice for the same amount, under different invoice numbers.
  for (const [k, d, ref] of [['bill1', -5, 'GS-101'], ['bill2', -3, 'GS-102']] as const) {
    ids[k] = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c['Granite Supplies'], issueDate: addDays(T, d), reference: ref, post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '11800.00' }] }).expect(201)).body.id;
  }
  // The same vendor paid twice for the same amount a day apart.
  for (const [k, d] of [['pay1', -2], ['pay2', -1]] as const) {
    ids[k] = (await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: c['Granite Supplies'], date: addDays(T, d), bankAccountId: org.acc['1120'], amount: '5000.00', reference: `NEFT-${k}` }).expect(201)).body.id;
  }
  // An approved budget with rent at 1,000 a month, and 50,000 of rent posted in M.
  const b = (await ctx.http().post(`${org.base}/budgets`).set(owner.auth).send({ basis: 'EMPTY', fiscalYear: fy, name: 'Plan' }).expect(201)).body.budget.id;
  await ctx.http().put(`${org.base}/budgets/${b}/lines`).set(owner.auth).send({ lines: [{ accountId: org.acc['6200'], amounts: Array(12).fill('1000.00') }, { accountId: org.acc['6400'], amounts: Array(12).fill('100000.00') }] }).expect(200);
  await ctx.http().post(`${org.base}/budgets/${b}/submit`).set(owner.auth).expect(200);
  await ctx.http().post(`${org.base}/budgets/${b}/approve`).set(approver.auth).expect(200);
  await journal(`${M}-15`, '6200', '1120', '50000.00', 'Rent');
  // A minimum balance the forecast cannot meet, and a revenue target that M misses.
  await ctx.http().put(`${org.base}/cash-flow/settings`).set(owner.auth).send({ minimumBalance: '100000000' }).expect(200);
  await ctx.http().put(`${org.base}/kpis/targets/revenue`).set(owner.auth).send({ comparator: 'AT_LEAST', target: '99999999' }).expect(200);
  // GST, filed monthly since April: earlier returns are overdue until marked filed.
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZAL0001Z'), effectiveFrom: `${fy}-04-01` }).expect(200);
  await ctx.http().put(`${org.base}/compliance/settings`).set(owner.auth).send({ gstReturnFrequency: 'MONTHLY', advanceTaxFrom: null }).expect(200);
  // Size judged first; back-dating is checked later with a tighter setting.
  await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_JOURNAL`).set(owner.auth).send({ enabled: true, params: { backdatedDays: '365' } }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the checks', () => {
  it('run by themselves the first time alerts are opened, and find each problem', async () => {
    const r = await list(viewer.auth);
    expect(r.lastScan).toMatchObject({ automatic: true, failures: [] });
    expect(r.lastScan!.opened).toBe(r.alerts.length);

    const [cash] = byRule(r.alerts, 'CASH_BELOW_MINIMUM');
    expect(cash).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect(cash.title).toMatch(/^Cash expected below the minimum balance from /);
    expect(cash.evidence.facts[0]).toEqual({ label: 'Minimum balance', value: '₹10,00,00,000', kind: 'money' });
    expect(cash.evidence.links).toEqual([{ kind: 'PAGE', path: '/planning/cash-flow', label: 'Open the cash-flow forecast' }]);

    const overdue = byRule(r.alerts, 'OVERDUE_RECEIVABLES');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toMatchObject({ severity: 'WARNING', amount: '50000', title: 'Late Payers owes ₹50,000 more than 30 days overdue', summary: '1 invoice more than 30 days past due; the oldest by 70 days.' });
    expect(overdue[0].evidence.rows!.items[0]).toMatchObject({ link: { id: ids.late }, cells: [expect.stringMatching(/^INV-/), expect.any(String), '70', '₹50,000'] });

    const [missed] = byRule(r.alerts, 'MISSED_RECURRING_BILLING');
    expect(missed.title).toMatch(/^Acme Retail was not invoiced in /);
    expect(missed.amount).toBe('30000');
    expect(missed.evidence.rows!.items.map((i) => i.cells[1])).toEqual(['₹30,000', '₹30,000', '₹30,000', '₹0']);
    expect(byRule(r.alerts, 'MISSED_RECURRING_BILLING')).toHaveLength(1); // Once Ltd and Late Payers are not regular

    const [bills] = byRule(r.alerts, 'DUPLICATE_BILL');
    expect(bills).toMatchObject({ severity: 'WARNING', amount: '11800', title: 'Possible duplicate bill: 2 bills to Granite Supplies for ₹11,800' });
    expect(bills.evidence.rows!.items.map((i) => [i.link!.id, i.cells[2]])).toEqual([
      [ids.bill1, 'GS-101'],
      [ids.bill2, 'GS-102'],
    ]);
    const [pays] = byRule(r.alerts, 'DUPLICATE_PAYMENT');
    expect(pays).toMatchObject({ severity: 'CRITICAL', amount: '5000' });
    expect(pays.evidence.rows!.items.map((i) => i.link!.id)).toEqual([ids.pay1, ids.pay2]);

    const journals = byRule(r.alerts, 'UNUSUAL_JOURNAL');
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({ severity: 'INFO', amount: '200000' });
    expect(journals[0].title).toMatch(/^Journal #\d+ for ₹2,00,000: 20\.0 times the usual manual journal$/);
    expect(journals[0].evidence.links[0]).toMatchObject({ kind: 'JOURNAL', id: ids.bigJournal });

    const [kpi] = byRule(r.alerts, 'KPI_TARGET_MISSED');
    expect(kpi.title).toMatch(/^Revenue missed its target in /);
    expect(kpi.summary).toBe('₹20,000 against a target of at least ₹9,99,99,999.');

    // Rent: 50,000 against 1,000 a month, when M is in this fiscal year.
    const fy = fiscalYearForDate(T, 4);
    const budget = byRule(r.alerts, 'BUDGET_OVERRUN');
    if (fiscalYearForDate(`${M}-01`, 4) === fy) {
      const done = ((+M.slice(5, 7) - 4 + 12) % 12) + 1;
      expect(budget).toHaveLength(1);
      expect(budget[0].amount).toBe(String(50000 - 1000 * done));
      expect(budget[0].title).toMatch(/is \d+\.\d% over budget$/);
    } else expect(budget).toHaveLength(0);

    // Compliance: exactly what the calendar says is overdue or due within a week.
    const cal = (await ctx.http().get(`${org.base}/compliance/calendar`).query({ from: T, to: addDays(T, 7) }).set(owner.auth).expect(200)).body;
    const expected = [...cal.overdueBefore, ...cal.items].filter((i: { status: string; daysLeft: number }) => i.status === 'OVERDUE' || (['DUE_SOON', 'UPCOMING'].includes(i.status) && i.daysLeft <= 7));
    const compliance = byRule(r.alerts, 'COMPLIANCE_DUE');
    expect(compliance.length).toBe(expected.length);
    for (const a of compliance) expect(a.severity).toBe(/was due on/.test(a.title) ? 'CRITICAL' : 'WARNING');

    // Sorted by severity, and counted.
    const order = { CRITICAL: 0, WARNING: 1, INFO: 2 } as Record<string, number>;
    expect(r.alerts.map((a) => order[a.severity])).toEqual([...r.alerts.map((a) => order[a.severity])].sort());
    expect(r.summary.open).toBe(r.alerts.length);
    expect(r.summary.critical + r.summary.warning + r.summary.info).toBe(r.alerts.length);
  });

  it('do not run again while the last run is fresh, and only managers can run them on demand', async () => {
    const before = await ctx.prisma.alertScan.count({ where: { orgId: org.orgId } });
    await list(viewer.auth);
    expect(await ctx.prisma.alertScan.count({ where: { orgId: org.orgId } })).toBe(before);
    await ctx.http().post(`${org.base}/alerts/scan`).set(viewer.auth).expect(403);
    const s = await scan();
    expect(s).toMatchObject({ automatic: false, ranBy: 'Alert Owner', opened: 0, cleared: 0, reopened: 0 });
    expect(await ctx.prisma.alertScan.count({ where: { orgId: org.orgId } })).toBe(before + 1);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'alerts.checks_run' } });
    expect(audit).toHaveLength(1);
  });
});

describe('acting on alerts', () => {
  it('acknowledges, dismisses with a reason, and keeps both through the next run', async () => {
    const r = await list();
    const pays = byRule(r.alerts, 'DUPLICATE_PAYMENT')[0];
    const bills = byRule(r.alerts, 'DUPLICATE_BILL')[0];
    await ctx.http().post(`${org.base}/alerts/${pays.id}/acknowledge`).set(viewer.auth).send({}).expect(403);
    const ack = (await ctx.http().post(`${org.base}/alerts/${pays.id}/acknowledge`).set(owner.auth).send({ note: 'Asked the bank for the second transfer' }).expect(200)).body;
    expect(ack).toMatchObject({ status: 'ACKNOWLEDGED', statusNote: 'Asked the bank for the second transfer', statusBy: 'Alert Owner' });
    expect((await ctx.http().post(`${org.base}/alerts/${pays.id}/acknowledge`).set(owner.auth).send({}).expect(409)).body.error).toBe('INVALID_ALERT_STATE');

    expect((await ctx.http().post(`${org.base}/alerts/${bills.id}/dismiss`).set(owner.auth).send({ reason: ' ' }).expect(400)).body.error).toBeDefined();
    await ctx.http().post(`${org.base}/alerts/${bills.id}/dismiss`).set(owner.auth).send({}).expect(400);
    const dis = (await ctx.http().post(`${org.base}/alerts/${bills.id}/dismiss`).set(owner.auth).send({ reason: 'Two separate deliveries, checked with Granite' }).expect(200)).body;
    expect(dis).toMatchObject({ status: 'DISMISSED', statusNote: 'Two separate deliveries, checked with Granite' });

    await scan();
    const after = await list(owner.auth, 'ALL');
    expect(after.alerts.find((a) => a.id === pays.id)!.status).toBe('ACKNOWLEDGED');
    expect(after.alerts.find((a) => a.id === bills.id)!.status).toBe('DISMISSED');
    expect((await list()).alerts.some((a) => a.id === bills.id)).toBe(false);
    expect((await list(owner.auth, 'DISMISSED')).alerts.map((a) => a.id)).toEqual([bills.id]);
  });

  it('clears an alert when the cause is fixed, and reopens a dismissed one on request', async () => {
    const r = await list();
    const pays = byRule(r.alerts, 'DUPLICATE_PAYMENT')[0];
    await ctx.http().post(`${org.base}/purchases/payments/${ids.pay2}/void`).set(owner.auth).send({ reason: 'Sent twice' }).expect(200);
    const s = await scan();
    expect(s.cleared).toBe(1);
    const d = (await ctx.http().get(`${org.base}/alerts/${pays.id}`).set(viewer.auth).expect(200)).body;
    expect(d.status).toBe('CLEARED');
    expect(d.history.map((h: { action: string; by: string | null; note: string | null }) => [h.action, h.by, h.note])).toEqual([
      ['OPENED', null, null],
      ['ACKNOWLEDGED', 'Alert Owner', 'Asked the bank for the second transfer'],
      ['CLEARED', 'Alert Owner', 'No longer found by the checks'],
    ]);
    expect(d.ruleDescription).toMatch(/same vendor for the same amount/);
    await ctx.http().post(`${org.base}/alerts/${pays.id}/dismiss`).set(owner.auth).send({ reason: 'Already fixed' }).expect(409);

    const bills = (await list(owner.auth, 'DISMISSED')).alerts[0];
    await ctx.http().post(`${org.base}/alerts/${pays.id}/reopen`).set(owner.auth).send({}).expect(409);
    const re = (await ctx.http().post(`${org.base}/alerts/${bills.id}/reopen`).set(owner.auth).send({ note: 'Granite says the second was a repeat' }).expect(200)).body;
    expect(re).toMatchObject({ status: 'OPEN', reopenCount: 1, statusNote: null });
    expect(re.history.at(-1)).toMatchObject({ action: 'REOPENED', by: 'Alert Owner', note: 'Granite says the second was a repeat' });

    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'alert', action: { not: 'alert.opened' } }, orderBy: { createdAt: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['alert.acknowledged', 'alert.dismissed', 'alert.reopened']);
  });

  it('a filing marked done clears its alert', async () => {
    const compliance = byRule((await list()).alerts, 'COMPLIANCE_DUE').filter((a) => a.title.startsWith('GSTR-1'));
    if (!compliance.length) return; // early in the fiscal year nothing may be due yet
    const cal = (await ctx.http().get(`${org.base}/compliance/calendar`).query({ from: T, to: addDays(T, 7) }).set(owner.auth).expect(200)).body;
    const key = [...cal.overdueBefore, ...cal.items].find((i: { kind: string; status: string }) => i.kind === 'GSTR1' && i.status === 'OVERDUE')?.key;
    if (!key) return;
    await ctx.http().post(`${org.base}/compliance/filings`).set(owner.auth).send({ key, filedOn: T, reference: 'ARN-AA2710' }).expect(201);
    const s = await scan();
    expect(s.cleared).toBe(1);
  });
});

describe('settings', () => {
  it('lists every check with its thresholds, and refuses bad values', async () => {
    const rules = (await ctx.http().get(`${org.base}/alert-rules`).set(viewer.auth).expect(200)).body as { key: string; enabled: boolean; values: Record<string, string>; updatedBy: string | null }[];
    expect(rules).toHaveLength(10);
    expect(rules.find((r) => r.key === 'UNUSUAL_JOURNAL')).toMatchObject({ enabled: true, values: { multiple: '5', minAmount: '100000', backdatedDays: '365' }, updatedBy: 'Alert Owner' });
    expect(rules.find((r) => r.key === 'DUPLICATE_BILL')).toMatchObject({ values: { windowDays: '7' }, updatedBy: null });
    await ctx.http().put(`${org.base}/alert-rules/DUPLICATE_BILL`).set(viewer.auth).send({ enabled: false }).expect(403);
    expect((await ctx.http().put(`${org.base}/alert-rules/DUPLICATE_BILL`).set(owner.auth).send({ enabled: true, params: { windowDays: '500' } }).expect(422)).body.message).toBe('Within: enter a value from 0 to 90');
    expect((await ctx.http().put(`${org.base}/alert-rules/DUPLICATE_BILL`).set(owner.auth).send({ enabled: true, params: { colour: '1' } }).expect(422)).body.message).toMatch(/not a setting/);
    await ctx.http().put(`${org.base}/alert-rules/NOT_A_RULE`).set(owner.auth).send({ enabled: true }).expect(400);
  });

  it('a tighter threshold finds more; turning a check off clears its alerts; turning it on reopens them', async () => {
    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_JOURNAL`).set(owner.auth).send({ enabled: true, params: { backdatedDays: '100' } }).expect(200);
    const s1 = await scan();
    expect(s1.opened).toBe(5); // the five journals dated 130 to 150 days ago, all posted today
    const j = byRule((await list()).alerts, 'UNUSUAL_JOURNAL');
    expect(j).toHaveLength(6);
    expect(j.filter((a) => /posted 1[345]\d days after its date/.test(a.title))).toHaveLength(5);

    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_JOURNAL`).set(owner.auth).send({ enabled: false, params: { backdatedDays: '100' } }).expect(200);
    const s2 = await scan();
    expect(s2.cleared).toBe(6);
    expect(byRule((await list()).alerts, 'UNUSUAL_JOURNAL')).toHaveLength(0);
    const one = byRule((await list(owner.auth, 'CLEARED')).alerts, 'UNUSUAL_JOURNAL')[0];
    expect((await ctx.http().get(`${org.base}/alerts/${one.id}`).set(owner.auth).expect(200)).body.history.at(-1)).toMatchObject({ action: 'CLEARED', note: 'The check was turned off' });

    await ctx.http().put(`${org.base}/alert-rules/UNUSUAL_JOURNAL`).set(owner.auth).send({ enabled: true, params: {} }).expect(200);
    const s3 = await scan();
    expect(s3.reopened).toBe(6);
    const back = byRule((await list()).alerts, 'UNUSUAL_JOURNAL');
    expect(back.every((a) => a.reopenCount === 1 && a.status === 'OPEN')).toBe(true);
    const audit = await ctx.prisma.auditEvent.count({ where: { orgId: org.orgId, action: 'alert_rule.updated' } });
    expect(audit).toBe(4);
  });
});

describe('protection', () => {
  it('the database keeps alerts whole and their history append-only', async () => {
    const a = (await list()).alerts[0];
    await expect(raw(`DELETE FROM alerts WHERE id = $1::uuid`, a.id)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`UPDATE alerts SET fingerprint = 'other' WHERE id = $1::uuid`, a.id)).rejects.toThrow(/keeps its organisation, check and finding/);
    await expect(raw(`UPDATE alerts SET status = 'DISMISSED', status_by_id = $2::uuid WHERE id = $1::uuid`, a.id, owner.id)).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE alerts SET status = 'CLEARED' WHERE id = $1::uuid`, a.id)).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE alerts SET reopen_count = 0 WHERE reopen_count > 0 AND org_id = $1::uuid`, org.orgId)).rejects.toThrow(/only goes up/);
    await expect(raw(`INSERT INTO alerts (id, org_id, rule, fingerprint, severity, title, summary, evidence, status, status_by_id, status_note, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'DUPLICATE_BILL', 'x', 'INFO', 't', 's', '{}', 'DISMISSED', $2::uuid, 'r', now())`, org.orgId, owner.id)).rejects.toThrow(/starts open/);
    await expect(raw(`INSERT INTO alerts (id, org_id, rule, fingerprint, severity, title, summary, evidence, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'MADE_UP', 'x', 'INFO', 't', 's', '{}', now())`, org.orgId)).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE alert_events SET note = 'edited' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/append-only/);
    await expect(raw(`DELETE FROM alert_scans WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/append-only/);
  });

  it('keeps each organisation to its own alerts', async () => {
    const a = (await list()).alerts[0];
    await ctx.http().get(`${org.base}/alerts`).set(stranger.auth).expect(404);
    const other = await createOrg(ctx, stranger);
    await ctx.http().get(`${other.base}/alerts/${a.id}`).set(stranger.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/alerts`).set(stranger.auth).expect(200)).body;
    expect(theirs.alerts.every((x: Alert) => x.id !== a.id)).toBe(true);
    await ctx.http().post(`${other.base}/alerts/${a.id}/acknowledge`).set(stranger.auth).send({}).expect(404);
  });
});
