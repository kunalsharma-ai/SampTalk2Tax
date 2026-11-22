import { HttpStatus, Injectable } from '@nestjs/common';
import { addDays, auditReportCsv, buildAuditReport, type AuditReportEvent, type AuditReportJournal } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { businessDate, fromDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';

const MAX_DAYS = 731;
/** Events read for one report; a longer period is cut short and says so. */
const MAX_EVENTS = 20000;

/**
 * Audit reports (RPT-021): the audit trail and the posted journals of a period, built with
 * buildAuditReport, with the hash chain verified. audit.read; exporting is kept in the audit trail.
 */
@Injectable()
export class AuditReportService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private period(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso();
    const y = Number(to.slice(0, 4)); // not money
    const startYear = Number(to.slice(5, 7)) >= org.fiscalYearStartMonth ? y : y - 1; // not money
    const from = q.from ?? `${startYear}-${String(org.fiscalYearStartMonth).padStart(2, '0')}-01`;
    if (from > to) throw new DomainError('VALIDATION_FAILED', 'The period ends before it starts', HttpStatus.UNPROCESSABLE_ENTITY);
    if (addDays(from, MAX_DAYS) <= to) throw new DomainError('VALIDATION_FAILED', 'Choose a period of up to two years', HttpStatus.UNPROCESSABLE_ENTITY);
    return { from, to };
  }

  async report(org: OrgContext, q: { from?: string; to?: string }) {
    const { from, to } = this.period(org, q);
    // A day either side in UTC, then each moment's business date (the organisation's time zone) decides.
    const start = new Date(`${addDays(from, -1)}T00:00:00.000Z`);
    const end = new Date(`${addDays(to, 2)}T00:00:00.000Z`);
    const inPeriod = (at: Date) => {
      const day = businessDate(at);
      return day >= from && day <= to;
    };
    const [rows, posted, chain] = await Promise.all([
      this.prisma.auditEvent.findMany({ where: { orgId: org.id, createdAt: { gte: start, lt: end } }, orderBy: { id: 'asc' }, take: MAX_EVENTS + 1, select: { id: true, actorId: true, action: true, entityType: true, entityId: true, createdAt: true } }).then((x) => x.filter((r) => inPeriod(r.createdAt))),
      this.store.collection(journalEntries).find({ status: 'POSTED', postedAt: { $gte: start, $lt: end } }, { sort: { entryNumber: 1 } }).then((x) => x.filter((j) => inPeriod(j.postedAt ?? j.createdAt))),
      this.audit.verify(org.id),
    ]);
    const truncated = rows.length > MAX_EVENTS;
    const kept = rows.slice(0, MAX_EVENTS);
    const ids = [...new Set(kept.map((r) => r.actorId).filter((x): x is string => !!x))];
    const names = new Map((ids.length ? await this.store.collection(users).find({ id: { $in: ids } }) : []).map((u) => [u.id, u.name]));
    const events: AuditReportEvent[] = kept.map((r) => ({ id: r.id.toString(), at: r.createdAt.toISOString(), action: r.action, entityType: r.entityType, entityId: r.entityId ?? '', actor: r.actorId ? { id: r.actorId, name: names.get(r.actorId) ?? 'Unknown person' } : null }));
    const journals: AuditReportJournal[] = posted.map((j) => ({
      id: j.id,
      number: `JE-${String(j.entryNumber ?? 0).padStart(6, '0')}`,
      date: fromDbDate(j.date),
      postedAt: (j.postedAt ?? j.createdAt).toISOString(),
      postedOn: businessDate(j.postedAt ?? j.createdAt),
      source: j.source,
      memo: j.memo,
      total: j.totalDebit.toString(),
      createdById: j.createdById,
      postedById: j.postedById,
      reverses: !!j.reversesEntryId,
    }));
    return { from, to, currency: org.functionalCurrency, truncated, chain, ...buildAuditReport(events, journals, org.functionalCurrency) };
  }

  async exportCsv(org: OrgContext, user: AuthUser, q: { from?: string; to?: string }) {
    const r = await this.report(org, q);
    const csv = auditReportCsv(r, { from: r.from, to: r.to, chainValid: r.chain.valid, checked: r.chain.checked });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'audit_report.exported', entityType: 'report', entityId: `audit:${r.from}:${r.to}`, data: { from: r.from, to: r.to, events: r.activity.events, sensitive: r.sensitive.total, exceptions: r.journals.exceptions.length } }));
    return { fileName: `audit-report-${r.from}-to-${r.to}.csv`, csv };
  }
}
