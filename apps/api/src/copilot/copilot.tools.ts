import { HttpException, Injectable, Logger } from '@nestjs/common';
import { D, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { hasPermission, Permission, RoleName } from '@talk2tax/security';
import { z } from 'zod';
import { AlertsService } from '../alerts/alerts.service';
import { BudgetsService } from '../budgets/budgets.service';
import { CfoService } from '../cfo/cfo.service';
import { CFO_QUESTIONS, type CfoQuestionKey } from '@talk2tax/accounting-engine';
import { CashFlowService } from '../cash-flow/cash-flow.service';
import { DomainError } from '../common/errors';
import { ComplianceService } from '../compliance/compliance.service';
import { KpisService } from '../kpis/kpis.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { ReportsService } from '../reports/reports.service';
import type { CopilotTool } from './copilot.model';

/**
 * Bumped whenever a tool's name, description or input changes. A conversation keeps the
 * tool set it was started with, so an older conversation is closed for new questions
 * rather than continued with tools the model never saw.
 */
export const TOOLSET_VERSION = 2;

/** Tool output longer than this is cut, so one call cannot fill the model's context. */
export const MAX_TOOL_OUTPUT_CHARS = 40_000;

export interface ToolContext {
  orgId: string;
  role: RoleName;
  /** Today in India time, YYYY-MM-DD. */
  today: string;
  fiscalYearStartMonth: number;
}

/** What the answer was based on: shown under the answer, with a link to the same figures in the app. */
export interface CopilotSource {
  tool: string;
  label: string;
  /** Path inside the organisation, such as /reports/income-statement. */
  path: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** JSON text given back to the model. */
  content: string;
  source: CopilotSource;
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Not a real date');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

// JSON Schema pieces. Strict tool use needs every property listed as required and
// additionalProperties: false; optional values are nullable instead.
const S = {
  date: (description: string) => ({ type: 'string', format: 'date', description }),
  nullableDate: (description: string) => ({ anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }], description }),
  // Months are plain strings (pattern is not relied on for strict tools); the server checks YYYY-MM.
  nullableMonth: (description: string) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description }),
  month: (description: string) => ({ type: 'string', description }),
};
function object(properties: Record<string, unknown>): CopilotTool['input_schema'] {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } as CopilotTool['input_schema'];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d = (iso: string) => `${+iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const m = (ym: string) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

/** Ids and other machine fields the model has no use for: dropped to keep tool output small. */
const DROP_KEYS = new Set(['accountId', 'contactId', 'periodId', 'controlAccountId', 'sourceBudgetId', 'createdBy', 'submittedBy', 'approvedBy', 'createdAt', 'updatedAt', 'submittedAt', 'approvedAt', 'supersededAt', 'returned', 'evidence', 'series', 'days', 'id', 'itemId', 'basis']);
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !DROP_KEYS.has(k)).map(([k, v]) => [k, compact(v)]));
  }
  return value;
}

interface ToolDef<I extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: CopilotTool['input_schema'];
  input: I;
  permission: Permission;
  label: (i: z.infer<I>, ctx: ToolContext) => string;
  path: (i: z.infer<I>, ctx: ToolContext) => string;
  run: (i: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}

@Injectable()
export class CopilotTools {
  private readonly defs: ToolDef<z.ZodTypeAny>[];
  private readonly log = new Logger('CopilotTools');

  constructor(
    private readonly reports: ReportsService,
    private readonly kpis: KpisService,
    private readonly cashFlow: CashFlowService,
    private readonly budgets: BudgetsService,
    private readonly alerts: AlertsService,
    private readonly compliance: ComplianceService,
    private readonly subledger: SubledgerService,
    private readonly orgs: OrganizationsService,
    private readonly cfo: CfoService,
  ) {
    const def = <I extends z.ZodTypeAny>(t: ToolDef<I>) => t as unknown as ToolDef<z.ZodTypeAny>;
    this.defs = [
      def({
        name: 'get_dashboard',
        description:
          'Headline position: cash, receivables and payables balances, revenue, expenses and net income for the fiscal year to date, and revenue, expenses, net income and closing cash for each month of the fiscal year. Call this first for broad questions such as "how are we doing" or "what is our cash".',
        inputSchema: object({ as_of: S.nullableDate('Date to report at, YYYY-MM-DD. null for today.') }),
        input: z.object({ as_of: date.nullable() }).strict(),
        permission: 'reports.read',
        label: (i, c) => `Dashboard at ${d(i.as_of ?? c.today)}`,
        path: () => '',
        run: async (i, c) => compact(await this.reports.dashboard(c.orgId, { asOf: i.as_of ?? c.today })),
      }),
      def({
        name: 'get_income_statement',
        description: 'Profit and loss for a date range: revenue and expenses by account, totals and net income. Call this for questions about revenue, costs, margins or profit over a period.',
        inputSchema: object({ from: S.date('First day, YYYY-MM-DD.'), to: S.date('Last day, YYYY-MM-DD.') }),
        input: z.object({ from: date, to: date }).strict(),
        permission: 'reports.read',
        label: (i) => `Profit and loss, ${d(i.from)} to ${d(i.to)}`,
        path: () => '/reports/income-statement',
        run: async (i, c) => {
          if (i.from > i.to) throw new DomainError('INVALID_RANGE', '"from" must not be after "to"');
          return compact(await this.reports.incomeStatement(c.orgId, { from: i.from, to: i.to }));
        },
      }),
      def({
        name: 'get_balance_sheet',
        description: 'Balance sheet at a date: assets, liabilities and equity by account, with totals and whether it balances.',
        inputSchema: object({ as_of: S.date('Date, YYYY-MM-DD.') }),
        input: z.object({ as_of: date }).strict(),
        permission: 'reports.read',
        label: (i) => `Balance sheet at ${d(i.as_of)}`,
        path: () => '/reports/balance-sheet',
        run: async (i, c) => compact(await this.reports.balanceSheet(c.orgId, { asOf: i.as_of })),
      }),
      def({
        name: 'get_trial_balance',
        description: 'Trial balance at a date: every account with its debit and credit totals and balance. Use it when a question is about one specific account or the balance of an account.',
        inputSchema: object({ as_of: S.date('Date, YYYY-MM-DD.') }),
        input: z.object({ as_of: date }).strict(),
        permission: 'reports.read',
        label: (i) => `Trial balance at ${d(i.as_of)}`,
        path: () => '/reports/trial-balance',
        run: async (i, c) => compact(await this.reports.trialBalance(c.orgId, { asOf: i.as_of })),
      }),
      def({
        name: 'get_ageing',
        description:
          'Receivables (what customers owe) or payables (what is owed to vendors) at a date, by customer or vendor, split into current, 1-30, 31-60, 61-90 and over 90 days overdue, with each open invoice or bill. Call this for questions about who owes money, overdue invoices or bills to pay.',
        inputSchema: object({ ledger: { type: 'string', enum: ['receivables', 'payables'], description: 'receivables for customers, payables for vendors.' }, as_of: S.nullableDate('Date, YYYY-MM-DD. null for today.') }),
        input: z.object({ ledger: z.enum(['receivables', 'payables']), as_of: date.nullable() }).strict(),
        permission: 'reports.read',
        label: (i, c) => `${i.ledger === 'receivables' ? 'Receivables' : 'Payables'} ageing at ${d(i.as_of ?? c.today)}`,
        path: (i) => (i.ledger === 'receivables' ? '/sales/ageing' : '/purchases/ageing'),
        run: async (i, c) => {
          if (!hasPermission(c.role, i.ledger === 'receivables' ? 'sales.read' : 'purchases.read')) throw new DomainError('FORBIDDEN', 'This member cannot see that ledger', 403);
          const o = await this.orgs.get(c.orgId);
          return compact(await this.subledger.ageing({ ...o }, i.ledger === 'receivables' ? 'SALES' : 'PURCHASES', i.as_of ?? c.today));
        },
      }),
      def({
        name: 'get_kpis',
        description:
          'Key performance indicators for one complete month (or the month in progress): revenue, gross and net margin, operating expenses, burn, runway, DSO, DPO, collection and others, each with its formula, components, the previous month, the same month last year and any target set. Also revenue by top customers for the 12 months to that month.',
        inputSchema: object({ month: S.nullableMonth('Month, YYYY-MM. null for the last complete month.') }),
        input: z.object({ month: month.nullable() }).strict(),
        permission: 'reports.read',
        label: (i) => (i.month ? `KPIs for ${m(i.month)}` : 'KPIs for the last complete month'),
        path: (i) => `/reports/kpis${i.month ? `?month=${i.month}` : ''}`,
        run: async (i, c) => compact(await this.kpis.kpis(c.orgId, { month: i.month ?? undefined })),
      }),
      def({
        name: 'get_management_report',
        description: "The monthly management report for a month: profit and loss lines against last month, last year and the approved budget, year to date, cash movement, KPIs, customer concentration, the finance team's commentary and whether the report is final.",
        inputSchema: object({ month: S.month('Month, YYYY-MM.') }),
        input: z.object({ month }).strict(),
        permission: 'reports.read',
        label: (i) => `Management report for ${m(i.month)}`,
        path: (i) => `/reports/management/${i.month}`,
        run: async (i, c) => compact(await this.kpis.report(c.orgId, i.month)),
      }),
      def({
        name: 'get_cash_forecast',
        description:
          'Cash-flow forecast from today: opening cash, expected receipts from open invoices (adjusted for how late customers pay), payments of open bills, planned items, the closing balance in base, low and high cases, the lowest point, whether it falls below the minimum balance, and weekly totals. Call this for questions about future cash, runway in days, or whether cash will be enough.',
        inputSchema: object({ horizon_days: { type: 'integer', enum: [30, 60, 90, 180], description: 'How far ahead to forecast, in days.' } }),
        input: z.object({ horizon_days: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180)]) }).strict(),
        permission: 'reports.read',
        label: (i) => `Cash-flow forecast, next ${i.horizon_days} days`,
        path: () => '/planning/cash-flow',
        run: async (i, c) => {
          const f = await this.cashFlow.forecast(c.orgId, { horizonDays: i.horizon_days });
          type Row = { amount?: string; open?: string };
          const size = (r: Row) => new D(r.amount ?? r.open ?? '0').abs();
          const top = (rows: Row[]) => [...rows].sort((a, b) => size(b).comparedTo(size(a))).slice(0, 10);
          const { receivables, payables, planned, ...rest } = f as unknown as { receivables: Row[]; payables: Row[]; planned: Row[] } & Record<string, unknown>;
          return compact({ ...rest, largestReceipts: top(receivables), largestPayments: top(payables), planned: top(planned), counts: { receivables: receivables.length, payables: payables.length, planned: planned.length } });
        },
      }),
      def({
        name: 'get_budget_variance',
        description: 'Budget against actual for a fiscal year, using its approved budget: revenue, expenses and net income, and each account, by month, quarter or the whole year, with the variance and whether it is favourable. Fiscal years are named by the calendar year they end in (FY2027 runs April 2026 to March 2027 for an April year start).',
        inputSchema: object({
          fiscal_year: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Fiscal year, such as 2027. null for the current one.' },
          granularity: { type: 'string', enum: ['MONTH', 'QUARTER', 'YEAR'], description: 'How to split the year.' },
        }),
        input: z.object({ fiscal_year: z.number().int().min(2000).max(2100).nullable(), granularity: z.enum(['MONTH', 'QUARTER', 'YEAR']) }).strict(),
        permission: 'reports.read',
        label: (i, c) => `Budget vs actual, FY${i.fiscal_year ?? fiscalYearForDate(c.today, c.fiscalYearStartMonth)}`,
        path: (i) => `/planning/budget-vs-actual?by=${i.granularity}${i.fiscal_year ? `&fy=${i.fiscal_year}` : ''}`,
        run: async (i, c) => {
          const o = await this.budgets.overview(c.orgId, i.fiscal_year ?? undefined);
          const approved = o.budgets.find((b) => b.status === 'APPROVED');
          if (!approved) return { fiscalYear: o.fiscalYear, approvedBudget: null, message: `FY${o.fiscalYear} has no approved budget`, versions: o.budgets.map((b) => ({ version: b.version, name: b.name, status: b.status })) };
          return compact(await this.budgets.variance(c.orgId, approved.id, { granularity: i.granularity }));
        },
      }),
      def({
        name: 'list_alerts',
        description:
          "The organisation's alerts from its automatic checks: cash below the minimum, overdue customers, filings due, missed KPI targets, spending over budget, customers not billed, possible duplicate bills and payments, and unusual journals. Each has a severity, title, summary, amount and status. Call this for questions about risks, problems, what needs attention, or possible leakage.",
        inputSchema: object({ status: { type: 'string', enum: ['ACTIVE', 'DISMISSED', 'CLEARED', 'ALL'], description: 'ACTIVE for open and acknowledged alerts.' } }),
        input: z.object({ status: z.enum(['ACTIVE', 'DISMISSED', 'CLEARED', 'ALL']) }).strict(),
        permission: 'reports.read',
        label: (i) => (i.status === 'ACTIVE' ? 'Alerts needing attention' : `Alerts (${i.status.toLowerCase()})`),
        path: () => '/alerts',
        // fresh: false, so asking the copilot never runs the checks (the copilot only reads).
        run: async (i, c) => {
          const r = await this.alerts.list(c.orgId, { status: i.status, fresh: false });
          return compact({ lastChecked: r.lastScan?.finishedAt ?? null, summary: r.summary, alerts: r.alerts.map(({ evidence, rule, ...a }) => a) });
        },
      }),
      def({
        name: 'get_compliance_calendar',
        description: 'Statutory filings and tax payments (GST returns, TDS/TCS deposits and returns, PF, ESI, professional tax, advance tax) due in a date range, each with its due date, status (overdue, due soon, upcoming, done) and amount outstanding, plus anything still overdue from before the range. At most 400 days.',
        inputSchema: object({ from: S.date('First day, YYYY-MM-DD.'), to: S.date('Last day, YYYY-MM-DD.') }),
        input: z.object({ from: date, to: date }).strict(),
        permission: 'reports.read',
        label: (i) => `Compliance calendar, ${d(i.from)} to ${d(i.to)}`,
        path: () => '/tax/compliance',
        run: async (i, c) => compact(await this.compliance.calendar(c.orgId, i.from, i.to)),
      }),
      def({
        name: 'get_cfo_assessment',
        description:
          "The virtual CFO's assessment from the books today: a financial health score out of 100 with how each part was scored, and findings on liquidity, profitability, working capital, revenue growth, costs (lines growing fastest), debt, capital allocation and expansion capacity, risks and planning. Each finding has its figures, period, calculation method, assumptions, confidence, sources, recommended actions and who must approve them. Call this for broad questions about financial health, strategy, recommendations, cost reduction, debt, investment or expansion.",
        inputSchema: object({}),
        input: z.object({}).strict(),
        permission: 'reports.read',
        label: () => 'Virtual CFO assessment',
        path: () => '/cfo',
        run: async (_i, c) => {
          const { questions: _q, ...a } = await this.cfo.assessment({ id: c.orgId, role: c.role, functionalCurrency: (await this.orgs.get(c.orgId)).functionalCurrency, fiscalYearStartMonth: c.fiscalYearStartMonth });
          return a;
        },
      }),
      def({
        name: 'get_cfo_answer',
        description: `The virtual CFO's worked answer to one of these questions, computed from the books now, with its figures, a table of the records behind it, period, method, assumptions, confidence, recommended actions and approvals: ${CFO_QUESTIONS.map((q) => `${q.key} ("${q.question}")`).join('; ')}. Use it whenever a member asks one of these or something close to it, then explain the answer, including its method, assumptions and confidence.`,
        inputSchema: object({ question: { type: 'string', enum: CFO_QUESTIONS.map((q) => q.key), description: 'Which question.' } }),
        input: z.object({ question: z.enum(CFO_QUESTIONS.map((q) => q.key) as [CfoQuestionKey, ...CfoQuestionKey[]]) }).strict(),
        permission: 'reports.read',
        label: (i) => `Virtual CFO: ${CFO_QUESTIONS.find((q) => q.key === i.question)!.question}`,
        path: (i) => `/cfo?q=${i.question}`,
        run: async (i, c) => this.cfo.ask({ id: c.orgId, role: c.role, functionalCurrency: (await this.orgs.get(c.orgId)).functionalCurrency, fiscalYearStartMonth: c.fiscalYearStartMonth }, i.question),
      }),
    ];
  }

  /** Tool definitions sent to the model. */
  definitions(): CopilotTool[] {
    return this.defs.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, strict: true }));
  }

  names(): string[] {
    return this.defs.map((t) => t.name);
  }

  /** Runs one tool call. Never throws: a failure comes back as an error result the model can explain. */
  async run(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
    const t = this.defs.find((x) => x.name === name);
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
    if (!t) return this.fail({ tool: name, label: name, path: '', input, ok: false }, `Unknown tool "${name}"`);
    const parsed = t.input.safeParse(rawInput);
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return this.fail({ tool: name, label: name, path: '', input, ok: false }, `Invalid input: ${why}`);
    }
    const source: CopilotSource = { tool: name, label: t.label(parsed.data, ctx), path: t.path(parsed.data, ctx), input, ok: true };
    if (!hasPermission(ctx.role, t.permission)) return this.fail(source, 'This member does not have access to these figures');
    try {
      const data = await t.run(parsed.data, ctx);
      let content = JSON.stringify(data);
      if (content.length > MAX_TOOL_OUTPUT_CHARS) content = `${content.slice(0, MAX_TOOL_OUTPUT_CHARS)}… [cut: the full result was ${content.length} characters; ask for a narrower range]`;
      return { ok: true, content, source };
    } catch (e) {
      if (!(e instanceof DomainError) && !(e instanceof HttpException)) this.log.error(`Copilot tool ${name} failed`, e instanceof Error ? e.stack : String(e));
      return this.fail(source, describe(e));
    }
  }

  private fail(source: CopilotSource, message: string): ToolOutcome {
    return { ok: false, content: JSON.stringify({ error: message }), source: { ...source, ok: false, error: message } };
  }
}

function describe(e: unknown): string {
  if (e instanceof DomainError) return e.message;
  if (e instanceof HttpException) {
    const r = e.getResponse();
    if (r && typeof r === 'object' && 'message' in r) return String((r as { message: unknown }).message);
    return e.message;
  }
  // Anything else is an internal error: its details stay in the server log.
  return 'The figures could not be read because of an internal error';
}
