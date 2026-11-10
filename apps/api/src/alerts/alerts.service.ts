import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  ALERT_RULES,
  AlertError,
  alertRule,
  AlertRuleDef,
  AlertRuleKey,
  alertPriority,
  AlertSeverity,
  budgetOverruns,
  D,
  Dec,
  findDuplicates,
  fiscalYearForDate,
  KPI_DEFINITIONS,
  minorUnits,
  missedRecurringBilling,
  notifies,
  overdueByCustomer,
  resolveAlertParams,
  SEVERITY_ORDER,
  syncAlerts,
  unusualJournals,
} from '@talk2tax/accounting-engine';
import { AlertStatus, Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { BudgetsService } from '../budgets/budgets.service';
import { CashFlowService, todayIst } from '../cash-flow/cash-flow.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ComplianceService } from '../compliance/compliance.service';
import { KpisService } from '../kpis/kpis.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { TasksService } from '../tasks/tasks.service';
import { VendorRiskService } from '../vendor-risk/vendor-risk.service';
import { lockName } from '../db/locks';

type Actor = { id: string };

/** Opening alerts runs the checks first when the last run is older than this. */
export const STALE_AFTER_MINUTES = 60;
/** Bills and payments looked at for duplicates. */
const DUPLICATE_LOOKBACK_DAYS = 365;
/** Manual journals judged: those posted in the last 90 days, against the year before. */
const JOURNAL_WINDOW_DAYS = 90;
const JOURNAL_HISTORY_DAYS = 365;

export interface EvidenceFact {
  label: string;
  value: string;
  kind?: 'money' | 'date' | 'text';
}
export interface EvidenceLink {
  kind: 'INVOICE' | 'BILL' | 'PAYMENT' | 'JOURNAL' | 'CUSTOMER' | 'VENDOR' | 'PAGE';
  id?: string;
  /** For PAGE: the path inside the organisation, such as /planning/cash-flow. */
  path?: string;
  label: string;
}
export interface Evidence {
  facts: EvidenceFact[];
  links: EvidenceLink[];
  /** Records listed in a table, such as the bills of a possible duplicate. */
  rows?: { columns: string[]; items: { link?: EvidenceLink; cells: string[] }[] };
}
interface Finding {
  rule: AlertRuleKey;
  fingerprint: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  amount: Dec | null;
  evidence: Evidence;
}

const monthEndOf = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
function shiftMonth(month: string, by: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + by;
  return `${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const dateLabel = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Digits grouped for reading: Indian lakh/crore grouping for INR, thousands otherwise. Works on the decimal string, never a float. */
export function formatAmount(value: Dec | string, currency: string, scale: number): string {
  const s = new D(value).toFixed(scale);
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  let grouped: string;
  if (currency === 'INR' && int.length > 3) {
    const head = int.slice(0, -3);
    grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}`;
  } else grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  return `${neg ? '-' : ''}${sym}${grouped}${frac && /[1-9]/.test(frac) ? `.${frac}` : ''}`;
}

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
    private readonly cashFlow: CashFlowService,
    private readonly compliance: ComplianceService,
    private readonly kpis: KpisService,
    private readonly budgets: BudgetsService,
    private readonly tasks: TasksService,
    private readonly vendorRisk: VendorRiskService,
  ) {}

  // ------------------------------------------------------------------ notifications

  /** Who hears about new alerts. Without a saved setting: critical alerts become a task for owners, due the same day. */
  async notifications(orgId: string) {
    const s = await this.prisma.alertNotificationSetting.findUnique({ where: { orgId } });
    const who = s ? await this.names([s.updatedById]) : new Map<string, string>();
    return {
      minSeverity: (s?.minSeverity ?? 'CRITICAL') as 'CRITICAL' | 'WARNING' | 'OFF',
      taskRole: (s?.taskRole ?? 'OWNER') as 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER',
      dueDays: s?.dueDays ?? 0,
      isDefault: !s,
      updatedBy: s ? (who.get(s.updatedById) ?? null) : null,
      updatedAt: s?.updatedAt.toISOString() ?? null,
    };
  }

  async saveNotifications(orgId: string, actor: Actor, input: { minSeverity: 'CRITICAL' | 'WARNING' | 'OFF'; taskRole: 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'APPROVER'; dueDays: number }) {
    const before = await this.notifications(orgId);
    await this.prisma.$transaction(async (tx) => {
      await tx.alertNotificationSetting.upsert({ where: { orgId }, create: { orgId, ...input, updatedById: actor.id }, update: { ...input, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'alerts.notifications_changed', entityType: 'alert_notification_settings', entityId: orgId, data: { before: { minSeverity: before.minSeverity, taskRole: before.taskRole, dueDays: before.dueDays }, after: input } });
    });
    return this.notifications(orgId);
  }

  /** A task for a new or reopened alert, unless one is already open for it. */
  private async notifyInTx(tx: Prisma.TransactionClient, orgId: string, alert: { id: string; title: string; summary: string; severity: AlertSeverity }, setting: { minSeverity: 'CRITICAL' | 'WARNING' | 'OFF'; taskRole: string; dueDays: number }) {
    if (!notifies(alert.severity, setting.minSeverity)) return;
    const open = await tx.task.findFirst({ where: { orgId, linkType: 'ALERT', linkId: alert.id, status: 'OPEN' }, select: { id: true } });
    if (open) return;
    await this.tasks.createInTx(tx, orgId, {
      title: `${alert.severity === 'CRITICAL' ? 'Critical alert' : alert.severity === 'WARNING' ? 'Warning' : 'Alert'}: ${alert.title}`,
      description: `${alert.summary} This task closes itself when the alert is cleared or dismissed.`,
      assignTo: { role: setting.taskRole as 'OWNER' },
      dueDate: addDays(todayIst(), setting.dueDays),
      link: { type: 'ALERT', id: alert.id },
      createdById: null,
      source: 'ALERT',
    });
  }

  /** Closes the open tasks for alerts that were cleared (done) or dismissed (cancelled). */
  private async closeTasksInTx(tx: Prisma.TransactionClient, orgId: string, alertIds: string[], to: 'DONE' | 'CANCELLED', note: string, actorId: string | null) {
    if (!alertIds.length) return;
    const open = await tx.task.findMany({ where: { orgId, linkType: 'ALERT', linkId: { in: alertIds }, status: 'OPEN' }, select: { id: true, title: true } });
    for (const t of open) {
      await tx.task.update({ where: { id: t.id }, data: { status: to, closedById: actorId, closedAt: new Date(), closeNote: note.slice(0, 1000) } });
      await this.audit.append(tx, { orgId, actorId, action: to === 'DONE' ? 'task.completed' : 'task.cancelled', entityType: 'task', entityId: t.id, data: { title: t.title, note, automatic: true } });
    }
  }

  private async org(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true, fiscalYearStartMonth: true } });
    const scale = minorUnits(o.functionalCurrency);
    return { currency: o.functionalCurrency, scale, startMonth: o.fiscalYearStartMonth, money: (x: Dec | string) => formatAmount(x, o.functionalCurrency, scale) };
  }
  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map<string, string>();
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }

  // ------------------------------------------------------------------ settings

  private async settingsByRule(orgId: string) {
    const rows = await this.prisma.alertRuleSetting.findMany({ where: { orgId } });
    return new Map(rows.map((r) => [r.rule, r]));
  }

  async rules(orgId: string) {
    const by = await this.settingsByRule(orgId);
    const who = await this.names([...by.values()].map((r) => r.updatedById));
    return ALERT_RULES.map((def) => {
      const s = by.get(def.key);
      const params = resolveAlertParams(def, (s?.params as Record<string, unknown>) ?? null);
      return {
        ...def,
        enabled: s?.enabled ?? true,
        values: Object.fromEntries(def.params.map((x) => [x.key, params[x.key].toFixed()])),
        updatedAt: s?.updatedAt.toISOString() ?? null,
        updatedBy: s ? (who.get(s.updatedById) ?? null) : null,
      };
    });
  }

  async saveRule(orgId: string, actor: Actor, rule: AlertRuleKey, input: { enabled: boolean; params: Record<string, string> }) {
    const def = alertRule(rule);
    try {
      resolveAlertParams(def, input.params);
    } catch (e) {
      if (e instanceof AlertError) throw new DomainError('INVALID_SETTING', e.message);
      throw e;
    }
    const params = Object.fromEntries(Object.entries(input.params).map(([k, v]) => [k, new D(v.trim()).toFixed()]));
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.alertRuleSetting.findUnique({ where: { orgId_rule: { orgId, rule } } });
      const row = await tx.alertRuleSetting.upsert({
        where: { orgId_rule: { orgId, rule } },
        create: { orgId, rule, enabled: input.enabled, params, updatedById: actor.id },
        update: { enabled: input.enabled, params, updatedById: actor.id },
      });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'alert_rule.updated',
        entityType: 'alert_rule_setting',
        entityId: row.id,
        data: { rule, from: before ? { enabled: before.enabled, params: before.params } : null, to: { enabled: input.enabled, params } },
      });
    });
    return (await this.rules(orgId)).find((r) => r.key === rule)!;
  }

  // ------------------------------------------------------------------ the checks

  private async detect(orgId: string, def: AlertRuleDef, p: Record<string, Dec>, today: string, o: Awaited<ReturnType<AlertsService['org']>>): Promise<Finding[]> {
    switch (def.key) {
      case 'CASH_BELOW_MINIMUM': {
        const settings = await this.prisma.cashFlowSettings.findUnique({ where: { orgId } });
        const minimum = settings ? new D(settings.minimumBalance.toFixed()) : new D(0);
        if (minimum.lte(0)) return [];
        const horizonDays = p.horizonDays.toNumber();
        const f = await this.cashFlow.forecast(orgId, { horizonDays });
        const day = f.belowBuffer.base ?? f.belowBuffer.low;
        if (!day) return [];
        const expected = !!f.belowBuffer.base;
        const lowest = expected ? f.lowest.base : f.lowest.low;
        return [
          {
            rule: def.key,
            fingerprint: 'cash',
            severity: expected ? 'CRITICAL' : 'WARNING',
            title: expected ? `Cash expected below the minimum balance from ${dateLabel(day)}` : `Cash could fall below the minimum balance from ${dateLabel(day)}`,
            summary: `${expected ? 'The expected case' : 'Only the low case'} of the ${horizonDays}-day forecast goes below ${o.money(minimum)}. Its lowest point is ${o.money(lowest.amount)} on ${dateLabel(lowest.date)}.`,
            amount: minimum.minus(lowest.amount),
            evidence: {
              facts: [
                { label: 'Minimum balance', value: o.money(minimum), kind: 'money' },
                { label: 'Cash and bank today', value: o.money(f.opening), kind: 'money' },
                { label: 'First day below, expected case', value: f.belowBuffer.base ? dateLabel(f.belowBuffer.base) : 'Not within the forecast' },
                { label: 'First day below, low case', value: f.belowBuffer.low ? dateLabel(f.belowBuffer.low) : 'Not within the forecast' },
                { label: 'Lowest expected balance', value: `${o.money(f.lowest.base.amount)} on ${dateLabel(f.lowest.base.date)}` },
                { label: 'Lowest in the low case', value: `${o.money(f.lowest.low.amount)} on ${dateLabel(f.lowest.low.date)}` },
              ],
              links: [{ kind: 'PAGE', path: '/planning/cash-flow', label: 'Open the cash-flow forecast' }],
            },
          },
        ];
      }
      case 'OVERDUE_RECEIVABLES': {
        const days = p.daysOverdue.toNumber();
        const items = (await this.subledger.openItems(this.prisma, orgId, 'SALES', today)).filter((i) => i.type === 'charge' && i.dueDate);
        const names = new Map(items.map((i) => [i.contactId, i.contactName]));
        return overdueByCustomer(
          items.map((i) => ({ id: i.id, contactId: i.contactId, number: i.number, dueDate: i.dueDate!, open: i.open })),
          today,
          days,
          p.minAmount,
        ).map((c) => ({
          rule: def.key,
          fingerprint: c.contactId,
          severity: c.oldestDays > 90 ? 'CRITICAL' : 'WARNING',
          title: `${names.get(c.contactId)} owes ${o.money(c.total)} more than ${days} days overdue`,
          summary: `${plural(c.invoices.length, 'invoice')} more than ${days} days past due; the oldest by ${c.oldestDays} days.`,
          amount: c.total,
          evidence: {
            facts: [
              { label: 'Overdue', value: o.money(c.total), kind: 'money' },
              { label: 'Oldest', value: `${c.oldestDays} days past due` },
            ],
            links: [{ kind: 'CUSTOMER', id: c.contactId, label: `Open ${names.get(c.contactId)}` }],
            rows: {
              columns: ['Invoice', 'Due', 'Days overdue', 'Open'],
              items: c.invoices.map((i) => ({ link: { kind: 'INVOICE', id: i.id, label: i.number }, cells: [i.number, dateLabel(i.dueDate), String(i.daysOverdue), o.money(i.open)] })),
            },
          },
        }));
      }
      case 'COMPLIANCE_DUE': {
        const ahead = p.daysAhead.toNumber();
        const cal = await this.compliance.calendar(orgId, today, addDays(today, ahead));
        if (!cal.configured) return [];
        return [...cal.overdueBefore, ...cal.items]
          .filter((i) => i.status === 'OVERDUE' || ((i.status === 'DUE_SOON' || i.status === 'UPCOMING') && i.daysLeft <= ahead))
          .map((i) => {
            const overdue = i.status === 'OVERDUE';
            return {
              rule: def.key,
              fingerprint: i.key,
              severity: overdue ? ('CRITICAL' as const) : ('WARNING' as const),
              title: `${i.name} for ${i.periodLabel} ${overdue ? `was due on ${dateLabel(i.dueDate)}` : i.daysLeft === 0 ? 'is due today' : `is due on ${dateLabel(i.dueDate)}`}`,
              summary: `${overdue ? `${plural(-i.daysLeft, 'day')} overdue.` : `Due in ${plural(i.daysLeft, 'day')}.`} ${i.detail}${i.outstanding && new D(i.outstanding).gt(0) ? `; ${o.money(i.outstanding)} still to pay` : ''}.`,
              amount: i.outstanding && new D(i.outstanding).gt(0) ? new D(i.outstanding) : null,
              evidence: {
                facts: [
                  { label: 'Due date', value: dateLabel(i.dueDate), kind: 'date' as const },
                  { label: 'Period', value: i.periodLabel },
                  { label: 'Status', value: i.detail },
                  ...(i.amount ? [{ label: 'Due for the period', value: o.money(i.amount), kind: 'money' as const }] : []),
                  ...(i.outstanding ? [{ label: 'Still to pay', value: o.money(i.outstanding), kind: 'money' as const }] : []),
                ],
                links: [{ kind: 'PAGE' as const, path: '/tax/compliance', label: 'Open the compliance calendar' }],
              },
            };
          });
      }
      case 'KPI_TARGET_MISSED': {
        const k = await this.kpis.kpis(orgId, {});
        const unit = (u: string, v: string) => (u === 'PERCENT' ? `${v}%` : u === 'DAYS' ? `${v} days` : u === 'MONTHS' ? `${v} months` : u === 'MONEY' ? o.money(v) : v);
        return k.kpis
          .filter((x) => x.target?.status === 'MISSED' && x.value !== null)
          .map((x) => {
            const def2 = KPI_DEFINITIONS.find((d) => d.key === x.key)!;
            const t = x.target!;
            return {
              rule: def.key,
              fingerprint: x.key,
              severity: 'WARNING' as const,
              title: `${def2.label} missed its target in ${monthLabel(k.month)}`,
              summary: `${unit(def2.unit, x.value!)} against a target of ${t.comparator === 'AT_LEAST' ? 'at least' : 'at most'} ${unit(def2.unit, t.target)}.${t.note ? ` Target note: ${t.note}` : ''}`,
              amount: null,
              evidence: {
                facts: [
                  { label: 'Month', value: monthLabel(k.month) },
                  { label: 'Value', value: unit(def2.unit, x.value!) },
                  { label: 'Target', value: `${t.comparator === 'AT_LEAST' ? 'At least' : 'At most'} ${unit(def2.unit, t.target)}` },
                  { label: 'Previous month', value: x.previous === null ? 'No value' : unit(def2.unit, x.previous) },
                  { label: 'Formula', value: def2.formula },
                ],
                links: [{ kind: 'PAGE' as const, path: '/reports/kpis', label: 'Open KPIs' }],
              },
            };
          });
      }
      case 'BUDGET_OVERRUN': {
        const fy = fiscalYearForDate(today, o.startMonth);
        const budget = await this.prisma.budget.findFirst({ where: { orgId, fiscalYear: fy, status: 'APPROVED' } });
        if (!budget) return [];
        const periods = this.budgets.periods(fy, o.startMonth);
        const done = periods.filter((x) => x.endDate < today);
        if (!done.length) return [];
        const [lines, accounts, actual] = await Promise.all([
          this.prisma.budgetLine.findMany({ where: { orgId, budgetId: budget.id, periodNo: { lte: done.length } } }),
          this.prisma.account.findMany({ where: { orgId, type: 'EXPENSE' }, select: { id: true, code: true, name: true } }),
          this.budgets.actuals(orgId, done[0].startDate, done[done.length - 1].endDate),
        ]);
        const budgetBy = new Map<string, Dec>();
        for (const l of lines) budgetBy.set(l.accountId, (budgetBy.get(l.accountId) ?? new D(0)).plus(l.amount.toFixed()));
        const rows = accounts.map((a) => ({ accountId: a.id, budget: budgetBy.get(a.id) ?? new D(0), actual: [...(actual.get(a.id)?.values() ?? [])].reduce((s, x) => s.plus(x), new D(0)) }));
        const acc = new Map(accounts.map((a) => [a.id, a]));
        const through = done[done.length - 1];
        return budgetOverruns(rows, { percent: p.percent, minAmount: p.minAmount }).map((x) => {
          const a = acc.get(x.accountId)!;
          return {
            rule: def.key,
            fingerprint: `${fy}:${x.accountId}`,
            severity: 'WARNING' as const,
            title: x.percent ? `${a.code} ${a.name} is ${x.percent}% over budget` : `${a.code} ${a.name} has spending with no budget`,
            summary: `FY${fy} to the end of ${through.label}: ${o.money(x.actual)} spent against ${o.money(x.budget)} budgeted, ${o.money(x.over)} over.`,
            amount: x.over,
            evidence: {
              facts: [
                { label: 'Budget', value: `${budget.name} (version ${budget.version})` },
                { label: 'Period', value: `${periods[0].label} – ${through.label}` },
                { label: 'Budgeted', value: o.money(x.budget), kind: 'money' as const },
                { label: 'Spent', value: o.money(x.actual), kind: 'money' as const },
                { label: 'Over', value: `${o.money(x.over)}${x.percent ? ` (${x.percent}%)` : ''}`, kind: 'money' as const },
              ],
              links: [{ kind: 'PAGE' as const, path: '/planning/budget-vs-actual', label: 'Open budget vs actual' }],
            },
          };
        });
      }
      case 'MISSED_RECURRING_BILLING': {
        const lookback = p.months.toNumber();
        const month = shiftMonth(today.slice(0, 7), -1);
        const from = `${shiftMonth(month, -lookback)}-01`;
        const to = `${shiftMonth(month, 1)}-01`;
        const docs = await this.prisma.document.findMany({
          where: { orgId, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { gte: toDbDate(from), lt: toDbDate(to) } },
          select: { id: true, kind: true, contactId: true, number: true, issueDate: true, subtotal: true },
        });
        const contactName = new Map((docs.length ? await this.prisma.contact.findMany({ where: { orgId, id: { in: [...new Set(docs.map((d) => d.contactId))] } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
        // By customer and month: invoices less credit notes, and the latest invoice (by date, then number).
        const groups = new Map<string, { contact_id: string; name: string; month: string; amount: Prisma.Decimal; n: number; last: (typeof docs)[number] | null }>();
        for (const d of docs) {
          const month = fromDbDate(d.issueDate).slice(0, 7);
          const k = `${d.contactId}|${month}`;
          const g = groups.get(k) ?? { contact_id: d.contactId, name: contactName.get(d.contactId) ?? '', month, amount: new Prisma.Decimal(0), n: 0, last: null };
          g.amount = d.kind === 'INVOICE' ? g.amount.plus(d.subtotal) : g.amount.minus(d.subtotal);
          if (d.kind === 'INVOICE') {
            g.n += 1;
            const l = g.last;
            if (!l || d.issueDate > l.issueDate || (d.issueDate.getTime() === l.issueDate.getTime() && (d.number ?? '') > (l.number ?? ''))) g.last = d;
          }
          groups.set(k, g);
        }
        const rows = [...groups.values()].map((g) => ({ ...g, last_id: g.last?.id ?? null, last_number: g.last?.number ?? '' }));
        const name = new Map(rows.map((r) => [r.contact_id, r.name]));
        const last = new Map<string, { id: string; number: string; month: string }>();
        for (const r of rows) if (r.last_id && (!last.has(r.contact_id) || last.get(r.contact_id)!.month < r.month)) last.set(r.contact_id, { id: r.last_id, number: r.last_number, month: r.month });
        return missedRecurringBilling(
          rows.map((r) => ({ contactId: r.contact_id, month: r.month, amount: r.amount.toFixed() })),
          month,
          lookback,
        ).map((m) => {
          const l = last.get(m.contactId);
          return {
            rule: def.key,
            fingerprint: m.contactId,
            severity: 'WARNING' as const,
            title: `${name.get(m.contactId)} was not invoiced in ${monthLabel(month)}`,
            summary: `Invoiced every month from ${monthLabel(m.history[0].month)} to ${monthLabel(m.history[m.history.length - 1].month)}, usually ${o.money(m.typical)} before tax, but nothing in ${monthLabel(month)}. Check whether work or a subscription was not billed.`,
            amount: m.typical,
            evidence: {
              facts: [
                { label: 'Usual monthly amount', value: o.money(m.typical), kind: 'money' as const },
                { label: monthLabel(month), value: 'No invoice' },
              ],
              links: [{ kind: 'CUSTOMER' as const, id: m.contactId, label: `Open ${name.get(m.contactId)}` }, ...(l ? [{ kind: 'INVOICE' as const, id: l.id, label: `Last invoice ${l.number}` }] : [])],
              rows: { columns: ['Month', 'Invoiced before tax'], items: [...m.history.map((h) => ({ cells: [monthLabel(h.month), o.money(h.amount)] })), { cells: [monthLabel(month), o.money('0')] }] },
            },
          };
        });
      }
      case 'DUPLICATE_BILL':
      case 'DUPLICATE_PAYMENT': {
        const window = p.windowDays.toNumber();
        const since = toDbDate(addDays(today, -DUPLICATE_LOOKBACK_DAYS));
        const bills = def.key === 'DUPLICATE_BILL';
        const items = bills
          ? (await this.prisma.document.findMany({ where: { orgId, kind: 'BILL', status: 'POSTED', issueDate: { gte: since } }, select: { id: true, contactId: true, issueDate: true, total: true, exchangeRate: true, number: true, reference: true, contact: { select: { name: true } } } })).map((d) => ({
              id: d.id,
              contactId: d.contactId,
              date: fromDbDate(d.issueDate),
              amount: d.total.times(d.exchangeRate).toDecimalPlaces(2).toFixed(),
              number: d.number ?? '',
              reference: d.reference,
              contactName: d.contact.name,
            }))
          : (await this.prisma.payment.findMany({ where: { orgId, kind: 'PAYMENT', status: 'POSTED', date: { gte: since } }, select: { id: true, contactId: true, date: true, amount: true, number: true, reference: true, contact: { select: { name: true } } } })).map((d) => ({
              id: d.id,
              contactId: d.contactId,
              date: fromDbDate(d.date),
              amount: d.amount.toFixed(),
              number: d.number,
              reference: d.reference,
              contactName: d.contact.name,
            }));
        return findDuplicates(items, window).map((g) => {
          const vendor = g.items[0].contactName;
          const what = bills ? 'bill' : 'payment';
          return {
            rule: def.key,
            fingerprint: g.items[0].id,
            severity: bills ? ('WARNING' as const) : ('CRITICAL' as const),
            title: `Possible duplicate ${what}: ${plural(g.items.length, what)} to ${vendor} for ${o.money(g.amount)}`,
            summary: `${plural(g.items.length, `posted ${what}`)} to the same vendor for the same amount within ${plural(g.spanDays, 'day')}. If one is a repeat, ${bills ? 'void it before it is paid' : 'ask the vendor for a refund or keep it as an advance'}; if they are separate, dismiss this alert with the reason.`,
            amount: g.amount.times(g.items.length - 1),
            evidence: {
              facts: [
                { label: 'Vendor', value: vendor },
                { label: 'Amount each', value: o.money(g.amount), kind: 'money' as const },
                { label: 'At stake if repeated', value: o.money(g.amount.times(g.items.length - 1)), kind: 'money' as const },
              ],
              links: [{ kind: 'VENDOR' as const, id: g.contactId, label: `Open ${vendor}` }],
              rows: {
                columns: [bills ? 'Bill' : 'Payment', 'Date', bills ? 'Vendor invoice no.' : 'Reference', 'Amount'],
                items: g.items.map((i) => ({ link: { kind: bills ? ('BILL' as const) : ('PAYMENT' as const), id: i.id, label: i.number }, cells: [i.number, dateLabel(i.date), i.reference ?? '—', o.money(i.amount)] })),
              },
            },
          };
        });
      }
      case 'VENDOR_RISK': {
        const r = await this.vendorRisk.list(orgId);
        const why = { NEVER_REVIEWED: 'nobody has reviewed it yet', NEW_RISK: 'something new since the last review', REVIEW_DUE: 'the review date has come' } as const;
        return r.vendors
          .filter((v) => v.need && (v.level === 'HIGH' || v.level === 'MEDIUM' || v.need === 'REVIEW_DUE'))
          .map((v) => {
            const shown = v.need === 'NEW_RISK' ? v.factors.filter((f) => v.newFactors.includes(f.code)) : v.factors;
            return {
              rule: def.key,
              fingerprint: v.id,
              severity: v.level === 'HIGH' ? ('CRITICAL' as const) : v.level === 'MEDIUM' ? ('WARNING' as const) : ('INFO' as const),
              title: `${v.name}: ${v.level.toLowerCase()} vendor risk, ${why[v.need!]}`,
              summary: `${shown.map((f) => f.title).join('; ')}. Open the vendor's Risk card, look at each factor and record a review with what you decided.`,
              amount: new D(v.owed).gt(0) ? new D(v.owed) : null,
              evidence: {
                facts: [
                  { label: 'Vendor', value: v.name },
                  { label: 'Risk', value: v.level.charAt(0) + v.level.slice(1).toLowerCase() },
                  { label: 'Owed to the vendor', value: o.money(v.owed), kind: 'money' as const },
                  ...(v.lastReview ? [{ label: 'Last review', value: `${dateLabel(v.lastReview.reviewedOn)}, next due ${dateLabel(v.lastReview.nextReviewOn)}` }] : []),
                  ...shown.map((f) => ({ label: f.title, value: f.detail })),
                ],
                links: [{ kind: 'VENDOR' as const, id: v.id, label: `Open ${v.name}` }, { kind: 'PAGE' as const, path: '/purchases/vendor-risk', label: 'Open vendor risk' }],
              },
            };
          });
      }
      case 'UNUSUAL_JOURNAL': {
        const since = new Date(Date.now() - JOURNAL_WINDOW_DAYS * 86_400_000);
        const windowStart = addDays(today, -JOURNAL_WINDOW_DAYS);
        const [recent, history] = await Promise.all([
          this.prisma.journalEntry.findMany({ where: { orgId, source: 'MANUAL', status: 'POSTED', postedAt: { gte: since } }, select: { id: true, entryNumber: true, date: true, postedAt: true, totalDebit: true, memo: true, postedById: true } }),
          this.prisma.journalEntry.findMany({
            where: { orgId, source: 'MANUAL', status: 'POSTED', date: { gte: toDbDate(addDays(windowStart, -JOURNAL_HISTORY_DAYS)), lt: toDbDate(windowStart) } },
            select: { totalDebit: true },
          }),
        ]);
        const found = unusualJournals(
          recent.map((j) => ({ id: j.id, date: fromDbDate(j.date), postedOn: istDate(j.postedAt!), total: j.totalDebit.toFixed() })),
          history.map((h) => h.totalDebit.toFixed()),
          { multiple: p.multiple, minAmount: p.minAmount, backdatedDays: p.backdatedDays.toNumber() },
        );
        const by = new Map(recent.map((j) => [j.id, j]));
        const who = await this.names(recent.map((j) => j.postedById));
        return found.map((u) => {
          const j = by.get(u.id)!;
          const label = `Journal #${j.entryNumber}`;
          return {
            rule: def.key,
            fingerprint: u.id,
            severity: u.reasons.length > 1 ? ('WARNING' as const) : ('INFO' as const),
            title: `${label} for ${o.money(u.total)}: ${u.reasons.map((r) => r.text.charAt(0).toLowerCase() + r.text.slice(1)).join('; ')}`,
            summary: `A manual journal${j.memo ? ` ("${j.memo}")` : ''} dated ${dateLabel(fromDbDate(j.date))}. Check that it has support and was reviewed.`,
            amount: u.total,
            evidence: {
              facts: [
                { label: 'Amount', value: o.money(u.total), kind: 'money' as const },
                { label: 'Journal date', value: dateLabel(fromDbDate(j.date)), kind: 'date' as const },
                { label: 'Posted', value: `${dateLabel(istDate(j.postedAt!))}${j.postedById && who.get(j.postedById) ? ` by ${who.get(j.postedById)}` : ''}` },
                { label: 'Usual manual journal', value: u.typical ? o.money(u.typical) : 'Fewer than 5 manual journals in the year before' },
                ...u.reasons.map((r) => ({ label: r.code === 'LARGE' ? 'Size' : 'Timing', value: r.text })),
              ],
              links: [{ kind: 'JOURNAL' as const, id: u.id, label: `Open ${label}` }],
            },
          };
        });
      }
    }
  }

  /**
   * Run every check that is on, then open, refresh, reopen and clear alerts to match.
   * `actor` null = run automatically because the last run was stale; then nothing is
   * written when another run finished meanwhile.
   */
  async scan(orgId: string, actor: Actor | null) {
    const startedAt = new Date();
    const today = todayIst();
    const o = await this.org(orgId);
    const settings = await this.settingsByRule(orgId);
    const findings: Finding[] = [];
    const ran: AlertRuleKey[] = [];
    const off: AlertRuleKey[] = [];
    const failures: { rule: string; message: string }[] = [];
    for (const def of ALERT_RULES) {
      const s = settings.get(def.key);
      if (s && !s.enabled) {
        off.push(def.key);
        continue;
      }
      try {
        const params = resolveAlertParams(def, (s?.params as Record<string, unknown>) ?? null);
        findings.push(...(await this.detect(orgId, def, params, today, o)));
        ran.push(def.key);
      } catch (e) {
        failures.push({ rule: def.key, message: e instanceof Error ? e.message.slice(0, 300) : 'Unknown error' });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await lockName(tx, `t2t.alerts:${orgId}`);
      if (!actor) {
        const newer = await tx.alertScan.findFirst({ where: { orgId, finishedAt: { gte: startedAt } }, select: { id: true } });
        if (newer) return null;
      }
      const existing = await tx.alert.findMany({ where: { orgId }, select: { id: true, rule: true, fingerprint: true, status: true } });
      const ns = await tx.alertNotificationSetting.findUnique({ where: { orgId } });
      const notify = { minSeverity: (ns?.minSeverity ?? 'CRITICAL') as 'CRITICAL' | 'WARNING' | 'OFF', taskRole: ns?.taskRole ?? 'OWNER', dueDays: ns?.dueDays ?? 0 };
      const sync = syncAlerts(existing, findings, ran);
      const now = new Date();
      const byKey = new Map(findings.map((f) => [`${f.rule}\u0000${f.fingerprint}`, f]));
      const content = (f: Finding) => ({ severity: f.severity, title: f.title.slice(0, 300), summary: f.summary.slice(0, 2000), amount: f.amount ? new Prisma.Decimal(f.amount.toFixed(6)) : null, evidence: f.evidence as unknown as Prisma.InputJsonValue });
      for (const c of sync.create) {
        const f = byKey.get(`${c.rule}\u0000${c.fingerprint}`)!;
        const a = await tx.alert.create({ data: { orgId, rule: f.rule, fingerprint: f.fingerprint, ...content(f), firstSeenAt: now, lastSeenAt: now } });
        await tx.alertEvent.create({ data: { orgId, alertId: a.id, action: 'OPENED', actorId: actor?.id ?? null } });
        // Recorded in the audit trail so that automations can act on a new alert.
        await this.audit.append(tx, { orgId, actorId: null, action: 'alert.opened', entityType: 'alert', entityId: a.id, data: { rule: f.rule, title: a.title, severity: f.severity, reopened: false } });
        await this.notifyInTx(tx, orgId, { id: a.id, title: a.title, summary: a.summary, severity: f.severity }, notify);
      }
      const ruleOf = new Map(existing.map((e) => [e.id, e.rule]));
      for (const r of sync.refresh) {
        const f = byKey.get(`${ruleOf.get(r.id)}\u0000${r.fingerprint}`)!;
        await tx.alert.update({
          where: { id: r.id },
          data: { ...content(f), lastSeenAt: now, ...(r.reopen ? { status: 'OPEN', clearedAt: null, statusNote: null, statusById: null, statusAt: now, reopenCount: { increment: 1 } } : {}) },
        });
        if (r.reopen) {
          await tx.alertEvent.create({ data: { orgId, alertId: r.id, action: 'REOPENED', actorId: actor?.id ?? null, note: 'Found again by the checks' } });
          await this.audit.append(tx, { orgId, actorId: null, action: 'alert.opened', entityType: 'alert', entityId: r.id, data: { rule: f.rule, title: f.title.slice(0, 300), severity: f.severity, reopened: true } });
          await this.notifyInTx(tx, orgId, { id: r.id, title: f.title.slice(0, 300), summary: f.summary.slice(0, 2000), severity: f.severity }, notify);
        }
      }
      const offIds = existing.filter((e) => off.includes(e.rule as AlertRuleKey) && (e.status === 'OPEN' || e.status === 'ACKNOWLEDGED')).map((e) => e.id);
      for (const [ids, note] of [
        [sync.clear, 'No longer found by the checks'],
        [offIds, 'The check was turned off'],
      ] as const) {
        for (const id of ids) {
          await tx.alert.update({ where: { id }, data: { status: 'CLEARED', clearedAt: now, statusAt: now } });
          await tx.alertEvent.create({ data: { orgId, alertId: id, action: 'CLEARED', actorId: actor?.id ?? null, note } });
        }
        await this.closeTasksInTx(tx, orgId, [...ids], 'DONE', `The alert cleared: ${note.charAt(0).toLowerCase()}${note.slice(1)}.`, actor?.id ?? null);
      }
      const reopened = sync.refresh.filter((r) => r.reopen).length;
      const scan = await tx.alertScan.create({
        data: { orgId, ranById: actor?.id ?? null, startedAt, finishedAt: new Date(), rulesRun: ran.length, found: findings.length, opened: sync.create.length, reopened, cleared: sync.clear.length + offIds.length, failures },
      });
      return scan;
    });
    return result;
  }

  private serializeScan(s: { id: string; ranById: string | null; startedAt: Date; finishedAt: Date; rulesRun: number; found: number; opened: number; reopened: number; cleared: number; failures: Prisma.JsonValue }, who: Map<string, string>) {
    return {
      id: s.id,
      ranBy: s.ranById ? (who.get(s.ranById) ?? null) : null,
      automatic: !s.ranById,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt.toISOString(),
      rulesRun: s.rulesRun,
      found: s.found,
      opened: s.opened,
      reopened: s.reopened,
      cleared: s.cleared,
      failures: s.failures as { rule: string; message: string }[],
    };
  }

  async runScan(orgId: string, actor: Actor) {
    const s = (await this.scan(orgId, actor))!;
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId, actorId: actor.id, action: 'alerts.checks_run', entityType: 'alert_scan', entityId: s.id, data: { found: s.found, opened: s.opened, reopened: s.reopened, cleared: s.cleared, failures: s.failures } }),
    );
    return this.serializeScan(s, await this.names([actor.id]));
  }

  // ------------------------------------------------------------------ reading

  /** Average operating revenue of the last three complete months, to judge amounts against. */
  private async monthlyRevenue(orgId: string): Promise<string | null> {
    const last = shiftMonth(todayIst().slice(0, 7), -1);
    const months = await this.kpis.monthFigures(orgId, last, monthEndOf(last), 3);
    if (!months.length) return null;
    const total = months.reduce((t, m) => t.plus(m.operatingRevenue), new Prisma.Decimal(0));
    return total.div(months.length).toFixed(2);
  }

  private serialize(a: Awaited<ReturnType<PrismaService['alert']['findFirstOrThrow']>>, who: Map<string, string>, monthlyRevenue: string | null) {
    const def = ALERT_RULES.find((r) => r.key === a.rule);
    const priority = alertPriority({ severity: a.severity, status: a.status, amount: a.amount?.toFixed() ?? null, monthlyRevenue, firstSeenAt: a.firstSeenAt.toISOString().slice(0, 10), reopenCount: a.reopenCount, today: todayIst() });
    return {
      id: a.id,
      rule: a.rule,
      ruleName: def?.name ?? a.rule,
      area: def?.area ?? null,
      severity: a.severity,
      title: a.title,
      summary: a.summary,
      amount: a.amount?.toFixed() ?? null,
      evidence: a.evidence as unknown as Evidence,
      status: a.status,
      statusNote: a.statusNote,
      statusBy: a.statusById ? (who.get(a.statusById) ?? null) : null,
      statusAt: a.statusAt?.toISOString() ?? null,
      firstSeenAt: a.firstSeenAt.toISOString(),
      lastSeenAt: a.lastSeenAt.toISOString(),
      clearedAt: a.clearedAt?.toISOString() ?? null,
      reopenCount: a.reopenCount,
      priority,
    };
  }

  /**
   * Alerts by state: ACTIVE (open and acknowledged), DISMISSED, CLEARED or ALL. Runs the
   * checks first when the last run is older than STALE_AFTER_MINUTES.
   */
  async list(orgId: string, q: { status: 'ACTIVE' | 'DISMISSED' | 'CLEARED' | 'ALL'; fresh?: boolean }) {
    let last = await this.prisma.alertScan.findFirst({ where: { orgId }, orderBy: { finishedAt: 'desc' } });
    if (q.fresh !== false && (!last || Date.now() - last.finishedAt.getTime() > STALE_AFTER_MINUTES * 60_000)) {
      await this.scan(orgId, null);
      last = await this.prisma.alertScan.findFirst({ where: { orgId }, orderBy: { finishedAt: 'desc' } });
    }
    const statuses: AlertStatus[] = q.status === 'ACTIVE' ? ['OPEN', 'ACKNOWLEDGED'] : q.status === 'ALL' ? ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CLEARED'] : [q.status];
    const [rows, counts] = await Promise.all([
      this.prisma.alert.findMany({ where: { orgId, status: { in: statuses } }, orderBy: { lastSeenAt: 'desc' }, take: 500 }),
      this.prisma.alert.groupBy({ by: ['status', 'severity'], where: { orgId }, _count: { _all: true } }),
    ]);
    const who = await this.names([...rows.map((r) => r.statusById), last?.ranById ?? null]);
    const revenue = await this.monthlyRevenue(orgId);
    const alerts = rows.map((r) => this.serialize(r, who, revenue));
    // Most urgent first; ties by severity, then the most recently seen.
    alerts.sort((a, b) => b.priority.score - a.priority.score || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.lastSeenAt.localeCompare(a.lastSeenAt));
    const n = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((s, c) => s + c._count._all, 0);
    const active = (c: (typeof counts)[number]) => c.status === 'OPEN' || c.status === 'ACKNOWLEDGED';
    const o = await this.org(orgId);
    return {
      currency: o.currency,
      staleAfterMinutes: STALE_AFTER_MINUTES,
      lastScan: last ? this.serializeScan(last, who) : null,
      summary: {
        open: n((c) => c.status === 'OPEN'),
        acknowledged: n((c) => c.status === 'ACKNOWLEDGED'),
        dismissed: n((c) => c.status === 'DISMISSED'),
        cleared: n((c) => c.status === 'CLEARED'),
        critical: n((c) => active(c) && c.severity === 'CRITICAL'),
        warning: n((c) => active(c) && c.severity === 'WARNING'),
        info: n((c) => active(c) && c.severity === 'INFO'),
      },
      monthlyRevenue: revenue,
      bands: {
        urgent: alerts.filter((a) => a.priority.band === 'URGENT').length,
        high: alerts.filter((a) => a.priority.band === 'HIGH').length,
        normal: alerts.filter((a) => a.priority.band === 'NORMAL').length,
        low: alerts.filter((a) => a.priority.band === 'LOW').length,
      },
      alerts,
    };
  }

  async get(orgId: string, id: string) {
    const a = await this.prisma.alert.findFirst({ where: { id, orgId } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Alert not found' });
    const events = await this.prisma.alertEvent.findMany({ where: { orgId, alertId: id }, orderBy: { createdAt: 'asc' } });
    const who = await this.names([a.statusById, ...events.map((e) => e.actorId)]);
    const def = ALERT_RULES.find((r) => r.key === a.rule);
    return {
      ...this.serialize(a, who, await this.monthlyRevenue(orgId)),
      ruleDescription: def?.description ?? null,
      history: events.map((e) => ({ id: e.id, action: e.action, by: e.actorId ? (who.get(e.actorId) ?? null) : null, automatic: !e.actorId, note: e.note, at: e.createdAt.toISOString() })),
    };
  }

  // ------------------------------------------------------------------ acting on an alert

  private async act(orgId: string, actor: Actor, id: string, from: AlertStatus[], to: AlertStatus, action: 'ACKNOWLEDGED' | 'DISMISSED' | 'REOPENED', note: string | null) {
    await this.prisma.$transaction((tx) => this.actInTx(tx, orgId, actor, id, from, to, action, note));
    return this.get(orgId, id);
  }

  /** Changes an alert's state inside the caller's transaction. Returns its title. */
  private async actInTx(tx: Prisma.TransactionClient, orgId: string, actor: Actor, id: string, from: AlertStatus[], to: AlertStatus, action: 'ACKNOWLEDGED' | 'DISMISSED' | 'REOPENED', note: string | null) {
    {
      const a = await tx.alert.findFirst({ where: { id, orgId } });
      if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Alert not found' });
      if (!from.includes(a.status)) {
        const msg: Record<string, string> = {
          ACKNOWLEDGED: 'Only an open alert can be acknowledged',
          DISMISSED: 'Only an open or acknowledged alert can be dismissed',
          REOPENED: 'Only a dismissed alert can be reopened',
        };
        throw new DomainError('INVALID_ALERT_STATE', `${msg[action]}; this one is ${a.status.toLowerCase()}`, HttpStatus.CONFLICT);
      }
      const now = new Date();
      await tx.alert.update({
        where: { id },
        data: to === 'OPEN' ? { status: 'OPEN', statusNote: null, statusById: null, statusAt: now, reopenCount: { increment: 1 } } : { status: to, statusNote: note, statusById: actor.id, statusAt: now },
      });
      await tx.alertEvent.create({ data: { orgId, alertId: id, action, actorId: actor.id, note } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: `alert.${action.toLowerCase()}`, entityType: 'alert', entityId: id, data: { rule: a.rule, title: a.title, from: a.status, note } });
      if (to === 'DISMISSED') await this.closeTasksInTx(tx, orgId, [id], 'CANCELLED', `The alert was dismissed${note ? `: ${note}` : '.'}`, actor.id);
      if (to === 'OPEN') {
        const ns = await tx.alertNotificationSetting.findUnique({ where: { orgId } });
        await this.notifyInTx(tx, orgId, a, { minSeverity: (ns?.minSeverity ?? 'CRITICAL') as 'CRITICAL' | 'WARNING' | 'OFF', taskRole: ns?.taskRole ?? 'OWNER', dueDays: ns?.dueDays ?? 0 });
      }
      return a.title;
    }
  }

  /** Acknowledge or dismiss inside the caller's transaction (used by confirmed assistant actions). */
  acknowledgeInTx(tx: Prisma.TransactionClient, orgId: string, actor: Actor, id: string, note: string | null) {
    return this.actInTx(tx, orgId, actor, id, ['OPEN'], 'ACKNOWLEDGED', 'ACKNOWLEDGED', note);
  }
  dismissInTx(tx: Prisma.TransactionClient, orgId: string, actor: Actor, id: string, reason: string) {
    return this.actInTx(tx, orgId, actor, id, ['OPEN', 'ACKNOWLEDGED'], 'DISMISSED', 'DISMISSED', reason);
  }

  acknowledge(orgId: string, actor: Actor, id: string, note: string | null) {
    return this.act(orgId, actor, id, ['OPEN'], 'ACKNOWLEDGED', 'ACKNOWLEDGED', note);
  }
  dismiss(orgId: string, actor: Actor, id: string, reason: string) {
    return this.act(orgId, actor, id, ['OPEN', 'ACKNOWLEDGED'], 'DISMISSED', 'DISMISSED', reason);
  }
  reopen(orgId: string, actor: Actor, id: string, note: string | null) {
    return this.act(orgId, actor, id, ['DISMISSED'], 'OPEN', 'REOPENED', note);
  }
}
