import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { formatDate, zipStore, type CloseCheck, type ExportReport, type ExportRow } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { renderExportFile, ReportExportService, type ExportableReport } from '../report-exports/report-exports.service';

const d = (iso: string) => formatDate(iso, 'DMY');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'month';
const FIGURES: [string, string][] = [
  ['revenue', 'Revenue for the month'],
  ['expenses', 'Expenses for the month'],
  ['netProfit', 'Net profit for the month'],
  ['assets', 'Assets at month end'],
  ['liabilities', 'Liabilities at month end'],
  ['trialBalanceDebit', 'Trial balance debits'],
  ['trialBalanceCredit', 'Trial balance credits'],
];

/**
 * The month-end report pack (WFLOW-021): once a month is closed, one ZIP with the certification
 * (checks, accepted warnings, note and certified figures) and the month's reports as PDFs, each
 * made by the same code as its screen and export. A README lists every file with its SHA-256,
 * and the pack is recorded in the audit trail with those checksums.
 */
@Injectable()
export class ClosePackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exports: ReportExportService,
    private readonly audit: AuditService,
  ) {}

  async pack(org: OrgContext, actor: AuthUser, periodId: string, now = new Date()) {
    const period = await this.prisma.fiscalPeriod.findFirst({ where: { id: periodId, orgId: org.id }, select: { id: true, name: true, startDate: true, endDate: true } });
    if (!period) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Period not found' });
    const close = await this.prisma.periodClose.findUnique({ where: { periodId } });
    const cert = close?.status === 'CLOSED' ? await this.prisma.closeCertification.findFirst({ where: { orgId: org.id, closeId: close.id, reopenedAt: null }, orderBy: { certifiedAt: 'desc' } }) : null;
    if (!close || !cert) throw new DomainError('CLOSE_NOT_CLOSED', `${period.name} is not closed yet. The pack shows the figures as certified, so close the month first.`, HttpStatus.CONFLICT);
    const from = fromDbDate(period.startDate);
    const to = fromDbDate(period.endDate);
    const reports: [ExportableReport, Record<string, string>][] = [
      ['trial-balance', { asOf: to }],
      ['income-statement', { from, to }],
      ['balance-sheet', { asOf: to }],
      ...(hasPermission(org.role, 'sales.read') ? ([['receivables-ageing', { asOf: to }]] as [ExportableReport, Record<string, string>][]) : []),
      ...(hasPermission(org.role, 'purchases.read') ? ([['payables-ageing', { asOf: to }]] as [ExportableReport, Record<string, string>][]) : []),
    ];
    const certifier = await this.prisma.user.findUnique({ where: { id: cert.certifiedById }, select: { name: true } });
    const files: { name: string; data: Uint8Array; sha256: string }[] = [];
    const add = (name: string, data: Uint8Array) => files.push({ name, data, sha256: createHash('sha256').update(data).digest('hex') });

    const certification = await this.certification(org, period.name, from, to, cert, certifier?.name ?? 'Former member', now);
    add(`01-close-certification-${to}.pdf`, (await renderExportFile(certification, 'pdf')).body);
    let n = 2;
    for (const [report, params] of reports) {
      const model = await this.exports.model(org, report, params, now);
      add(`${String(n++).padStart(2, '0')}-${report}-${to}.pdf`, (await renderExportFile(model, 'pdf')).body);
    }
    const readme = [
      `${certification.orgName}: month-end report pack for ${period.name} (${d(from)} to ${d(to)})`,
      `Closed and certified by ${certifier?.name ?? 'a former member'} on ${cert.certifiedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      `Generated ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC from Talk2Tax. Posted journal entries only; amounts in ${org.functionalCurrency}.`,
      '',
      'Files and their SHA-256 checksums:',
      ...files.map((f) => `${f.sha256}  ${f.name}`),
      '',
    ].join('\n');
    add('README.txt', new TextEncoder().encode(readme));
    const body = Buffer.from(zipStore(files.map((f) => ({ name: f.name, data: f.data })), now));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const fileName = `close-pack-${slug(period.name)}.zip`;
    await this.prisma.$transaction(async (tx) => {
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'close.report_pack_exported', entityType: 'period_close', entityId: close.id, data: { period: period.name, certificationId: cert.id, fileName, sha256, files: files.map((f) => ({ name: f.name, sha256: f.sha256 })) } });
    });
    return { fileName, contentType: 'application/zip', body, sha256, files: files.map((f) => f.name) };
  }

  /** The certification as a report: each check with its result, then the certified figures. */
  private async certification(org: OrgContext, name: string, from: string, to: string, cert: { certifiedAt: Date; note: string | null; checks: unknown; totals: unknown }, by: string, now: Date): Promise<ExportReport> {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true } });
    const checks = (cert.checks as CloseCheck[]) ?? [];
    const totals = (cert.totals as Record<string, string | number>) ?? {};
    const rows: ExportRow[] = [
      { cells: ['Checks', null, null], style: 'section' },
      ...checks.map((c): ExportRow => ({ cells: [c.label, c.ok ? 'Passed' : c.severity === 'BLOCKING' ? 'Failed' : 'Accepted warning', c.detail] })),
      { cells: ['Certified figures', null, null], style: 'section' },
      ...FIGURES.filter(([k]) => totals[k] !== undefined).map(([k, label]): ExportRow => ({ cells: [label, String(totals[k]), null], types: [null, 'money', null] })),
      ...(totals.journalsPosted !== undefined ? [{ cells: ['Journal entries posted in the month', String(totals.journalsPosted), null], types: [null, 'number', null] } as ExportRow] : []),
    ];
    return {
      orgName: o.name,
      generatedAt: now.toISOString(),
      title: `Month-end close certification: ${name}`,
      period: `${d(from)} to ${d(to)}`,
      currency: org.functionalCurrency,
      columns: [
        { label: 'Item', type: 'text', width: 40 },
        { label: 'Result', type: 'text', width: 18 },
        { label: 'Detail', type: 'text', width: 60 },
      ],
      rows,
      notes: [`Certified by ${by} on ${cert.certifiedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`, ...(cert.note ? [`Note: ${cert.note}`] : []), 'The figures are as they stood when the month was closed; the reports in this pack are worked out from the books as they are now.'],
      fileName: `close-certification-${to}`,
      landscape: true,
    };
  }
}
