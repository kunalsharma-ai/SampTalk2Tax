import { Injectable } from '@nestjs/common';
import { deadlinePredictions, DeadlineSignal, PastObligation, UpcomingObligation } from '@talk2tax/tax-engine';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { GstReconciliationService } from '../gst/gst-reconciliation.service';
import { CalendarItem, ComplianceService } from './compliance.service';

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const GST_RETURNS = new Set(['GSTR1', 'GSTR3B', 'GST_PMT06']);
const PAYROLL = new Set(['PF', 'ESI', 'PT']);

/**
 * Compliance deadline predictions (TAX-047): which returns and payments due soon are likely to be
 * late, from the last year of the same obligations (when each was filed or paid) and from what the
 * books say now. Read-only; the rules are in packages/tax-engine (deadline-predictions.ts).
 */
@Injectable()
export class CompliancePredictionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compliance: ComplianceService,
    private readonly gstRecon: GstReconciliationService,
  ) {}

  async predict(org: OrgContext, daysAhead = 60, today = todayIso()) {
    const ahead = await this.compliance.calendar(org.id, today, addDays(today, daysAhead));
    const history = await this.compliance.calendar(org.id, addDays(today, -365), addDays(today, -1));
    const past = await this.doneDates([...history.overdueBefore, ...history.items].filter((i) => i.dueDate < today && i.status !== 'NOTHING_DUE'));

    const open = [...ahead.overdueBefore, ...ahead.items].filter((i) => i.status !== 'DONE' && i.status !== 'NOTHING_DUE');
    const gstChecks = new Map<string, DeadlineSignal[]>();
    const upcoming: UpcomingObligation[] = [];
    for (const i of open) {
      const periodOver = i.periodTo < today;
      const signals: DeadlineSignal[] = [];
      if (periodOver && GST_RETURNS.has(i.kind) && /^\d{4}-\d{2}$/.test(i.period)) {
        if (!gstChecks.has(i.period)) gstChecks.set(i.period, await this.gstSignals(org, i.period, i.periodLabel));
        signals.push(...gstChecks.get(i.period)!);
      }
      if (periodOver && PAYROLL.has(i.kind) && /No pay run/.test(i.detail)) signals.push({ severity: 'BLOCK', message: `No pay run posted for ${i.periodLabel} yet` });
      upcoming.push({ key: i.key, kind: i.kind, name: i.name, period: i.period, periodLabel: i.periodLabel, dueDate: i.dueDate, periodOver, signals });
    }
    const items = deadlinePredictions(upcoming, past, today);
    const count = (r: string) => items.filter((x) => x.risk === r).length;
    return { today, to: addDays(today, daysAhead), days: daysAhead, configured: ahead.configured, history: past.length, summary: { high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW') }, items };
  }

  /** What the books say about a month's GST before its returns: differences and mistakes. */
  private async gstSignals(org: OrgContext, month: string, label: string): Promise<DeadlineSignal[]> {
    const r = await this.gstRecon.month(org, month).catch(() => null);
    if (!r) return [];
    const out: DeadlineSignal[] = [];
    if (r.discrepancyCounts.high) out.push({ severity: 'BLOCK', message: `${r.discrepancyCounts.high} high-severity tax mistake${r.discrepancyCounts.high === 1 ? '' : 's'} in ${label}'s documents to fix first` });
    if (!r.agrees) out.push({ severity: 'WARN', message: `The GST accounts and ${label}'s documents differ (${r.items.length} item${r.items.length === 1 ? '' : 's'} to explain)` });
    return out;
  }

  /** When each past obligation was done: the filing date, the deposit date or the payroll payment date. */
  private async doneDates(items: CalendarItem[]): Promise<PastObligation[]> {
    const depositIds = items.flatMap((i) => i.evidence.filter((e) => e.type === 'WITHHOLDING_DEPOSIT').map((e) => e.id));
    const runIds = items.flatMap((i) => i.evidence.filter((e) => e.type === 'PAYROLL_PAYMENT').map((e) => e.id));
    const deposits = depositIds.length ? await this.prisma.withholdingDeposit.findMany({ where: { id: { in: depositIds } }, select: { id: true, depositDate: true } }) : [];
    const remittances = runIds.length ? await this.prisma.payrollRemittance.findMany({ where: { payRunId: { in: runIds }, status: 'POSTED' }, select: { payRunId: true, liability: true, date: true } }) : [];
    const depositDate = new Map(deposits.map((d) => [d.id, fromDbDate(d.depositDate)]));
    const out: PastObligation[] = [];
    for (const i of items) {
      let doneOn: string | null = null;
      if (i.filing) doneOn = i.filing.filedOn;
      else if (i.status === 'DONE') {
        const dates = [
          ...i.evidence.filter((e) => e.type === 'WITHHOLDING_DEPOSIT').map((e) => depositDate.get(e.id)),
          ...i.evidence
            .filter((e) => e.type === 'PAYROLL_PAYMENT')
            .flatMap((e) => remittances.filter((r) => r.payRunId === e.id && r.liability === (i.kind === 'TDS_DEPOSIT' ? 'TDS' : i.kind)).map((r) => fromDbDate(r.date))),
        ].filter((x): x is string => !!x);
        if (!dates.length) continue; // done, but nothing says when
        doneOn = dates.sort()[dates.length - 1]!;
      }
      out.push({ kind: i.kind, dueDate: i.dueDate, doneOn });
    }
    return out;
  }
}
