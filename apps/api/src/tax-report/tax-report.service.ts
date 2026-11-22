import { HttpStatus, Injectable } from '@nestjs/common';
import { addDays, buildTaxReport, D, taxReportCsv, type TaxAccountMovement, type TaxReportDocument } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { lineSums, postedBetween } from '../db/ledger-queries';

const TAX_SUBTYPES = ['TAX_PAYABLE', 'TAX_RECEIVABLE', 'TAX_EXPENSE'];
const MAX_DAYS = 731;

/**
 * Tax reports (RPT-009): the tax in a period from posted invoices, credit notes, bills and vendor
 * credits (by rate, by month, withholding by section) and the tax accounts in the ledger, built
 * with buildTaxReport. reports.read; exporting is kept in the audit trail. Read-only.
 */
@Injectable()
export class TaxReportService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** From the start of the financial year to today unless given; at most two years. */
  private period(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso();
    const y = Number(to.slice(0, 4)); // not money
    const mo = Number(to.slice(5, 7)); // not money
    const startYear = mo >= org.fiscalYearStartMonth ? y : y - 1; // not money
    const from = q.from ?? `${startYear}-${String(org.fiscalYearStartMonth).padStart(2, '0')}-01`;
    if (from > to) throw new DomainError('VALIDATION_FAILED', 'The period ends before it starts', HttpStatus.UNPROCESSABLE_ENTITY);
    if (addDays(from, MAX_DAYS) <= to) throw new DomainError('VALIDATION_FAILED', 'Choose a period of up to two years', HttpStatus.UNPROCESSABLE_ENTITY);
    return { from, to };
  }

  async report(org: OrgContext, q: { from?: string; to?: string }) {
    const { from, to } = this.period(org, q);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, status: 'POSTED', issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: {
        kind: true,
        issueDate: true,
        exchangeRate: true,
        reverseChargeTax: true,
        withholdingKind: true,
        withholdingSectionId: true,
        withholdingBase: true,
        withholdingAmount: true,
        lines: { select: { taxRate: true, netAmount: true, taxAmount: true, cgstAmount: true, sgstAmount: true, igstAmount: true } },
      },
    });
    const sectionIds = [...new Set(docs.map((d) => d.withholdingSectionId).filter((x): x is string => !!x))];
    const sections = new Map(
      (sectionIds.length ? await this.prisma.withholdingSection.findMany({ where: { orgId: org.id, id: { in: sectionIds } }, select: { id: true, code: true } }) : []).map((s) => [s.id, s.code]),
    );
    const input: TaxReportDocument[] = docs.map((d) => ({
      kind: d.kind,
      issueDate: fromDbDate(d.issueDate),
      exchangeRate: d.exchangeRate.toString(),
      reverseChargeTax: d.reverseChargeTax.toString(),
      withholding: d.withholdingKind ? { kind: d.withholdingKind, section: (d.withholdingSectionId && sections.get(d.withholdingSectionId)) || 'No section', base: d.withholdingBase.toString(), amount: d.withholdingAmount.toString() } : null,
      lines: d.lines.map((l) => ({ taxRate: l.taxRate.toString(), netAmount: l.netAmount.toString(), taxAmount: l.taxAmount.toString(), cgstAmount: l.cgstAmount.toString(), sgstAmount: l.sgstAmount.toString(), igstAmount: l.igstAmount.toString() })),
    }));

    const taxAccounts = (await this.store.collection(accounts).find({ subtype: { $in: TAX_SUBTYPES } }, { sort: { code: 1 } })) as { id: string; code: string; name: string; subtype: string; isActive?: boolean }[];
    const ids = taxAccounts.map((a) => a.id);
    const sums = async (entry: Record<string, unknown>) =>
      new Map((ids.length ? await lineSums(this.store, org.id, { entry, line: { accountId: { $in: ids } }, by: { accountId: 'lines.accountId' } }) : []).map((s) => [s.key.accountId as string, s]));
    const [before, during] = await Promise.all([sums(postedBetween(null, toDbDate(addDays(from, -1)))), sums(postedBetween(toDbDate(from), toDbDate(to)))]);
    const movements: TaxAccountMovement[] = taxAccounts
      .map((a) => {
        const b = before.get(a.id);
        const p = during.get(a.id);
        return { code: a.code, name: a.name, subtype: a.subtype, opening: (b ? b.debit.minus(b.credit) : new D(0)).toFixed(), debit: (p?.debit ?? new D(0)).toFixed(), credit: (p?.credit ?? new D(0)).toFixed(), active: a.isActive !== false };
      })
      .filter((a) => a.active || !new D(a.opening).isZero() || !new D(a.debit).isZero() || !new D(a.credit).isZero())
      .map(({ active: _active, ...a }) => a);

    return { from, to, currency: org.functionalCurrency, ...buildTaxReport(input, movements, org.functionalCurrency) };
  }

  async exportCsv(org: OrgContext, user: AuthUser, q: { from?: string; to?: string }) {
    const r = await this.report(org, q);
    const csv = taxReportCsv(r, { from: r.from, to: r.to, currency: r.currency });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'tax_report.exported', entityType: 'report', entityId: `tax:${r.from}:${r.to}`, data: { from: r.from, to: r.to, documents: r.documents, net: r.totals.net } }));
    return { fileName: `tax-report-${r.from}-to-${r.to}.csv`, csv };
  }
}
