import { HttpStatus, Injectable } from '@nestjs/common';
import { buildPayrollReport, payrollReportCsv, type PayrollReportSlip } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

const MAX_MONTHS = 24;
const monthsBetween = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1; // not money

/**
 * Payroll reports (RPT-010): posted pay runs for a range of months, from their payslips, built with
 * buildPayrollReport. payroll.read; exporting is kept in the audit trail. No bank details, and
 * nothing here changes the books.
 */
@Injectable()
export class PayrollReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** From the first month of the financial year to this month unless given; at most two years. */
  private period(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const y = Number(to.slice(0, 4)); // not money
    const startYear = Number(to.slice(5, 7)) >= org.fiscalYearStartMonth ? y : y - 1; // not money
    const from = q.from ?? `${startYear}-${String(org.fiscalYearStartMonth).padStart(2, '0')}`;
    if (from > to) throw new DomainError('VALIDATION_FAILED', 'The period ends before it starts', HttpStatus.UNPROCESSABLE_ENTITY);
    if (monthsBetween(from, to) > MAX_MONTHS) throw new DomainError('VALIDATION_FAILED', 'Choose up to 24 months', HttpStatus.UNPROCESSABLE_ENTITY);
    return { from, to };
  }

  async report(org: OrgContext, q: { from?: string; to?: string }) {
    const { from, to } = this.period(org, q);
    const runs = await this.prisma.payRun.findMany({ where: { orgId: org.id, period: { gte: from, lte: to } }, select: { id: true, number: true, period: true, status: true } });
    const posted = runs.filter((r) => r.status === 'POSTED');
    const byRun = new Map(posted.map((r) => [r.id, r.period]));
    const slips = posted.length ? await this.prisma.payslip.findMany({ where: { orgId: org.id, payRunId: { in: posted.map((r) => r.id) } }, include: { employee: { select: { id: true, code: true, name: true } } } }) : [];
    const input: PayrollReportSlip[] = slips.map((s) => ({
      period: byRun.get(s.payRunId)!,
      employee: { id: s.employee.id, code: s.employee.code, name: s.employee.name },
      gross: s.gross.toString(),
      pfEmployee: s.pfEmployee.toString(),
      eps: s.eps.toString(),
      epfEmployer: s.epfEmployer.toString(),
      edli: s.edli.toString(),
      pfAdmin: s.pfAdmin.toString(),
      esiEmployee: s.esiEmployee.toString(),
      esiEmployer: s.esiEmployer.toString(),
      pt: s.pt.toString(),
      tds: s.tds.toString(),
      deductions: s.deductions.toString(),
      net: s.net.toString(),
      employerCost: s.employerCost.toString(),
    }));
    const notPosted = runs.filter((r) => r.status === 'DRAFT').sort((a, b) => a.period.localeCompare(b.period)).map((r) => ({ id: r.id, number: r.number, period: r.period }));
    return { from, to, currency: org.functionalCurrency, runs: posted.length, draftRuns: notPosted, ...buildPayrollReport(input, org.functionalCurrency) };
  }

  async exportCsv(org: OrgContext, user: AuthUser, q: { from?: string; to?: string }) {
    const r = await this.report(org, q);
    const csv = payrollReportCsv(r, { from: r.from, to: r.to, currency: r.currency });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'payroll_report.exported', entityType: 'report', entityId: `payroll:${r.from}:${r.to}`, data: { from: r.from, to: r.to, payslips: r.totals.payslips, gross: r.totals.gross } }));
    return { fileName: `payroll-report-${r.from}-to-${r.to}.csv`, csv };
  }
}
