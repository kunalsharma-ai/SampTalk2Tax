import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantStorage } from '../src/common/tenant-context';
import { JournalTemplatesService } from '../src/journal-templates/journal-templates.service';
import { RecurringBillsService } from '../src/recurring-bills/recurring-bills.service';
import { RenewalsRunnerService } from '../src/billing/payments/renewals-runner.service';
import { AuditService } from '../src/audit/audit.service';
import { SecurityMonitorService } from '../src/security-monitor/security-monitor.service';
import { HeartbeatsService } from '../src/operations/heartbeats.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Background jobs (PERF-006, PERF-019) with two API processes on one database, as when the API
 * runs on several servers: the runners that make journals and bills from schedules make each due
 * run once when both run at the same moment, again and again; and every runner reports to system
 * health, so one that stops is seen.
 */
let a: Ctx;
let b: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let fyStart: string;
let vendor: string;
// As the server runs them: outside any request.
const outside = <T>(fn: () => Promise<T>) => tenantStorage.run({}, fn);

beforeAll(async () => {
  a = await bootApp();
  b = await bootApp();
  owner = await registerUser(a, 'Background Jobs Owner');
  org = await createOrg(a, owner, { name: 'Background Jobs Pvt Ltd' });
  const periods = (await a.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { startDate: string }[];
  fyStart = periods.map((p) => p.startDate).sort()[0]!;
  vendor = (await a.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Steady Landlord', isVendor: true }).expect(201)).body.id;
}, 60_000);
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
});

describe('two servers running the same schedules (PERF-019)', () => {
  it('makes each due recurring journal once', async () => {
    const t = (
      await a
        .http()
        .post(`${org.base}/journal-templates`)
        .set(owner.auth)
        .send({
          name: 'Rent accrual',
          memo: 'Rent for {month}',
          lines: [
            { accountId: org.acc['6200'], debit: '1000.00' },
            { accountId: org.acc['2200'], credit: '1000.00' },
          ],
          schedule: { frequency: 'MONTHLY', startDate: fyStart, monthEnd: true, postMode: 'POST' },
        })
        .expect(201)
    ).body as { id: string };
    const asOf = addDays(fyStart, 100); // three month ends have passed
    const [x, y] = await Promise.all([outside(() => a.app.get(JournalTemplatesService).runAll(asOf, [org.orgId])), outside(() => b.app.get(JournalTemplatesService).runAll(asOf, [org.orgId]))]);
    expect(x.made + y.made).toBe(3);
    const again = await Promise.all([outside(() => a.app.get(JournalTemplatesService).runAll(asOf, [org.orgId])), outside(() => b.app.get(JournalTemplatesService).runAll(asOf, [org.orgId]))]);
    expect(again[0].made + again[1].made).toBe(0);
    const runs = (await a.http().get(`${org.base}/journal-templates/${t.id}`).set(owner.auth).expect(200)).body.runs as { runNo: number; scheduled: boolean }[];
    expect(
      runs
        .filter((r) => r.scheduled)
        .map((r) => r.runNo)
        .sort(),
    ).toEqual([1, 2, 3]);
    const journals = await a.prisma.journalEntry.count({ where: { orgId: org.orgId, type: 'RECURRING' } });
    expect(journals).toBe(3);
  });

  it('makes each due recurring bill once', async () => {
    const r = (
      await a
        .http()
        .post(`${org.base}/purchases/recurring-bills`)
        .set(owner.auth)
        .send({
          name: 'Office rent',
          contactId: vendor,
          reference: 'RENT-{period}',
          dueDays: 10,
          frequency: 'MONTHLY',
          startDate: fyStart,
          monthEnd: false,
          postMode: 'POST',
          lines: [{ accountId: org.acc['6200'], description: 'Rent {month}', quantity: '1', unitPrice: '5000' }],
        })
        .expect(201)
    ).body as { id: string };
    const asOf = addDays(fyStart, 70); // runs on day 1 of three months
    const [x, y] = await Promise.all([outside(() => a.app.get(RecurringBillsService).runAll(asOf, [org.orgId])), outside(() => b.app.get(RecurringBillsService).runAll(asOf, [org.orgId]))]);
    expect(x.made + y.made).toBe(3);
    const bills = await a.prisma.document.findMany({ where: { orgId: org.orgId, kind: 'BILL', contactId: vendor }, select: { reference: true } });
    expect(bills.map((d) => d.reference).sort()).toEqual([0, 1, 2].map((m) => `RENT-${addDays(fyStart, m * 31).slice(0, 7)}`));
    expect(r.id).toBeTruthy();
  });
});

describe('two servers issuing subscription renewals (PERF-019)', () => {
  it('issues one renewal invoice and sends one reminder when two passes run at once', async () => {
    const o = await createOrg(a, owner, { name: 'Renewing Twice Pvt Ltd' });
    const plan = await a.prisma.plan.findUniqueOrThrow({ where: { code: 'STARTER' } });
    await a.prisma.subscription.update({
      where: { orgId: o.orgId },
      data: {
        status: 'ACTIVE',
        planId: plan.id,
        billingInterval: 'MONTHLY',
        price: '499',
        currentPeriodStart: new Date(Date.now() - 25 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
      },
    });
    // One pass on each server at the same moment (a server never runs two passes at once).
    const passes = await Promise.all([a, b].map((c) => c.app.get(RenewalsRunnerService).tick({ orgIds: [o.orgId] })));
    expect(passes.reduce((n, p) => n + p.issued, 0)).toBe(1);
    const invoices = await a.prisma.subscriptionInvoice.findMany({ where: { orgId: o.orgId, kind: 'RENEWAL' } });
    expect(invoices).toHaveLength(1);
    expect(passes.reduce((n, p) => n + p.reminded, 0)).toBe(1);
    expect(await a.prisma.subscriptionEvent.count({ where: { orgId: o.orgId, kind: 'REMINDER_UPCOMING' } })).toBe(1);
  });
});

describe('two servers scanning for security alerts (PERF-019)', () => {
  it('opens one alert, and neither pass fails', async () => {
    const victim = await registerUser(a, 'Twice Watched');
    await a.prisma.$transaction((tx) =>
      a.app.get(AuditService).append(tx, { orgId: null, actorId: victim.id, action: 'user.mfa_challenge_failed', entityType: 'user', entityId: victim.id, data: { attempts: 5, ip: '198.51.100.8' } }),
    );
    await Promise.all([a, b].map((c) => c.app.get(SecurityMonitorService).scan()));
    expect(await a.prisma.securityAlert.count({ where: { rule: 'MFA_CODE_FAILURES', userId: victim.id } })).toBe(1);
  });
});

describe('background processing (PERF-006)', () => {
  it('every runner reports to system health', () => {
    const names = a.app
      .get(HeartbeatsService)
      .list()
      .map((r) => r.name);
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const n of ['Scheduled reports', 'Recurring journals', 'Recurring bills']) expect(names).toContain(n);
  });
});
