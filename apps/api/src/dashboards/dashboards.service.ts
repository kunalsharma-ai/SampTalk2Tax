import Anthropic from '@anthropic-ai/sdk';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  checkDashboard,
  COMPARISONS,
  DASHBOARD_METRICS,
  dashboardData,
  describeDashboard,
  MAX_DASHBOARD_MONTHS,
  MAX_WIDGETS,
  minorUnits,
  monthsNeeded,
  WIDGET_LABELS,
  WIDGET_SIZES,
  WIDGET_TYPES,
  type DashboardConfig,
  type Widget,
} from '@talk2tax/accounting-engine';
import { Prisma, type Dashboard } from '@talk2tax/database';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AiControlService } from '../ai-control/ai-control.service';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { todayIst } from '../cash-flow/cash-flow.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import type { CopilotRequest, CopilotTool } from '../copilot/copilot.model';
import { IntegrationsService } from '../integrations/integrations.service';
import { KpisService, monthEnd, shiftMonth } from '../kpis/kpis.service';

type Actor = { id: string };
export type DashboardInput = { name: string; description?: string | null; config: unknown };
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
const MAX_DRAFT_TOKENS = 6000;
/** Recorded with every AI draft, so a change to the instructions can be traced. */
export const DASHBOARD_PROMPT_VERSION = 'dashboard-draft-1';

/**
 * Dashboards of approved metrics. Anyone with reports.read can view them; building, changing
 * and deleting them, and drafting them with the AI, need dashboards.manage. The AI only
 * proposes a configuration (which widgets show which approved metrics); the figures are always
 * worked out from the posted books by the engine.
 */
@Injectable()
export class DashboardsService {
  private readonly log = new Logger('Dashboards');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kpis: KpisService,
    private readonly guard: AiControlService,
    private readonly integrations: IntegrationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  catalogue() {
    return {
      metrics: DASHBOARD_METRICS,
      widgetTypes: WIDGET_TYPES.map((t) => ({ type: t, label: WIDGET_LABELS[t] })),
      sizes: WIDGET_SIZES,
      comparisons: COMPARISONS,
      limits: { widgets: MAX_WIDGETS, months: MAX_DASHBOARD_MONTHS },
    };
  }

  private async org(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return { currency: o.functionalCurrency, scale: minorUnits(o.functionalCurrency) };
  }

  private check(config: unknown) {
    const { config: clean, issues } = checkDashboard(config);
    if (issues.length) throw new DomainError('INVALID_DASHBOARD', issues.length === 1 ? issues[0]! : `${issues.length} problems in the dashboard`, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return clean;
  }

  /** The month shown: the one asked for, or the last complete month. */
  private month(month: string | undefined) {
    const today = todayIst();
    const m = month ?? shiftMonth(today.slice(0, 7), -1);
    if (m > today.slice(0, 7)) throw new DomainError('INVALID_MONTH', 'That month has not started yet');
    if (m < '2000-01') throw new DomainError('INVALID_MONTH', 'Months start from 2000');
    const end = monthEnd(m);
    return { month: m, to: end < today ? end : today, inProgress: end >= today };
  }

  /** Every widget's figures, worked out from the posted books for the month. */
  async data(org: OrgContext, config: DashboardConfig, month?: string) {
    const o = await this.org(org.id);
    const m = this.month(month);
    const months = await this.kpis.monthFigures(org.id, m.month, m.to, monthsNeeded(config));
    const salesRead = hasPermission(org.role as RoleName, 'sales.read');
    const customers = new Map<number, Awaited<ReturnType<KpisService['customerRevenue']>> & { from: string }>();
    for (const [i, w] of config.widgets.entries()) {
      if (w.type !== 'TOP_CUSTOMERS' || !salesRead) continue;
      const from = `${shiftMonth(m.month, -(w.months - 1))}-01`;
      customers.set(i, { from, ...(await this.kpis.customerRevenue(org.id, from, m.to, o.scale, w.count)) });
    }
    const widgets = dashboardData(config, months, o.scale, (_w, i) => {
      const c = customers.get(i);
      return c ? { type: 'TOP_CUSTOMERS', from: c.from, to: m.to, total: c.total, rows: c.top.map((r) => ({ id: r.id, name: r.name, revenue: r.revenue, share: r.share })), others: c.others } : null;
    });
    return { currency: o.currency, month: m.month, to: m.to, inProgress: m.inProgress, widgets };
  }

  /** Checks a configuration and works out its figures without saving it. */
  async preview(org: OrgContext, config: unknown, month?: string) {
    const clean = this.check(config);
    return { config: clean, descriptions: describeDashboard(clean), ...(await this.data(org, clean, month)) };
  }

  // ------------------------------------------------------------------ saved dashboards

  private async names(ids: string[]) {
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } });
    return Object.fromEntries(users.map((u) => [u.id, u.name]));
  }

  private view(d: Dashboard, people: Record<string, string>) {
    const config = d.config as unknown as DashboardConfig;
    return {
      id: d.id,
      number: `DB-${String(d.number).padStart(4, '0')}`,
      name: d.name,
      description: d.description,
      config,
      descriptions: describeDashboard(config),
      version: d.version,
      createdBy: people[d.createdById] ?? 'Former member',
      updatedBy: people[d.updatedById] ?? 'Former member',
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  async list(orgId: string) {
    const rows = await this.prisma.dashboard.findMany({ where: { orgId }, orderBy: { number: 'asc' } });
    const people = await this.names(rows.flatMap((d) => [d.createdById, d.updatedById]));
    return { items: rows.map((d) => this.view(d, people)) };
  }

  private async find(orgId: string, id: string) {
    const d = await this.prisma.dashboard.findFirst({ where: { id, orgId } });
    if (!d) throw new DomainError('NOT_FOUND', 'Dashboard not found', HttpStatus.NOT_FOUND);
    return d;
  }

  async get(org: OrgContext, id: string, month?: string) {
    const d = await this.find(org.id, id);
    const people = await this.names([d.createdById, d.updatedById]);
    const v = this.view(d, people);
    return { ...v, ...(await this.data(org, v.config, month)) };
  }

  private async nameFree(orgId: string, name: string, exceptId?: string) {
    if (await this.prisma.dashboard.findFirst({ where: { orgId, name, ...(exceptId ? { NOT: { id: exceptId } } : {}) } })) throw new DomainError('DUPLICATE', 'A dashboard with that name already exists', HttpStatus.CONFLICT);
  }

  async create(org: OrgContext, actor: Actor, input: DashboardInput) {
    const config = this.check(input.config);
    await this.nameFree(org.id, input.name.trim());
    const id = await this.prisma.$transaction(async (tx) => {
      const top = await tx.dashboard.aggregate({ where: { orgId: org.id }, _max: { number: true } });
      const d = await tx.dashboard.create({ data: { orgId: org.id, number: (top._max.number ?? 0) + 1, name: input.name.trim(), description: input.description?.trim() || null, config: config as unknown as Prisma.InputJsonValue, createdById: actor.id, updatedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'dashboard.created', entityType: 'dashboard', entityId: d.id, data: { name: d.name, widgets: config.widgets.length } });
      return d.id;
    });
    return this.get(org, id);
  }

  async update(org: OrgContext, actor: Actor, id: string, input: DashboardInput & { baseVersion: number }) {
    const config = this.check(input.config);
    await this.nameFree(org.id, input.name.trim(), id);
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM dashboards WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const d = await tx.dashboard.findFirst({ where: { id, orgId: org.id } });
      if (!d) throw new DomainError('NOT_FOUND', 'Dashboard not found', HttpStatus.NOT_FOUND);
      if (d.version !== input.baseVersion) throw new DomainError('DASHBOARD_CHANGED', 'Someone changed this dashboard while you were editing. Reload it and make your change again.', HttpStatus.CONFLICT);
      await tx.dashboard.update({ where: { id }, data: { name: input.name.trim(), description: input.description?.trim() || null, config: config as unknown as Prisma.InputJsonValue, version: d.version + 1, updatedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'dashboard.updated', entityType: 'dashboard', entityId: id, data: { version: d.version + 1, before: { name: d.name, description: d.description, config: d.config }, after: { name: input.name.trim(), description: input.description?.trim() || null, config: config as unknown as Prisma.InputJsonValue } } });
    });
    return this.get(org, id);
  }

  async remove(orgId: string, actor: Actor, id: string) {
    const d = await this.find(orgId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.dashboard.delete({ where: { id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'dashboard.deleted', entityType: 'dashboard', entityId: id, data: { name: d.name, config: d.config } });
    });
  }

  // ------------------------------------------------------------------ drafting with the AI

  async aiStatus(orgId: string) {
    const ai = await this.integrations.ai(orgId);
    const block = await this.guard.check(orgId, 'COPILOT');
    return { configured: ai.model !== null, model: ai.modelName, available: !block, reason: block?.message ?? null };
  }

  private prompt() {
    const metrics = DASHBOARD_METRICS.map((m) => `- ${m.key}: ${m.label} [${m.unit.toLowerCase()}; ${m.better === 'HIGHER' ? 'higher is better' : 'lower is better'}] ${m.formula}`).join('\n');
    return [
      'You design financial dashboards for a finance team using an accounting system. You choose which approved metrics to show and how; the system works out every figure from the posted books. Never invent metrics, figures or capabilities.',
      '',
      'Approved metrics (use these keys only):',
      metrics,
      '',
      `Widgets (at most ${MAX_WIDGETS}), each with a short title and a size SMALL, MEDIUM or LARGE:`,
      '- STAT {metric, compare: PREVIOUS_MONTH | SAME_MONTH_LAST_YEAR | NONE}: one figure for the month. Usually SMALL.',
      `- LINE or BAR {metrics: 1 to 4 keys, all with the same unit, months: 3 to ${MAX_DASHBOARD_MONTHS}}: a chart over the months. Never mix units in one chart; use two charts instead.`,
      '- TABLE {metrics: 1 to 8 keys, months: 1 to 12}: monthly values.',
      '- TOP_CUSTOMERS {count: 3 to 10, months: 1 to 12}: the largest customers by revenue.',
      '',
      'Put the most important figures first. If the request asks for something not available (such as budgets, a department, a product line, cash forecasts or another company), use the closest approved metrics and say what is missing in notes. If something is unclear, make a sensible choice and ask a short question in questions.',
      'Answer only by calling propose_dashboard.',
    ].join('\n');
  }

  private tool(): CopilotTool {
    const keys = DASHBOARD_METRICS.map((m) => m.key);
    return {
      name: 'propose_dashboard',
      description: 'Propose a dashboard: its name and widgets, with notes on anything not available and questions.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'One sentence on what the dashboard is for' },
          widgets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: [...WIDGET_TYPES] },
                title: { type: 'string' },
                size: { type: 'string', enum: [...WIDGET_SIZES] },
                metric: { type: 'string', enum: keys },
                metrics: { type: 'array', items: { type: 'string', enum: keys } },
                compare: { type: 'string', enum: [...COMPARISONS] },
                months: { type: 'integer' },
                count: { type: 'integer' },
              },
              required: ['type', 'title'],
            },
          },
          notes: { type: 'array', items: { type: 'string' }, description: 'What was asked for but is not available, and assumptions made' },
          questions: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'description', 'widgets', 'notes', 'questions'],
      },
    } as CopilotTool;
  }

  /**
   * Drafts a dashboard from a description (and the conversation so far, to refine it). Nothing
   * is saved: the configuration comes back checked, with its figures worked out from the books.
   */
  async draft(org: OrgContext, actor: Actor, input: { request: string; conversation: ChatTurn[]; month?: string }) {
    await this.guard.assert(org.id, 'COPILOT');
    const ai = await this.integrations.ai(org.id);
    if (!ai.model) throw new DomainError('AI_NOT_CONFIGURED', 'AI is not set up. An owner or admin can add a key in Settings → Integrations.', HttpStatus.SERVICE_UNAVAILABLE);
    const messages: CopilotRequest['messages'] = [
      { role: 'user', content: [{ type: 'text', text: input.request.trim() }] },
      ...input.conversation.map((t) => ({ role: t.role, content: [{ type: 'text' as const, text: t.text }] })),
    ];
    if (messages[messages.length - 1]!.role !== 'user') messages.push({ role: 'user', content: [{ type: 'text', text: 'Please propose the dashboard.' }] });
    const request: CopilotRequest = { model: ai.modelName, max_tokens: MAX_DRAFT_TOKENS, system: this.prompt(), tools: [this.tool()], tool_choice: { type: 'tool', name: 'propose_dashboard' }, messages, metadata: { user_id: actor.id } };
    const asked = [input.request, ...input.conversation.map((t) => `${t.role}: ${t.text}`)].join('\n\n').slice(0, 8000);
    let res: Anthropic.Beta.Messages.BetaMessage;
    try {
      res = await ai.model.send(request, { signal: AbortSignal.timeout(this.config.COPILOT_TURN_TIMEOUT_SECONDS * 1000) });
    } catch (e) {
      const err = this.providerError(e);
      await this.record(org.id, actor, asked, { status: 'FAILED', errorCode: err.code, errorMessage: err.message, model: ai.modelName });
      throw new DomainError(err.code, err.message, HttpStatus.BAD_GATEWAY);
    }
    const tokens = { inputTokens: res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0), outputTokens: res.usage.output_tokens, model: res.model };
    const call = res.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'propose_dashboard');
    if (res.stop_reason === 'refusal' || !call) {
      const code = res.stop_reason === 'refusal' ? 'REFUSED' : 'NO_PROPOSAL';
      const msg = code === 'REFUSED' ? 'The AI model declined to draft this dashboard.' : 'The AI model did not propose a dashboard. Try describing it differently.';
      await this.record(org.id, actor, asked, { status: 'FAILED', errorCode: code, errorMessage: msg, ...tokens });
      throw new DomainError(code, msg, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const raw = call.input as { name?: unknown; description?: unknown; widgets?: unknown; notes?: unknown; questions?: unknown };
    const strings = (x: unknown) => (Array.isArray(x) ? x : []).filter((q): q is string => typeof q === 'string').slice(0, 10);
    const proposal = {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
      description: typeof raw.description === 'string' ? raw.description.slice(0, 1000) : '',
      widgets: (Array.isArray(raw.widgets) ? raw.widgets : []).slice(0, MAX_WIDGETS) as Widget[],
      notes: strings(raw.notes),
      questions: strings(raw.questions),
    };
    const draft = await this.record(org.id, actor, asked, { status: 'DONE', result: proposal as unknown as Prisma.InputJsonValue, ...tokens });
    // The draft is checked like any dashboard; problems are shown for people to fix, never hidden.
    const { config, issues } = checkDashboard({ widgets: proposal.widgets });
    const data = issues.length ? null : await this.data(org, config, input.month);
    return { draftId: draft.id, name: proposal.name, description: proposal.description, config: issues.length ? { widgets: proposal.widgets } : config, notes: proposal.notes, questions: proposal.questions, issues, descriptions: issues.length ? [] : describeDashboard(config), data, model: res.model };
  }

  private async record(orgId: string, actor: Actor, request: string, data: { status: 'DONE' | 'FAILED'; result?: Prisma.InputJsonValue; errorCode?: string; errorMessage?: string; model?: string; inputTokens?: number; outputTokens?: number }) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.dashboardAiDraft.create({ data: { orgId, request, createdById: actor.id, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: data.status === 'DONE' ? 'dashboard.ai_drafted' : 'dashboard.ai_draft_failed', entityType: 'dashboard_ai_draft', entityId: d.id, data: { promptVersion: DASHBOARD_PROMPT_VERSION, model: data.model ?? null, inputTokens: data.inputTokens ?? 0, outputTokens: data.outputTokens ?? 0, errorCode: data.errorCode ?? null } });
      return d;
    });
  }

  private providerError(e: unknown): { code: string; message: string } {
    if (e instanceof Anthropic.APIUserAbortError || e instanceof Anthropic.APIConnectionTimeoutError || (e instanceof Error && e.name === 'TimeoutError')) return { code: 'AI_TIMEOUT', message: 'The AI provider took too long. Try again.' };
    if (e instanceof Anthropic.AuthenticationError) return { code: 'AI_KEY_REJECTED', message: 'The AI provider rejected the API key. An owner or admin needs to check the key in Settings → Integrations.' };
    if (e instanceof Anthropic.RateLimitError) return { code: 'AI_RATE_LIMITED', message: 'The AI provider is limiting requests right now. Try again in a minute.' };
    if (e instanceof Anthropic.APIConnectionError) return { code: 'AI_UNREACHABLE', message: 'The AI provider could not be reached. Try again shortly.' };
    if (e instanceof Anthropic.APIError) return { code: e.status === 529 ? 'AI_OVERLOADED' : 'AI_PROVIDER_ERROR', message: 'The AI provider returned an error. Try again shortly.' };
    this.log.error('Dashboard draft failed', e instanceof Error ? e.stack : String(e));
    return { code: 'INTERNAL', message: 'Something went wrong. Try again.' };
  }
}
