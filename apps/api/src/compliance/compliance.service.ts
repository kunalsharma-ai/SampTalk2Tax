import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, Dec } from '@talk2tax/accounting-engine';
import { ComplianceFiling, GstReturnFrequency } from '@talk2tax/database';
import { ComplianceProfile, complianceObligations, Obligation, OBLIGATION_RULES, ObligationKind, ObligationStatus, openStatus } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** How far back the calendar looks for obligations still open. */
const OVERDUE_LOOKBACK_MONTHS = 24;
const MAX_WINDOW_DAYS = 400;

export interface CalendarItem extends Obligation {
  status: ObligationStatus;
  /** Days until the due date (negative when overdue). */
  daysLeft: number;
  /** For payments: what the books say is due and what has been paid. */
  amount: string | null;
  paid: string | null;
  /** amount − paid. */
  outstanding: string | null;
  /** Why the status is what it is, in words. */
  detail: string;
  /** Records that settle or explain it. */
  evidence: { type: 'WITHHOLDING_DEPOSIT' | 'PAY_RUN' | 'PAYROLL_PAYMENT'; id: string; label: string }[];
  filing: { id: string; filedOn: string; reference: string; note: string | null; createdAt: string } | null;
  source: string;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const monthsBack = (iso: string, n: number) => {
  const d = new Date(Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};
const money = (d: Dec) => d.toFixed(2);

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ settings

  async getSettings(orgId: string) {
    const [s, profile] = await Promise.all([this.prisma.complianceSettings.findUnique({ where: { orgId } }), this.profile(orgId)]);
    return {
      gstReturnFrequency: s?.gstReturnFrequency ?? 'MONTHLY',
      advanceTaxFrom: s?.advanceTaxFrom ? fromDbDate(s.advanceTaxFrom) : null,
      areas: {
        gst: profile.gst ? { stateCode: profile.gst.stateCode, from: profile.gst.from } : null,
        withholding: profile.withholding ?? null,
        payroll: profile.payroll ?? null,
      },
    };
  }

  async saveSettings(orgId: string, actor: { id: string }, input: { gstReturnFrequency: GstReturnFrequency; advanceTaxFrom: string | null }) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
    if (org.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'The compliance calendar covers Indian GST, TDS/TCS, payroll and advance tax');
    if (input.advanceTaxFrom && input.advanceTaxFrom > addDays(todayIso(), 366)) throw new DomainError('INVALID_DATE', 'Advance tax tracking can start at most a year ahead');
    const data = { gstReturnFrequency: input.gstReturnFrequency, advanceTaxFrom: input.advanceTaxFrom ? toDbDate(input.advanceTaxFrom) : null };
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.complianceSettings.findUnique({ where: { orgId } });
      if (before) await tx.complianceSettings.update({ where: { orgId }, data });
      else await tx.complianceSettings.create({ data: { orgId, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'compliance.settings_saved', entityType: 'compliance_settings', entityId: orgId, data: input });
    });
    return this.getSettings(orgId);
  }

  // ------------------------------------------------------------------ calendar

  /** Obligations due between `from` and `to`, plus anything still open from before `from`. */
  async calendar(orgId: string, from: string, to: string) {
    if (from > to) throw new DomainError('INVALID_RANGE', 'from must not be after to');
    if (daysBetween(from, to) > MAX_WINDOW_DAYS) throw new DomainError('INVALID_RANGE', `Ask for at most ${MAX_WINDOW_DAYS} days at a time`);
    const today = todayIso();
    const profile = await this.profile(orgId);
    const window = complianceObligations(profile, from, to);
    const lookFrom = monthsBack(today, OVERDUE_LOOKBACK_MONTHS);
    const earlier = from > lookFrom ? complianceObligations(profile, lookFrom, addDays(from, -1)) : [];
    const items = await this.withStatus(orgId, [...earlier, ...window], today);
    const overdueBefore = items.slice(0, earlier.length).filter((i) => i.status === 'OVERDUE');
    const inWindow = items.slice(earlier.length);
    const all = [...overdueBefore, ...inWindow];
    const count = (s: ObligationStatus) => all.filter((i) => i.status === s).length;
    return {
      today,
      from,
      to,
      configured: !!(profile.gst || profile.withholding || profile.payroll || profile.advanceTax),
      areas: { gst: !!profile.gst, withholding: !!profile.withholding, payroll: !!profile.payroll, advanceTax: !!profile.advanceTax },
      gstReturnFrequency: profile.gst?.frequency ?? null,
      summary: { overdue: count('OVERDUE'), dueSoon: count('DUE_SOON'), upcoming: count('UPCOMING'), done: count('DONE'), nothingDue: count('NOTHING_DUE') },
      overdueBefore,
      items: inWindow,
    };
  }

  // ------------------------------------------------------------------ filings

  async markFiled(orgId: string, actor: { id: string }, input: { key: string; filedOn: string; reference: string; note?: string | null }) {
    const today = todayIso();
    if (input.filedOn > today) throw new DomainError('INVALID_DATE', 'The filing date cannot be in the future');
    const [kind] = input.key.split(':') as [ObligationKind];
    const rule = OBLIGATION_RULES[kind];
    if (!rule) throw new DomainError('UNKNOWN_OBLIGATION', `${input.key} is not an obligation in the calendar`);
    if (rule.nature !== 'RETURN') throw new DomainError('SETTLED_BY_RECORDS', `${rule.name} is settled by recording the payment in the books, not by marking it filed`);
    // The obligation must be one this organisation has: find it in the calendar around today.
    const profile = await this.profile(orgId);
    const ob = complianceObligations(profile, monthsBack(today, OVERDUE_LOOKBACK_MONTHS + 12), addDays(today, 400)).find((o) => o.key === input.key);
    if (!ob) throw new DomainError('UNKNOWN_OBLIGATION', `${input.key} is not an obligation for this organisation's set-up`);
    if (input.filedOn < ob.periodFrom) throw new DomainError('INVALID_DATE', `A return for ${ob.periodLabel} cannot be filed before the period starts`);
    const existing = await this.prisma.complianceFiling.findFirst({ where: { orgId, obligationKey: ob.key, status: 'FILED' } });
    if (existing) throw new DomainError('ALREADY_FILED', `${ob.name} for ${ob.periodLabel} is already marked filed (${existing.reference}); void that first`, HttpStatus.CONFLICT);
    const f = await this.prisma.$transaction(async (tx) => {
      const row = await tx.complianceFiling.create({
        data: { orgId, obligationKey: ob.key, kind: ob.kind, period: ob.period, dueDate: toDbDate(ob.dueDate), filedOn: toDbDate(input.filedOn), reference: input.reference.trim(), note: input.note?.trim() || null, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'compliance.filed', entityType: 'compliance_filing', entityId: row.id, data: { key: ob.key, filedOn: input.filedOn, reference: row.reference, late: input.filedOn > ob.dueDate } });
      return row;
    });
    return this.serializeFiling(f);
  }

  async voidFiling(orgId: string, actor: { id: string }, id: string, input: { reason: string }) {
    const f = await this.prisma.complianceFiling.findFirst({ where: { id, orgId } });
    if (!f) throw new NotFoundException('Filing not found');
    if (f.status === 'VOID') throw new DomainError('ALREADY_VOID', 'This filing record is already void', HttpStatus.CONFLICT);
    const row = await this.prisma.$transaction(async (tx) => {
      const r = await tx.complianceFiling.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidedById: actor.id, voidReason: input.reason.trim() } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'compliance.filing_voided', entityType: 'compliance_filing', entityId: id, data: { key: f.obligationKey, reason: input.reason } });
      return r;
    });
    return { ...this.serializeFiling(row), status: row.status, voidReason: row.voidReason };
  }

  async listFilings(orgId: string) {
    const rows = await this.prisma.complianceFiling.findMany({ where: { orgId }, orderBy: [{ createdAt: 'desc' }], take: 500 });
    return rows.map((r) => ({ ...this.serializeFiling(r), key: r.obligationKey, kind: r.kind, period: r.period, dueDate: fromDbDate(r.dueDate), status: r.status, voidReason: r.voidReason }));
  }

  // ------------------------------------------------------------------ internals

  /** What applies to the organisation, and from when, from its GST, TDS/TCS, payroll and compliance settings. */
  private async profile(orgId: string): Promise<ComplianceProfile> {
    const [org, gst, settings, wh, firstWhDoc, pay, firstRun, ptStates] = await Promise.all([
      this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } }),
      this.prisma.gstRegistration.findUnique({ where: { orgId } }),
      this.prisma.complianceSettings.findUnique({ where: { orgId } }),
      this.prisma.withholdingSettings.findUnique({ where: { orgId } }),
      this.prisma.document.findFirst({ where: { orgId, withholdingKind: { not: null }, status: { in: ['POSTED', 'VOID'] } }, orderBy: { issueDate: 'asc' }, select: { issueDate: true } }),
      this.prisma.payrollSettings.findUnique({ where: { orgId } }),
      this.prisma.payRun.findFirst({ where: { orgId, status: { not: 'VOID' } }, orderBy: { period: 'asc' }, select: { period: true } }),
      this.prisma.employee.findMany({ where: { orgId, workStateCode: { not: null } }, distinct: ['workStateCode'], select: { workStateCode: true } }),
    ]);
    if (org.countryCode !== 'IN') return {};
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const min = (...xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0];
    return {
      gst: gst ? { stateCode: gst.stateCode, from: fromDbDate(gst.effectiveFrom), frequency: settings?.gstReturnFrequency ?? 'MONTHLY' } : null,
      withholding: wh ? { from: min(day(wh.createdAt), firstWhDoc ? fromDbDate(firstWhDoc.issueDate) : null)! } : null,
      payroll: pay ? { from: min(day(pay.createdAt), firstRun ? `${firstRun.period}-01` : null)!, ptStates: ptStates.map((e) => e.workStateCode!) } : null,
      advanceTax: settings?.advanceTaxFrom ? { from: fromDbDate(settings.advanceTaxFrom) } : null,
    };
  }

  private async withStatus(orgId: string, obligations: Obligation[], today: string): Promise<CalendarItem[]> {
    if (!obligations.length) return [];
    const keys = obligations.map((o) => o.key);
    const months = [...new Set(obligations.filter((o) => /^\d{4}-\d{2}$/.test(o.period)).map((o) => o.period))];
    const span = { from: obligations.reduce((m, o) => (o.periodFrom < m ? o.periodFrom : m), '9999-12-31'), to: obligations.reduce((m, o) => (o.periodTo > m ? o.periodTo : m), '0000-01-01') };
    const [filings, whDocs, runs] = await Promise.all([
      this.prisma.complianceFiling.findMany({ where: { orgId, obligationKey: { in: keys }, status: 'FILED' } }),
      this.prisma.document.findMany({
        where: { orgId, status: 'POSTED', withholdingKind: { not: null }, withholdingAmount: { gt: 0 }, issueDate: { gte: toDbDate(span.from), lte: toDbDate(span.to) } },
        select: { withholdingKind: true, issueDate: true, withholdingAmount: true, depositItems: { where: { active: true }, select: { deposit: { select: { id: true, number: true, challanReference: true } } } } },
      }),
      months.length
        ? this.prisma.payRun.findMany({
            where: { orgId, status: 'POSTED', period: { in: months } },
            select: { id: true, number: true, period: true, payslips: { select: { pfEmployee: true, eps: true, epfEmployer: true, edli: true, pfAdmin: true, esiEmployee: true, esiEmployer: true, pt: true, tds: true } }, remittances: { where: { status: 'POSTED' }, select: { id: true, number: true, liability: true, reference: true, amount: true } } },
          })
        : Promise.resolve([]),
    ]);
    const filingByKey = new Map(filings.map((f) => [f.obligationKey, f]));
    const runByMonth = new Map(runs.map((r) => [r.period, r]));

    return obligations.map((o) => {
      const rule = OBLIGATION_RULES[o.kind];
      const base = { ...o, daysLeft: daysBetween(today, o.dueDate), source: rule.source, amount: null as string | null, paid: null as string | null, outstanding: null as string | null, evidence: [] as CalendarItem['evidence'], filing: null as CalendarItem['filing'] };
      const periodOver = o.periodTo < today;
      if (rule.nature === 'RETURN') {
        const f = filingByKey.get(o.key);
        if (f) return { ...base, status: 'DONE' as const, detail: fromDbDate(f.filedOn) > o.dueDate ? 'Marked filed after the due date' : 'Marked filed', filing: this.serializeFiling(f) };
        return { ...base, status: openStatus(o.dueDate, today), detail: periodOver ? 'Not marked filed yet' : 'The period has not ended yet' };
      }
      // Payments: what the books say was due for the period, and what has been paid against it.
      let due = new D(0);
      let pending = new D(0);
      const evidence: CalendarItem['evidence'] = [];
      let noRun = false;
      if (o.kind === 'TDS_DEPOSIT' || o.kind === 'TCS_DEPOSIT') {
        const kind = o.kind === 'TDS_DEPOSIT' ? 'TDS' : 'TCS';
        for (const d of whDocs.filter((x) => x.withholdingKind === kind && fromDbDate(x.issueDate).slice(0, 7) === o.period)) {
          const amt = new D(d.withholdingAmount.toFixed());
          due = due.plus(amt);
          const dep = d.depositItems[0]?.deposit;
          if (dep) {
            if (!evidence.some((e) => e.id === dep.id)) evidence.push({ type: 'WITHHOLDING_DEPOSIT', id: dep.id, label: `${dep.number} · ${dep.challanReference}` });
          } else pending = pending.plus(amt);
        }
      }
      if (o.kind === 'TDS_DEPOSIT' || o.kind === 'PF' || o.kind === 'ESI' || o.kind === 'PT') {
        const run = runByMonth.get(o.period);
        const liability = o.kind === 'TDS_DEPOSIT' ? 'TDS' : o.kind;
        if (run) {
          const slips = run.payslips;
          const sum = (f: (p: (typeof slips)[number]) => Dec) => slips.reduce((s, p) => s.plus(f(p)), new D(0));
          const n = (x: { toFixed(): string }) => new D(x.toFixed());
          const amt =
            liability === 'PF' ? sum((p) => n(p.pfEmployee).plus(n(p.eps)).plus(n(p.epfEmployer)).plus(n(p.edli)).plus(n(p.pfAdmin)))
            : liability === 'ESI' ? sum((p) => n(p.esiEmployee).plus(n(p.esiEmployer)))
            : liability === 'PT' ? sum((p) => n(p.pt))
            : sum((p) => n(p.tds));
          if (amt.gt(0)) {
            due = due.plus(amt);
            evidence.push({ type: 'PAY_RUN', id: run.id, label: run.number });
            const paid = run.remittances.find((r) => r.liability === liability);
            if (paid) evidence.push({ type: 'PAYROLL_PAYMENT', id: run.id, label: `${paid.number} · ${paid.reference}` });
            else pending = pending.plus(amt);
          }
        } else if (o.kind !== 'TDS_DEPOSIT') noRun = true;
      }
      const amount = money(due);
      const paid = money(due.minus(pending));
      const outstanding = money(pending);
      if (noRun) return { ...base, evidence, status: periodOver ? openStatus(o.dueDate, today) : ('UPCOMING' as const), detail: periodOver ? 'No pay run posted for this month' : 'The month has not ended yet' };
      if (due.isZero()) return { ...base, amount, paid, outstanding, evidence, status: periodOver ? ('NOTHING_DUE' as const) : ('UPCOMING' as const), detail: periodOver ? 'Nothing was deducted or collected in this period' : 'Nothing so far this month' };
      if (pending.isZero()) return { ...base, amount, paid, outstanding, evidence, status: 'DONE' as const, detail: 'Paid in full' };
      return { ...base, amount, paid, outstanding, evidence, status: openStatus(o.dueDate, today), detail: pending.eq(due) ? 'Not paid yet' : 'Partly paid' };
    });
  }

  private serializeFiling(f: ComplianceFiling) {
    return { id: f.id, filedOn: fromDbDate(f.filedOn), reference: f.reference, note: f.note, createdAt: f.createdAt.toISOString() };
  }
}
