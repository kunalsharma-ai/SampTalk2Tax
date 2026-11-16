import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { D, checkExportReport, exportAmount, minorUnits, exportFileName, formatDate, toCsv, toXlsx, type ExportColumn, type ExportFormat, type ExportReport, type ExportRow } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { isoDate } from '../common/zod';
import { DimensionsService } from '../dimensions/dimensions.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { PrismaService } from '../common/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { renderReportPdf } from './pdf';

export const EXPORTABLE_REPORTS = ['trial-balance', 'income-statement', 'balance-sheet', 'general-ledger', 'receivables-ageing', 'payables-ageing', 'profit-by-dimension'] as const;
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];

const bool = z.enum(['true', 'false']).optional().transform((v) => v === 'true');
/** Query parameters of each report, the same ones its screen and JSON endpoint take. */
const PARAMS = {
  'trial-balance': z.object({ from: isoDate.optional(), asOf: isoDate, includeZero: bool }).strict(),
  'income-statement': z.object({ from: isoDate, to: isoDate, departmentId: z.uuid().optional(), projectId: z.uuid().optional() }).strict(),
  'balance-sheet': z.object({ asOf: isoDate }).strict(),
  'general-ledger': z.object({ accountId: z.uuid(), from: isoDate, to: isoDate }).strict(),
  'receivables-ageing': z.object({ asOf: isoDate }).strict(),
  'payables-ageing': z.object({ asOf: isoDate }).strict(),
  'profit-by-dimension': z.object({ type: z.enum(['DEPARTMENT', 'PROJECT']), from: isoDate, to: isoDate, includeInactive: bool }).strict(),
} satisfies Record<ExportableReport, z.ZodType>;

const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export interface ExportedFile {
  fileName: string;
  contentType: string;
  body: Buffer;
  sha256: string;
}

/** Writes a report model as a file in one of the export formats. */
export async function renderExportFile(model: ExportReport, fmt: ExportFormat): Promise<ExportedFile> {
  checkExportReport(model);
  const body = fmt === 'csv' ? Buffer.from(toCsv(model), 'utf8') : fmt === 'xlsx' ? Buffer.from(toXlsx(model)) : await renderReportPdf(model);
  return { body, sha256: createHash('sha256').update(body).digest('hex'), fileName: exportFileName(model, fmt), contentType: CONTENT_TYPES[fmt] };
}

export function parseExportFormat(format: string | undefined): ExportFormat {
  const fmt = (format ?? '').toLowerCase();
  if (fmt !== 'csv' && fmt !== 'xlsx' && fmt !== 'pdf') throw new DomainError('INVALID_FORMAT', 'Choose a format: csv, xlsx or pdf', HttpStatus.BAD_REQUEST);
  return fmt;
}

const d = (iso: string) => formatDate(iso, 'DMY');
const text = (label: string, width?: number): ExportColumn => ({ label, type: 'text', width });
const money = (label: string, width = 14): ExportColumn => ({ label, type: 'money', width });

/**
 * Exports the financial reports as CSV, Excel or PDF. Each export runs the same service as the
 * report's screen, so the file shows exactly what the screen shows for the same parameters,
 * and every export is written to the audit log with a hash of the file.
 */
@Injectable()
export class ReportExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reports: ReportsService,
    private readonly subledger: SubledgerService,
    private readonly dimensions: DimensionsService,
  ) {}

  async export(org: OrgContext, actor: AuthUser, report: string, format: string | undefined, query: Record<string, unknown>, now = new Date()): Promise<ExportedFile> {
    if (!(EXPORTABLE_REPORTS as readonly string[]).includes(report)) {
      throw new DomainError('NOT_FOUND', `There is no report called ${report}. Reports that export: ${EXPORTABLE_REPORTS.join(', ')}`, HttpStatus.NOT_FOUND);
    }
    const r = report as ExportableReport;
    const fmt = parseExportFormat(format);
    if (r === 'receivables-ageing' && !hasPermission(org.role, 'sales.read')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) does not have sales.read`, HttpStatus.FORBIDDEN);
    if (r === 'payables-ageing' && !hasPermission(org.role, 'purchases.read')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) does not have purchases.read`, HttpStatus.FORBIDDEN);
    const parsed = PARAMS[r].safeParse(query);
    if (!parsed.success) {
      throw new DomainError('VALIDATION_FAILED', 'Check the report parameters', HttpStatus.BAD_REQUEST, { issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`) });
    }
    const params = parsed.data as Record<string, string | boolean | undefined>;
    const range = [params.from, params.to ?? params.asOf].filter(Boolean) as string[];
    if (range.length === 2 && range[0]! > range[1]!) throw new DomainError('INVALID_RANGE', 'The start must be on or before the end date', HttpStatus.BAD_REQUEST);

    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { name: true } });
    const model = await this.build(org, r, params, { orgName: o.name, generatedAt: now.toISOString() });
    const { body, sha256, fileName } = await renderExportFile(model, fmt);
    await this.prisma.$transaction(async (tx) => {
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'report.exported', entityType: 'report', entityId: null, data: { report: r, format: fmt, params, fileName, bytes: body.length, sha256, rows: model.rows.length } });
    });
    return { fileName, contentType: CONTENT_TYPES[fmt], body, sha256 };
  }

  private async build(org: OrgContext, r: ExportableReport, p: Record<string, string | boolean | undefined>, base: { orgName: string; generatedAt: string }): Promise<ExportReport> {
    const s = (k: string) => p[k] as string;
    switch (r) {
      case 'trial-balance': {
        const tb = await this.reports.trialBalance(org.id, { from: p.from as string | undefined, asOf: s('asOf'), includeZero: !!p.includeZero });
        return {
          ...base,
          title: 'Trial balance',
          period: p.from ? `${d(s('from'))} to ${d(s('asOf'))}` : `As of ${d(s('asOf'))}`,
          currency: tb.currency,
          columns: [text('Code', 9), text('Account', 34), text('Type', 11), money('Debit'), money('Credit'), money('Net debit'), money('Net credit')],
          rows: [
            ...tb.rows.map((x): ExportRow => ({ cells: [x.code, x.name, label(x.type), x.debit, x.credit, x.netDebit, x.netCredit] })),
            { cells: ['', 'Total', null, tb.totals.debit, tb.totals.credit, tb.totals.netDebit, tb.totals.netCredit], style: 'total' },
          ],
          notes: [tb.balanced ? 'Debits equal credits.' : `Out of balance by ${exportAmount(new D(tb.totals.netDebit).minus(tb.totals.netCredit).abs().toFixed(), tb.currency)}.`, 'Posted journal entries only.'],
          fileName: `trial-balance-${s('asOf')}`,
          landscape: true,
        };
      }
      case 'income-statement': {
        const is = await this.reports.incomeStatement(org.id, { from: s('from'), to: s('to'), departmentId: p.departmentId as string | undefined, projectId: p.projectId as string | undefined });
        const filters: string[] = [];
        for (const id of [p.departmentId, p.projectId].filter(Boolean) as string[]) {
          const v = await this.prisma.dimensionValue.findFirst({ where: { id, orgId: org.id } });
          if (!v) throw new DomainError('NOT_FOUND', 'That department or project was not found', HttpStatus.NOT_FOUND);
          filters.push(`${v.type === 'DEPARTMENT' ? 'Department' : 'Project'} ${v.code} ${v.name}`);
        }
        const lines = (xs: { code: string; name: string; amount: string }[]) => xs.map((x): ExportRow => ({ cells: [x.code, x.name, x.amount] }));
        return {
          ...base,
          title: 'Profit and loss',
          period: `${d(s('from'))} to ${d(s('to'))}`,
          currency: is.currency,
          columns: [text('Code', 10), text('Account', 44), money('Amount', 16)],
          rows: [
            { cells: ['', 'Revenue', null], style: 'section' },
            ...lines(is.revenue),
            { cells: ['', 'Total revenue', is.totalRevenue], style: 'subtotal' },
            { cells: ['', 'Expenses', null], style: 'section' },
            ...lines(is.expenses),
            { cells: ['', 'Total expenses', is.totalExpenses], style: 'subtotal' },
            { cells: ['', new D(is.netIncome).isNeg() ? 'Net loss' : 'Net profit', is.netIncome], style: 'total' },
          ],
          notes: [filters.length ? `Only lines tagged ${filters.join(' and ')}.` : 'All departments and projects.', 'Posted journal entries only.'],
          fileName: `profit-and-loss-${s('from')}-to-${s('to')}`,
        };
      }
      case 'balance-sheet': {
        const bs = await this.reports.balanceSheet(org.id, { asOf: s('asOf') });
        const lines = (xs: { code: string; name: string; amount: string }[]) => xs.map((x): ExportRow => ({ cells: [x.code, x.name, x.amount] }));
        return {
          ...base,
          title: 'Balance sheet',
          period: `As of ${d(s('asOf'))}`,
          currency: bs.currency,
          columns: [text('Code', 10), text('Account', 44), money('Amount', 16)],
          rows: [
            { cells: ['', 'Assets', null], style: 'section' },
            ...lines(bs.assets),
            { cells: ['', 'Total assets', bs.totalAssets], style: 'total' },
            { cells: ['', 'Liabilities', null], style: 'section' },
            ...lines(bs.liabilities),
            { cells: ['', 'Total liabilities', bs.totalLiabilities], style: 'subtotal' },
            { cells: ['', 'Equity', null], style: 'section' },
            ...lines(bs.equity),
            { cells: ['', 'Earnings not yet closed to retained earnings', bs.unclosedEarnings] },
            { cells: ['', 'Total equity', bs.totalEquity], style: 'subtotal' },
            { cells: ['', 'Total liabilities and equity', new D(bs.totalLiabilities).plus(bs.totalEquity).toFixed(minorUnits(bs.currency))], style: 'total' },
          ],
          notes: [bs.balanced ? 'Assets equal liabilities plus equity.' : 'Assets do not equal liabilities plus equity.', 'Posted journal entries only.'],
          fileName: `balance-sheet-${s('asOf')}`,
        };
      }
      case 'general-ledger': {
        const gl = await this.reports.accountLedger(org.id, { accountId: s('accountId'), from: s('from'), to: s('to') });
        return {
          ...base,
          title: `General ledger: ${gl.account.code} ${gl.account.name}`,
          period: `${d(s('from'))} to ${d(s('to'))}`,
          currency: gl.currency,
          columns: [{ label: 'Date', type: 'date', width: 11 }, text('Entry', 10), text('Description', 40), money('Debit'), money('Credit'), money('Balance')],
          rows: [
            { cells: [s('from'), null, 'Opening balance', null, null, gl.openingBalance], style: 'section' },
            ...gl.rows.map((x): ExportRow => ({ cells: [x.date, `JE-${String(x.entryNumber).padStart(6, '0')}`, x.description || x.memo || '', new D(x.debit).isZero() ? null : x.debit, new D(x.credit).isZero() ? null : x.credit, x.runningBalance] })),
            { cells: [s('to'), null, 'Closing balance', sumOf(gl.rows.map((x) => x.debit), gl.currency), sumOf(gl.rows.map((x) => x.credit), gl.currency), gl.closingBalance], style: 'total' },
          ],
          notes: [`${gl.rows.length} posted line${gl.rows.length === 1 ? '' : 's'}. Balance is shown in the account's normal direction (${gl.account.type === 'ASSET' || gl.account.type === 'EXPENSE' ? 'debit' : 'credit'}).`],
          fileName: `general-ledger-${gl.account.code}-${s('from')}-to-${s('to')}`,
          landscape: true,
        };
      }
      case 'receivables-ageing':
      case 'payables-ageing': {
        const ledger = r === 'receivables-ageing' ? 'SALES' : 'PURCHASES';
        const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
        const a = await this.subledger.ageing({ ...o }, ledger, s('asOf'));
        const t = a.totals as Record<string, string>;
        const cols = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90', 'unapplied', 'balance'];
        const rec = a.reconciliation;
        return {
          ...base,
          title: ledger === 'SALES' ? 'Receivables ageing' : 'Payables ageing',
          period: `As of ${d(s('asOf'))}`,
          currency: a.currency,
          columns: [text(ledger === 'SALES' ? 'Customer' : 'Supplier', 30), money('Not yet due'), money('1-30 days'), money('31-60 days'), money('61-90 days'), money('Over 90 days'), money('Less unapplied'), money('Balance')],
          rows: [
            ...a.rows.map((x): ExportRow => ({ cells: [x.contactName, ...cols.map((c) => (x as unknown as Record<string, string>)[c]!)] })),
            { cells: ['Total', ...cols.map((c) => t[c]!)], style: 'total' },
          ],
          notes: [
            'Days past the due date. Unapplied credits and payments are taken off the balance.',
            rec.controlAccountBalance === null
              ? 'No control account is set, so the ledger is not reconciled to the general ledger.'
              : new D(rec.difference ?? '0').isZero()
                ? `Agrees with the control account balance of ${exportAmount(rec.controlAccountBalance, a.currency)}.`
                : `Differs from the control account balance of ${exportAmount(rec.controlAccountBalance, a.currency)} by ${exportAmount(rec.difference ?? '0', a.currency)}.`,
          ],
          fileName: `${r}-${s('asOf')}`,
          landscape: true,
        };
      }
      case 'profit-by-dimension': {
        const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
        const type = s('type') as 'DEPARTMENT' | 'PROJECT';
        const pr = await this.dimensions.profit({ id: org.id, role: org.role, functionalCurrency: o.functionalCurrency }, { type, from: s('from'), to: s('to'), includeInactive: !!p.includeInactive });
        const n = pr.columns.length;
        const blank = () => Array<string | null>(n + 1).fill(null);
        const rows: ExportRow[] = [];
        let revenue = new D(0);
        for (const sec of pr.sections) {
          if (sec.type === 'REVENUE') revenue = new D(sec.total);
          rows.push({ cells: ['', sec.type === 'REVENUE' ? 'Revenue' : 'Expenses', ...blank()], style: 'section' });
          for (const x of sec.rows) rows.push({ cells: [x.code, x.name, ...x.amounts, x.total] });
          rows.push({ cells: ['', sec.type === 'REVENUE' ? 'Total revenue' : 'Total expenses', ...sec.totals, sec.total], style: 'subtotal' });
        }
        rows.push({ cells: ['', 'Net profit', ...pr.netProfit, pr.netProfitTotal], style: 'total' });
        const totalMargin = revenue.gt(0) ? new D(pr.netProfitTotal).div(revenue).times(100).toFixed(1) : null;
        rows.push({ cells: ['', 'Margin', ...pr.margin, totalMargin], types: [null, null, ...Array<'percent'>(n + 1).fill('percent')] });
        const many = n > 6;
        return {
          ...base,
          title: `Profit by ${type === 'DEPARTMENT' ? 'department' : 'project'}`,
          period: `${d(s('from'))} to ${d(s('to'))}`,
          currency: pr.currency,
          columns: [
            text('Code', 8),
            text('Account', many ? 20 : 28),
            ...pr.columns.map((c) => money(c.code ? c.code : c.name, many ? 11 : 13)),
            money('Total', many ? 11 : 13),
          ],
          rows,
          notes: [
            ...pr.columns.filter((c) => c.code).map((c) => `${c.code}: ${c.name}`),
            pr.columns.some((c) => !c.code) ? `"${pr.columns.find((c) => !c.code)!.name}" holds lines with no ${type === 'DEPARTMENT' ? 'department' : 'project'}.` : '',
            'Margin is net profit as a percentage of revenue.',
          ].filter(Boolean),
          fileName: `profit-by-${type === 'DEPARTMENT' ? 'department' : 'project'}-${s('from')}-to-${s('to')}`,
          landscape: true,
        };
      }
    }
  }
}

function label(type: string): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

function sumOf(xs: string[], currency: string): string {
  return xs.reduce((a, x) => a.plus(x), new D(0)).toFixed(minorUnits(currency));
}
