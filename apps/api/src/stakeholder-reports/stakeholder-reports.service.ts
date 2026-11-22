import { HttpStatus, Injectable } from '@nestjs/common';
import { buildStakeholderReport, minorUnits, periodFor, reportMonthsNeeded, reportPeriod, type ReportPeriod, type StakeholderAudience, type StakeholderReport } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { type StakeholderNarrative, type StakeholderReportDoc, stakeholderReports } from '../db/collections/stakeholder-reports';
import { KpisService } from '../kpis/kpis.service';

const EMPTY: StakeholderNarrative = { highlights: '', challenges: '', outlook: '', asks: '' };
const AUDIENCE_LABEL = { EXECUTIVE: 'Executive report', INVESTOR: 'Investor report' } as const;

/**
 * Executive and investor reports (RPT-022, RPT-023) for a fiscal quarter or year: the figures from
 * the engine's buildStakeholderReport, computed from posted journals while a draft, frozen with the
 * narrative once final. Reading needs reports.read; writing and finalising budgets.manage, as for
 * management reports. Every change is kept in the audit trail.
 */
@Injectable()
export class StakeholderReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly kpis: KpisService,
  ) {}

  private period(org: OrgContext, key: string, today: string): ReportPeriod {
    const p = reportPeriod(key, org.fiscalYearStartMonth);
    if (!p) throw new DomainError('VALIDATION_FAILED', 'A period such as FY2027 or FY2027-Q2', HttpStatus.UNPROCESSABLE_ENTITY);
    if (p.from > today) throw new DomainError('PERIOD_NOT_STARTED', `${p.label} has not started yet`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (p.fiscalYear < 2001) throw new DomainError('VALIDATION_FAILED', 'Periods start from FY2001', HttpStatus.UNPROCESSABLE_ENTITY);
    return p;
  }

  private async compute(org: OrgContext, audience: StakeholderAudience, p: ReportPeriod, today: string): Promise<StakeholderReport & { inProgress: boolean }> {
    const start = org.fiscalYearStartMonth;
    const months = reportMonthsNeeded(p, start);
    const lastMonth = months[months.length - 1]!;
    const to = p.to < today ? p.to : today;
    const scale = minorUnits(org.functionalCurrency);
    const [figures, customers] = await Promise.all([this.kpis.monthFigures(org.id, lastMonth, to, months.length), this.kpis.customerRevenue(org.id, p.from, to, scale)]);
    const r = buildStakeholderReport({ audience, period: p, prior: reportPeriod(p.prior, start)!, lastYear: reportPeriod(p.lastYear, start)!, figures, customers, scale });
    return { ...r, inProgress: p.to >= today };
  }

  private async names(ids: (string | null)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((list.length ? await this.store.collection(users).find({ id: { $in: list } }) : []).map((u) => [u.id, u.name]));
  }

  /** Saved reports, newest period first, with the current and last periods to start from. */
  async list(org: OrgContext, today = todayIso()) {
    const rows = await this.store.collection(stakeholderReports).find({}, { sort: { period: -1, audience: 1 } });
    const who = await this.names(rows.flatMap((r) => [r.updatedById, r.finalisedById]));
    const start = org.fiscalYearStartMonth;
    const quarters = [periodFor(today, start, 'QUARTER')];
    while (quarters.length < 5) quarters.push(reportPeriod(quarters[quarters.length - 1]!, start)!.prior);
    const fy = +periodFor(today, start, 'YEAR').slice(2);
    const keys = [...quarters, `FY${fy}`, `FY${fy - 1}`, `FY${fy - 2}`];
    return {
      /** The current and last four quarters, then this year and the two before, newest first. */
      suggested: keys.map((k) => {
        const p = reportPeriod(k, start)!;
        return { key: k, label: p.label, ended: p.to < today };
      }),
      reports: rows.map((r) => ({
        id: r.id,
        audience: r.audience,
        period: r.period,
        label: reportPeriod(r.period, start)?.label ?? r.period,
        status: r.status,
        updatedBy: who.get(r.updatedById) ?? 'Former member',
        updatedAt: r.updatedAt.toISOString(),
        finalisedBy: r.finalisedById ? (who.get(r.finalisedById) ?? 'Former member') : null,
        finalisedAt: r.finalisedAt?.toISOString() ?? null,
      })),
    };
  }

  private find(audience: StakeholderAudience, period: string) {
    return this.store.collection(stakeholderReports).findOne({ audience, period });
  }

  /** A report: live figures while a draft (saved or not), the frozen copy once final. */
  async get(org: OrgContext, audience: StakeholderAudience, key: string, today = todayIso()) {
    const p = this.period(org, key, today);
    const row = await this.find(audience, key);
    const live = await this.compute(org, audience, p, today);
    const who = await this.names([row?.updatedById ?? null, row?.finalisedById ?? null]);
    const meta = {
      id: row?.id ?? null,
      title: `${AUDIENCE_LABEL[audience]}, ${p.label}`,
      currency: org.functionalCurrency,
      status: row?.status ?? 'DRAFT',
      saved: !!row,
      narrative: row?.narrative ?? EMPTY,
      updatedBy: row ? (who.get(row.updatedById) ?? 'Former member') : null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      finalisedBy: row?.finalisedById ? (who.get(row.finalisedById) ?? 'Former member') : null,
      finalisedAt: row?.finalisedAt?.toISOString() ?? null,
    };
    if (row?.status === 'FINAL' && row.snapshot) {
      const snap = row.snapshot as unknown as typeof live;
      // Figures posted after finalising: P&L lines whose amount for the period is now different.
      const changedSince = snap.lines.flatMap((l) => {
        const now = live.lines.find((x) => x.key === l.key)!.current;
        return now === l.current ? [] : [{ key: l.key, label: l.label, then: l.current, now }];
      });
      return { ...snap, ...meta, changedSince };
    }
    return { ...live, ...meta, changedSince: [] as { key: string; label: string; then: string; now: string }[] };
  }

  async saveNarrative(org: OrgContext, user: AuthUser, audience: StakeholderAudience, key: string, narrative: StakeholderNarrative, today = todayIso()) {
    this.period(org, key, today);
    const clean = { highlights: narrative.highlights.trim(), challenges: narrative.challenges.trim(), outlook: narrative.outlook.trim(), asks: narrative.asks.trim() };
    const col = this.store.collection(stakeholderReports);
    const row = await this.find(audience, key);
    if (row?.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This report is final and cannot be changed', HttpStatus.CONFLICT);
    const now = new Date();
    let id: string;
    if (row) {
      const r = await col.updateOne({ id: row.id, status: 'DRAFT' }, { $set: { narrative: clean, updatedById: user.id, updatedAt: now } });
      if (!r.matched) throw new DomainError('CHANGED', 'The report changed meanwhile; reload and try again', HttpStatus.CONFLICT);
      id = row.id;
    } else {
      id = (await this.insert(audience, key, clean, user, now)).id;
    }
    await this.log(org, user, 'stakeholder_report.narrative_saved', id, { audience, period: key, length: Object.values(clean).reduce((a, s) => a + s.length, 0) }); // not money
    return this.get(org, audience, key, today);
  }

  private async insert(audience: StakeholderAudience, period: string, narrative: StakeholderNarrative, user: AuthUser, now: Date): Promise<StakeholderReportDoc> {
    try {
      return await this.store.collection(stakeholderReports).insertOne({ audience, period, status: 'DRAFT', narrative, snapshot: null, createdById: user.id, createdAt: now, updatedById: user.id, updatedAt: now, finalisedById: null, finalisedAt: null });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('CHANGED', 'The report was saved meanwhile; reload and try again', HttpStatus.CONFLICT);
      throw e;
    }
  }

  /** Freeze the figures and narrative. Only once the period has ended. */
  async finalise(org: OrgContext, user: AuthUser, audience: StakeholderAudience, key: string, today = todayIso()) {
    const p = this.period(org, key, today);
    if (p.to >= today) throw new DomainError('PERIOD_NOT_ENDED', `${p.label} can be finalised once it has ended`, HttpStatus.CONFLICT);
    const existing = await this.find(audience, key);
    if (existing?.status === 'FINAL') throw new DomainError('REPORT_FINAL', 'This report is already final', HttpStatus.CONFLICT);
    const { inProgress: _ignored, ...snapshot } = await this.compute(org, audience, p, today);
    const now = new Date();
    const row = existing ?? (await this.insert(audience, key, EMPTY, user, now));
    const r = await this.store.collection(stakeholderReports).updateOne({ id: row.id, status: 'DRAFT' }, { $set: { status: 'FINAL', snapshot: { ...snapshot, inProgress: false }, finalisedById: user.id, finalisedAt: now, updatedById: user.id, updatedAt: now } });
    if (!r.matched) throw new DomainError('CHANGED', 'The report changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'stakeholder_report.finalised', row.id, { audience, period: key, revenue: snapshot.headline.revenue, netIncome: snapshot.headline.netIncome, cashClosing: snapshot.headline.cashClosing });
    return this.get(org, audience, key, today);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'stakeholder_report', entityId, data }));
  }
}
