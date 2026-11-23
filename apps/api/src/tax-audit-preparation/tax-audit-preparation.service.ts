import { HttpStatus, Injectable } from '@nestjs/common';
import { addDays, D } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { AUDIT_PREP_CHECK_KEYS, type AuditPrepCheck, type AuditPrepCheckKey, auditPrepBlockers, auditPrepCsv, auditPreparation, auditPrepSummary, taxYearOf } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ComplianceService } from '../compliance/compliance.service';
import { ComplianceDocumentsService } from '../compliance-documents/compliance-documents.service';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { type TaxAuditPreparationDoc, taxAuditPreparations } from '../db/collections/tax-audit-preparations';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { IncomeTaxService } from '../income-tax/income-tax.service';
import { TaxAuditService } from '../tax-audit/tax-audit.service';
import { YearEndService } from '../year-end/year-end.service';

/** How far past the year end returns for the year fall due (annual GST and Q4 TDS returns included). */
const DUE_AFTER_YEAR_DAYS = 300; // not money

type Snapshot = { checks: AuditPrepCheck[]; summary: ReturnType<typeof auditPrepSummary> };

/**
 * Tax audit preparation (TAX-051): readiness checks for one financial year before the books go to
 * the tax auditor, worked out from the books, the compliance calendar, the tax audit working papers
 * and the income tax computation; the preparer's notes to the auditor on each check; marking the
 * year ready (only when nothing is missing and everything needing attention is explained) and
 * reopening it with a reason; and the checklist as CSV. Indian organisations only. reports.read to
 * read and export; accounts.manage to write notes, mark ready and reopen. Every change is audited.
 */
@Injectable()
export class TaxAuditPreparationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly compliance: ComplianceService,
    private readonly complianceDocs: ComplianceDocumentsService,
    private readonly taxAudit: TaxAuditService,
    private readonly incomeTax: IncomeTaxService,
    private readonly yearEnd: YearEndService,
  ) {}

  private async year(org: OrgContext, year: string | undefined, today: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'Tax audit preparation follows the Indian Income-tax Act (Form 3CD)', HttpStatus.UNPROCESSABLE_ENTITY);
    const current = taxYearOf(today);
    const ty = year ? taxYearOf(`${year.slice(0, 4)}-04-01`) : taxYearOf(`${Number(current.from.slice(0, 4)) - 1}-04-01`);
    if (year && ty.label !== year) throw new DomainError('INVALID_TAX_YEAR', 'Give the financial year as 2025-26', HttpStatus.BAD_REQUEST);
    if (ty.from > today) throw new DomainError('FUTURE_YEAR', `The financial year ${ty.label} has not started`, HttpStatus.UNPROCESSABLE_ENTITY);
    return ty;
  }

  /** The checks as the books stand now. */
  private async checks(org: OrgContext, ty: { from: string; to: string; label: string }, today: string) {
    const orgId = org.id;
    const start = toDbDate(ty.from);
    const end = toDbDate(ty.to);
    const range = { gte: start, lte: end };
    const [periods, closes, draftJournals, draftDocuments, banks, withLines, reconciled, unmatched, calendarA, calendarB, taxAudit, computation, chart, toEnd, inYear] = await Promise.all([
      this.prisma.fiscalPeriod.findMany({ where: { orgId, startDate: { gte: start }, endDate: { lte: end } }, select: { fiscalYear: true, status: true } }),
      this.yearEnd.closes(org),
      this.prisma.journalEntry.count({ where: { orgId, status: 'DRAFT', date: range } }),
      this.prisma.document.count({ where: { orgId, status: 'DRAFT', issueDate: range } }),
      this.prisma.account.findMany({ where: { orgId, subtype: 'BANK' }, select: { id: true, code: true, name: true } }),
      this.prisma.bankStatementLine.groupBy({ by: ['accountId'], where: { orgId, date: { lte: end } }, _count: true }),
      this.prisma.bankReconciliation.groupBy({ by: ['accountId'], where: { orgId, status: 'COMPLETED' }, _max: { statementDate: true } }),
      this.prisma.bankStatementLine.count({ where: { orgId, status: 'UNMATCHED', date: range } }),
      this.compliance.calendar(orgId, ty.from, ty.to),
      this.compliance.calendar(orgId, addDays(ty.to, 1), addDays(ty.to, DUE_AFTER_YEAR_DAYS)),
      this.taxAudit.report(org, ty.label, today),
      this.incomeTax.get(org, ty.label, today),
      this.store.collection(accounts).find({}),
      lineSums(this.store, orgId, { entry: postedBetween(null, end), by: { accountId: 'lines.accountId' } }),
      lineSums(this.store, orgId, { entry: postedBetween(start, end, { excludeClosing: true }), by: { accountId: 'lines.accountId' } }),
    ]);

    const fiscalYears = new Set(periods.map((p) => p.fiscalYear));
    const has = new Set(withLines.map((w) => w.accountId));
    const last = new Map(reconciled.map((r) => [r.accountId, r._max.statementDate]));
    const bankRows = banks.filter((b) => has.has(b.id)).sort((a, b) => a.code.localeCompare(b.code));
    const unreconciled = bankRows.filter((b) => !last.get(b.id) || last.get(b.id)! < end).map((b) => ({ code: b.code, name: b.name, lastReconciled: last.get(b.id) ? fromDbDate(last.get(b.id)!) : null }));

    // Returns and payments for periods inside the year that have fallen due by today.
    const items = [...calendarA.items, ...calendarB.items].filter((i) => i.periodFrom >= ty.from && i.periodTo <= ty.to && i.dueDate < today && i.status !== 'NOTHING_DUE');
    const done = items.filter((i) => i.status === 'DONE');
    const missingProof = await this.complianceDocs.missingProof(done);

    const sub = new Map(chart.map((a) => [a.id, a.subtype]));
    const net = (rows: typeof toEnd, subtype: string) => rows.filter((r) => sub.get(r.key.accountId as string) === subtype).reduce((s, r) => s.plus(r.debit.minus(r.credit)), new D(0));

    const checks = auditPreparation({
      yearEnded: ty.to < today,
      periods: { total: periods.length, open: periods.filter((p) => p.status === 'OPEN').length },
      yearClosed: closes.some((c) => c.status === 'ACTIVE' && fiscalYears.has(c.fiscalYear)),
      drafts: { journals: draftJournals, documents: draftDocuments },
      bank: { accounts: bankRows.length, unreconciled, unmatchedLines: unmatched },
      returns: {
        configured: calendarA.configured,
        due: items.length,
        notFiled: items.filter((i) => i.status !== 'DONE').sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((i) => ({ name: i.name, periodLabel: i.periodLabel, dueDate: i.dueDate })),
        filedLate: done.filter((i) => i.filing && i.filing.filedOn > i.dueDate).length,
      },
      proof: { configured: calendarA.configured, missing: missingProof.map((m) => ({ name: m.name, periodLabel: m.periodLabel, needs: m.needsLabel })) },
      cashPayments: { days: taxAudit.cashPayments.days.length, amount: taxAudit.cashPayments.disallowed },
      cashReceipts: { days: taxAudit.cashReceipts.days.length, amount: taxAudit.cashReceipts.total },
      tds: taxAudit.tds.configured ? { configured: true, late: taxAudit.tds.late, interest: taxAudit.tds.interest } : { configured: false, late: 0, interest: '0' },
      fixedAssets: { cost: net(toEnd, 'FIXED_ASSET').toFixed(2), depreciation: net(inYear, 'DEPRECIATION').toFixed(2) },
      computation: { saved: computation.saved, final: computation.status === 'FINAL', changedSince: !!computation.changedSince },
    });
    return checks;
  }

  async get(org: OrgContext, year?: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    const [row, checks] = await Promise.all([this.store.collection(taxAuditPreparations).findOne({ taxYear: ty.label }), this.checks(org, ty, today)]);
    const ids = [...(row?.notes.map((n) => n.byId) ?? []), row?.readyById, row?.reopenedById].filter((x): x is string => !!x);
    const who = new Map((ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : []).map((u) => [u.id, u.name]));
    const name = (id: string | null | undefined) => (id ? (who.get(id) ?? 'Former member') : null);
    const notes = new Map((row?.notes ?? []).map((n) => [n.key, { text: n.note, by: name(n.byId), at: n.at.toISOString() }]));
    const explained = new Set(notes.keys());
    const yearEnded = ty.to < today;
    const snap = row?.status === 'READY' ? (row.snapshot as unknown as Snapshot) : null;
    const thenStatus = new Map(snap?.checks.map((c) => [c.key, c.status]) ?? []);
    return {
      taxYear: ty.label,
      from: ty.from,
      to: ty.to,
      asOf: today,
      yearEnded,
      status: row?.status ?? 'OPEN',
      checks: checks.map((c) => ({ ...c, note: notes.get(c.key) ?? null, statusWhenReady: snap ? (thenStatus.get(c.key) ?? null) : null })),
      summary: auditPrepSummary(checks),
      blockers: auditPrepBlockers(yearEnded, checks, explained),
      ready: row?.status === 'READY' ? { by: name(row.readyById), at: row.readyAt!.toISOString(), summary: snap!.summary, changedSince: checks.filter((c) => thenStatus.get(c.key) !== c.status).map((c) => c.title) } : null,
      reopened: row?.reopenedAt ? { by: name(row.reopenedById), at: row.reopenedAt.toISOString(), reason: row.reopenedReason } : null,
    };
  }

  private async row(org: OrgContext, user: AuthUser, taxYear: string): Promise<TaxAuditPreparationDoc> {
    const col = this.store.collection(taxAuditPreparations);
    const found = await col.findOne({ taxYear });
    if (found) return found;
    const now = new Date();
    try {
      return await col.insertOne({ taxYear, notes: [], status: 'OPEN', snapshot: null, readyById: null, readyAt: null, reopenedReason: null, reopenedById: null, reopenedAt: null, createdById: user.id, createdAt: now, updatedAt: now });
    } catch (e) {
      if (isDuplicateKeyError(e)) return (await col.findOne({ taxYear }))!;
      throw e;
    }
  }

  /** Write, replace or (with an empty note) remove the note to the auditor on one check. */
  async note(org: OrgContext, user: AuthUser, year: string, key: AuditPrepCheckKey, text: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    if (!(AUDIT_PREP_CHECK_KEYS as readonly string[]).includes(key)) throw new DomainError('UNKNOWN_CHECK', 'No such check', HttpStatus.BAD_REQUEST);
    const row = await this.row(org, user, ty.label);
    if (row.status === 'READY') throw new DomainError('PREPARATION_READY', `${ty.label} is marked ready for the auditor; reopen it to change the notes`, HttpStatus.CONFLICT);
    const note = text.trim();
    const notes = row.notes.filter((n) => n.key !== key);
    if (note) notes.push({ key, note, byId: user.id, at: new Date() });
    notes.sort((a, b) => AUDIT_PREP_CHECK_KEYS.indexOf(a.key as AuditPrepCheckKey) - AUDIT_PREP_CHECK_KEYS.indexOf(b.key as AuditPrepCheckKey));
    const r = await this.store.collection(taxAuditPreparations).updateOne({ id: row.id, status: 'OPEN' }, { $set: { notes, updatedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The preparation changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, note ? 'tax_audit_preparation.noted' : 'tax_audit_preparation.note_removed', row.id, { taxYear: ty.label, check: key, length: note.length });
    return this.get(org, ty.label, today);
  }

  /** Mark the year ready for the auditor: nothing missing, everything needing attention explained. */
  async markReady(org: OrgContext, user: AuthUser, year: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    const row = await this.row(org, user, ty.label);
    if (row.status === 'READY') throw new DomainError('PREPARATION_READY', `${ty.label} is already marked ready for the auditor`, HttpStatus.CONFLICT);
    const checks = await this.checks(org, ty, today);
    const blockers = auditPrepBlockers(ty.to < today, checks, new Set(row.notes.map((n) => n.key)));
    if (blockers.length) throw new DomainError('NOT_READY', `Not ready for the auditor yet: ${blockers.join(' ')}`, HttpStatus.CONFLICT);
    const summary = auditPrepSummary(checks);
    const snapshot: Snapshot = { checks, summary };
    const now = new Date();
    const r = await this.store.collection(taxAuditPreparations).updateOne({ id: row.id, status: 'OPEN' }, { $set: { status: 'READY', snapshot: snapshot as unknown as Record<string, unknown>, readyById: user.id, readyAt: now, updatedAt: now } });
    if (!r.matched) throw new DomainError('CHANGED', 'The preparation changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'tax_audit_preparation.ready', row.id, { taxYear: ty.label, ...summary, notes: row.notes.length });
    return this.get(org, ty.label, today);
  }

  async reopen(org: OrgContext, user: AuthUser, year: string, reason: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    const row = await this.store.collection(taxAuditPreparations).findOne({ taxYear: ty.label });
    if (row?.status !== 'READY') throw new DomainError('NOT_MARKED_READY', `${ty.label} is not marked ready for the auditor`, HttpStatus.CONFLICT);
    const now = new Date();
    const r = await this.store.collection(taxAuditPreparations).updateOne({ id: row.id, status: 'READY' }, { $set: { status: 'OPEN', snapshot: null, readyById: null, readyAt: null, reopenedReason: reason.trim(), reopenedById: user.id, reopenedAt: now, updatedAt: now } });
    if (!r.matched) throw new DomainError('CHANGED', 'The preparation changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'tax_audit_preparation.reopened', row.id, { taxYear: ty.label, reason: reason.trim() });
    return this.get(org, ty.label, today);
  }

  /** The checklist with notes as CSV; the export is kept in the audit trail. */
  async exportCsv(org: OrgContext, user: AuthUser, year?: string, today = todayIso()) {
    const r = await this.get(org, year, today);
    const csv = auditPrepCsv(r.taxYear, r.checks.map((c) => ({ ...c, note: c.note?.text ?? null })));
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'tax_audit_preparation.exported', entityType: 'report', entityId: `tax-audit-preparation:${r.taxYear}`, data: { taxYear: r.taxYear, ...r.summary } }));
    return { fileName: `tax-audit-preparation-${r.taxYear}.csv`, csv };
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'tax_audit_preparation', entityId, data }));
  }
}
