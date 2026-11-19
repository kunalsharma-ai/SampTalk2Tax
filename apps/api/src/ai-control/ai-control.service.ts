import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { IntegrationsService } from '../integrations/integrations.service';
import { AiAgent, Prisma } from '@talk2tax/database';
import { D } from '@talk2tax/accounting-engine';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { CopilotModel } from '../copilot/copilot.model';
import { todayIst } from '../tasks/tasks.service';
import { UsageService } from '../usage/usage.service';
import { knownModels, modelAccess, modelList, modelRefusal, platformAllowedModels } from './model-access';

type Member = { orgId: string; role: RoleName };
type Actor = { id: string };

/** Action levels, from the product brief: what an agent may do on its own. */
export const ACTION_LEVELS = {
  0: 'Read-only analysis',
  1: 'Draft recommendations',
  2: 'Prepare changes for approval',
  3: 'Execute approved low-risk workflows',
  4: 'Execute authorised actions within strict limits',
} as const;

/**
 * The AI agents the control center governs. The action level is fixed in code, not a setting:
 * no agent here changes the books or sends anything without a person's approval.
 */
export const AGENTS: Record<AiAgent, { name: string; does: string; level: 0 | 1 | 2; approval: string | null; link: string }> = {
  COPILOT: { name: 'Finance copilot', does: 'Answers questions about the books from the reports it is allowed to run, and drafts financial policy rules from a description for people to check, test and approve.', level: 0, approval: null, link: '/copilot' },
  COLLECTIONS: { name: 'Collections agent', does: 'Drafts a payment reminder for each overdue customer, checked against the books.', level: 2, approval: 'A person sends, edits or rejects each reminder.', link: '/sales/collections' },
  BANKING: { name: 'Bank reconciliation agent', does: 'Suggests a match, receipt, payment or entry for unmatched bank lines.', level: 2, approval: 'A person accepts or dismisses each suggestion.', link: '/banking' },
  CLOSE: { name: 'Month-end close agent', does: 'Reviews a month before it is closed and proposes adjusting entries.', level: 2, approval: 'A person posts or rejects each entry, and closes the month.', link: '/close' },
  CFO: { name: 'Virtual CFO', does: 'Writes the executive summary of a board pack or investor update from its figures; a summary quoting any figure not in the books is rejected.', level: 1, approval: 'A person reviews the pack and finalises it.', link: '/cfo' },
};
export const AGENT_KEYS = Object.keys(AGENTS) as AiAgent[];

/** How far back acceptance rates look. */
export const ACCURACY_DAYS = 90;

export type AgentBlock = { code: 'AI_SHUTDOWN' | 'AI_NOT_CONFIGURED' | 'MODEL_NOT_ALLOWED' | 'AI_TASK_LIMIT' | 'AI_OFF' | 'AGENT_OFF' | 'AI_BUDGET_REACHED' | 'AI_CREDITS_USED_UP'; message: string; status: HttpStatus };

/** The start of the current calendar month in India time, as an instant. */
export function monthStartIst(now: Date = new Date()): { month: string; since: Date } {
  const month = todayIst(now).slice(0, 7);
  return { month, since: new Date(`${month}-01T00:00:00+05:30`) };
}

/** The name used for calls whose model was not stored (failed before the provider answered). */
export const UNKNOWN_MODEL = 'Model not recorded';
type ModelTokens = { model: string; inputTokens: number; outputTokens: number };
type ModelRow = { _sum: { inputTokens: number | null; outputTokens: number | null } } & Record<string, unknown>;

/** Adds up rows grouped by model, naming each by the model that answered, else the one asked. */
function byModel(rows: ModelRow[], served: string | null, requested: string | null): ModelTokens[] {
  const out = new Map<string, ModelTokens>();
  for (const r of rows) {
    const name = ((served && (r[served] as string | null)) || (requested && (r[requested] as string | null)) || UNKNOWN_MODEL).trim();
    const m = out.get(name) ?? { model: name, inputTokens: 0, outputTokens: 0 };
    m.inputTokens += r._sum.inputTokens ?? 0;
    m.outputTokens += r._sum.outputTokens ?? 0;
    out.set(name, m);
  }
  return [...out.values()];
}
const merge = (...lists: ModelTokens[][]) => byModel(lists.flat().map((m) => ({ model: m.model, _sum: { inputTokens: m.inputTokens, outputTokens: m.outputTokens } })), null, 'model');

/** What tokens cost at a price per million, in US dollars to 4 decimal places. */
export function tokenCost(inputTokens: number, outputTokens: number, price: { inputPerMillion: string; outputPerMillion: string }): string {
  return new D(inputTokens).times(price.inputPerMillion).plus(new D(outputTokens).times(price.outputPerMillion)).div(1_000_000).toDecimalPlaces(4, D.ROUND_HALF_UP).toFixed(4);
}

@Injectable()
export class AiControlService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly integrations: IntegrationsService,
    private readonly metering: UsageService,
  ) {}

  // ------------------------------------------------------------------ the guard every agent goes through

  /** Tokens (input plus output) each agent used since the start of this month, India time. */
  async usage(orgId: string, since = monthStartIst().since) {
    const where = { orgId, createdAt: { gte: since } };
    const [copilotChat, policyDrafts, dashboardDrafts, reportCalls, collections, banking, close, cfo] = await Promise.all([
      this.prisma.copilotMessage.aggregate({ where: { ...where, role: 'ASSISTANT' }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      // Drafting policies, dashboards and reports is done by the copilot and counts towards its budget.
      this.prisma.policyAiDraft.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.dashboardAiDraft.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.reportAiCall.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.collectionDraft.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.bankAiSuggestion.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.closeAiReview.aggregate({ where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
      this.prisma.cfoReport.aggregate({ where: { orgId, aiStartedAt: { gte: since } }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
    ]);
    const u = (a: { _count: number; _sum: { inputTokens: number | null; outputTokens: number | null } }) => ({
      calls: a._count,
      inputTokens: a._sum.inputTokens ?? 0,
      outputTokens: a._sum.outputTokens ?? 0,
      tokens: (a._sum.inputTokens ?? 0) + (a._sum.outputTokens ?? 0),
    });
    const parts = [copilotChat, policyDrafts, dashboardDrafts, reportCalls];
    const copilot = { _count: parts.reduce((a, p) => a + p._count, 0), _sum: { inputTokens: parts.reduce((a, p) => a + (p._sum.inputTokens ?? 0), 0), outputTokens: parts.reduce((a, p) => a + (p._sum.outputTokens ?? 0), 0) } };
    return { COPILOT: u(copilot), COLLECTIONS: u(collections), BANKING: u(banking), CLOSE: u(close), CFO: u(cfo) } as Record<AiAgent, ReturnType<typeof u>>;
  }

  /**
   * Whether an agent may call the AI model now: the server has a key, the organisation has AI
   * on (not stopped), the agent is on, and it is under its monthly token budget. Agents check
   * this before starting and again before each model call, so the emergency stop, switching an
   * agent off or reaching the budget also stops work already running.
   */
  async check(orgId: string, agent: AiAgent, starting = false): Promise<AgentBlock | null> {
    // The platform-wide shutdown (SEC-038) comes first: it holds even where no key is set up.
    const shutdown = await this.platformShutdown();
    if (shutdown) return { code: 'AI_SHUTDOWN', message: `AI is stopped across Talk2Tax by the people who run it: ${shutdown.reason}. Nothing was sent to the AI model.`, status: HttpStatus.SERVICE_UNAVAILABLE };
    const ai = await this.integrations.ai(orgId);
    if (!ai.model) return { code: 'AI_NOT_CONFIGURED', message: 'AI is not set up: an owner or admin can add a Claude API key in Settings → Integrations. Nothing was sent anywhere.', status: HttpStatus.SERVICE_UNAVAILABLE };
    // Model access policies (SEC-034): the model about to be called must be allowed by the platform and the organisation.
    const refused = modelRefusal(ai.modelName, await modelAccess(this.prisma, orgId));
    if (refused) {
      const fix = refused.layer === 'PLATFORM' ? 'An owner or admin can choose an allowed model in Settings → Integrations.' : 'An owner or admin can choose an allowed model in Settings → Integrations, or allow this one in the AI control center.';
      return { code: 'MODEL_NOT_ALLOWED', message: `${refused.message} ${fix} Nothing was sent to the AI model.`, status: HttpStatus.CONFLICT };
    }
    const [s, a] = await Promise.all([
      this.prisma.copilotSettings.findUnique({ where: { orgId } }),
      this.prisma.aiAgentSetting.findUnique({ where: { orgId_agent: { orgId, agent } } }),
    ]);
    if (!s?.enabled) {
      return {
        code: 'AI_OFF',
        message: s?.offReason
          ? `AI was stopped for this organisation: ${s.offReason}. An owner or admin can turn it back on in the AI control center.`
          : 'AI is turned off for this organisation. An owner or admin can turn it on in the copilot settings.',
        status: HttpStatus.CONFLICT,
      };
    }
    if (a && !a.enabled) return { code: 'AGENT_OFF', message: `The ${AGENTS[agent].name.toLowerCase()} is turned off in the AI control center.`, status: HttpStatus.CONFLICT };
    // Execution limits (SEC-037): tasks started in the last 60 minutes. A new task needs room for
    // itself; work already running stops only once the count is over the limit.
    const hourly = this.hourlyLimit(a?.hourlyTaskLimit ?? null);
    if (hourly) {
      const started = (await this.usage(orgId, new Date(Date.now() - 3_600_000)))[agent].calls;
      if (starting ? started >= hourly : started > hourly) {
        return { code: 'AI_TASK_LIMIT', message: `The ${AGENTS[agent].name.toLowerCase()} has started its ${hourly.toLocaleString('en-IN')} AI tasks for the last hour. Try again later; an owner or admin can change the limit in the AI control center. Nothing more was sent to the AI model.`, status: HttpStatus.TOO_MANY_REQUESTS };
      }
    }
    if (a?.monthlyTokenLimit) {
      const used = (await this.usage(orgId))[agent].tokens;
      if (used >= a.monthlyTokenLimit) {
        return { code: 'AI_BUDGET_REACHED', message: `The ${AGENTS[agent].name.toLowerCase()} has used its ${a.monthlyTokenLimit.toLocaleString('en-IN')} tokens for this month. An owner or admin can raise the budget in the AI control center.`, status: HttpStatus.TOO_MANY_REQUESTS };
      }
    }
    // The plan's AI requests for the month, shared by every agent.
    return this.metering.aiBlock(orgId);
  }

  /** Before an agent starts new work: every check, with room for one more task this hour. */
  async assert(orgId: string, agent: AiAgent) {
    const b = await this.check(orgId, agent, true);
    if (b) throw new DomainError(b.code, b.message, b.status);
  }

  /** An agent's tasks-per-hour limit: its own, else the server's default (0 = none). */
  private hourlyLimit(own: number | null): number | null {
    return own ?? (this.config.AI_AGENT_TASKS_PER_HOUR || null);
  }

  /** The error stored on work that was waiting when a check started failing. */
  /** For an agent's own page: why it cannot run when that is the stop, its switch or its budget (not simply AI never turned on). */
  async notice(orgId: string, agent: AiAgent): Promise<{ code: AgentBlock['code']; message: string } | null> {
    // As if starting new work, so a reached hourly limit shows before anyone tries.
    const b = await this.check(orgId, agent, true);
    if (!b || b.code === 'AI_NOT_CONFIGURED') return null;
    if (b.code === 'AI_OFF' && !b.message.startsWith('AI was stopped')) return null;
    // AI_SHUTDOWN is always shown.
    return { code: b.code, message: b.message };
  }

  static stoppedError(b: AgentBlock): { errorCode: string; errorMessage: string } {
    const code = b.code === 'AI_OFF' || b.code === 'AI_SHUTDOWN' ? 'AI_STOPPED' : b.code;
    return { errorCode: code, errorMessage: `Not done: ${b.message}` };
  }

  // ------------------------------------------------------------------ the control center

  /** Tokens each agent used since `since`, by model (for costs at the organisation's prices). */
  async usageByModel(orgId: string, since = monthStartIst().since): Promise<Record<AiAgent, ModelTokens[]>> {
    const where = { orgId, createdAt: { gte: since } };
    const sum = { inputTokens: true, outputTokens: true } as const;
    const [chat, policy, dashboard, report, collections, banking, close, cfo] = await Promise.all([
      this.prisma.copilotMessage.groupBy({ by: ['servedModel'], where: { ...where, role: 'ASSISTANT' }, _sum: sum }),
      this.prisma.policyAiDraft.groupBy({ by: ['model'], where, _sum: sum }),
      this.prisma.dashboardAiDraft.groupBy({ by: ['model'], where, _sum: sum }),
      this.prisma.reportAiCall.groupBy({ by: ['model'], where, _sum: sum }),
      this.prisma.collectionDraft.groupBy({ by: ['model', 'servedModel'], where, _sum: sum }),
      this.prisma.bankAiSuggestion.groupBy({ by: ['model', 'servedModel'], where, _sum: sum }),
      this.prisma.closeAiReview.groupBy({ by: ['model', 'servedModel'], where, _sum: sum }),
      this.prisma.cfoReport.groupBy({ by: ['aiModel', 'servedModel'], where: { orgId, aiStartedAt: { gte: since } }, _sum: sum }),
    ]);
    const rows = (x: unknown) => x as ModelRow[];
    return {
      COPILOT: merge(byModel(rows(chat), 'servedModel', null), byModel(rows(policy), null, 'model'), byModel(rows(dashboard), null, 'model'), byModel(rows(report), null, 'model')),
      COLLECTIONS: byModel(rows(collections), 'servedModel', 'model'),
      BANKING: byModel(rows(banking), 'servedModel', 'model'),
      CLOSE: byModel(rows(close), 'servedModel', 'model'),
      CFO: byModel(rows(cfo), 'servedModel', 'aiModel'),
    };
  }

  /** Set what one model costs per million tokens, in US dollars. */
  async setPrice(member: Member, actor: Actor, input: { model: string; inputPerMillion: string; outputPerMillion: string }) {
    const { orgId } = member;
    await this.prisma.$transaction(async (tx) => {
      const key = { orgId_model: { orgId, model: input.model } };
      const before = await tx.aiModelPrice.findUnique({ where: key });
      const data = { inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion, updatedById: actor.id };
      await tx.aiModelPrice.upsert({ where: key, create: { orgId, model: input.model, ...data }, update: data });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'ai.model_price_set',
        entityType: 'ai_model_price',
        entityId: orgId,
        data: { model: input.model, from: before ? { inputPerMillion: String(before.inputPerMillion), outputPerMillion: String(before.outputPerMillion) } : null, to: { inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion } },
      });
    });
    return this.overview(member);
  }

  // ------------------------------------------------------------------ model access (SEC-034)

  /** Each known model, whether the platform and the organisation allow it, and whether the model in use is allowed. */
  private async modelAccessView(orgId: string, inUse: string) {
    const access = await modelAccess(this.prisma, orgId);
    return {
      organisation: access.organisation,
      platformLimited: access.platform !== null,
      inUse,
      inUseAllowed: !modelRefusal(inUse, access),
      models: knownModels(this.config.COPILOT_MODEL).map((m) => ({
        ...m,
        platformAllowed: !access.platform || access.platform.includes(m.id),
        allowed: !modelRefusal(m.id, access),
      })),
    };
  }

  /** The models this organisation allows; an empty list allows every model Talk2Tax allows. */
  async saveModels(member: Member, actor: Actor, allowed: string[]) {
    const { orgId } = member;
    const known = knownModels(this.config.COPILOT_MODEL).map((m) => m.id);
    const unknown = allowed.filter((m) => !known.includes(m));
    if (unknown.length) throw new DomainError('UNKNOWN_MODEL', `Not a model Talk2Tax offers: ${unknown.join(', ')}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const platform = await platformAllowedModels(this.prisma);
    const blocked = platform ? allowed.filter((m) => !platform.includes(m)) : [];
    if (blocked.length) throw new DomainError('MODEL_NOT_ALLOWED', `Not allowed on Talk2Tax by the people who run it: ${blocked.join(', ')}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const next = [...new Set(allowed)].sort();
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.copilotSettings.findUnique({ where: { orgId } });
      await tx.copilotSettings.upsert({ where: { orgId }, create: { orgId, enabled: false, allowedModels: next, updatedById: actor.id }, update: { allowedModels: next, updatedById: actor.id } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ai.models_allowed_changed', entityType: 'copilot_settings', entityId: orgId, data: { from: modelList(before?.allowedModels), to: next } });
    });
    return this.overview(member);
  }

  async removePrice(member: Member, actor: Actor, model: string) {
    const { orgId } = member;
    await this.prisma.$transaction(async (tx) => {
      const key = { orgId_model: { orgId, model } };
      const before = await tx.aiModelPrice.findUnique({ where: key });
      if (!before) throw new DomainError('PRICE_NOT_FOUND', `No price is set for ${model}`, HttpStatus.NOT_FOUND);
      await tx.aiModelPrice.delete({ where: key });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ai.model_price_removed', entityType: 'ai_model_price', entityId: orgId, data: { model, was: { inputPerMillion: String(before.inputPerMillion), outputPerMillion: String(before.outputPerMillion) } } });
    });
    return this.overview(member);
  }

  async overview(member: Member) {
    const ai = await this.integrations.ai(member.orgId);
    const { orgId } = member;
    const { month, since } = monthStartIst();
    const accuracySince = new Date(Date.now() - ACCURACY_DAYS * 86_400_000);
    const [priceRows, models] = await Promise.all([this.prisma.aiModelPrice.findMany({ where: { orgId }, orderBy: { model: 'asc' } }), this.usageByModel(orgId, since)]);
    const prices = new Map(priceRows.map((p) => [p.model, { inputPerMillion: new D(String(p.inputPerMillion)).toFixed(4), outputPerMillion: new D(String(p.outputPerMillion)).toFixed(4) }]));
    const costOf = (list: ModelTokens[]) => {
      let amount = new D(0);
      let unpricedTokens = 0;
      const rows = list.map((m) => {
        const price = prices.get(m.model) ?? null;
        const cost = price ? tokenCost(m.inputTokens, m.outputTokens, price) : null;
        if (cost) amount = amount.plus(cost);
        else unpricedTokens += m.inputTokens + m.outputTokens;
        return { ...m, cost };
      });
      return { amount: amount.toFixed(4), currency: 'USD', unpricedTokens, models: rows };
    };
    const [settings, agentRows, usage, drafts, bank, adjustments, failures, running, last] = await Promise.all([
      this.prisma.copilotSettings.findUnique({ where: { orgId } }),
      this.prisma.aiAgentSetting.findMany({ where: { orgId } }),
      this.usage(orgId, since),
      this.prisma.collectionDraft.groupBy({ by: ['status', 'edited'], where: { orgId, createdAt: { gte: accuracySince } }, _count: true }),
      this.prisma.bankAiSuggestion.groupBy({ by: ['status'], where: { orgId, createdAt: { gte: accuracySince }, OR: [{ status: { not: 'DISMISSED' } }, { decidedById: { not: null } }] }, _count: true }),
      this.prisma.closeAdjustment.groupBy({ by: ['status'], where: { orgId, createdAt: { gte: accuracySince } }, _count: true }),
      Promise.all([
        Promise.all([
          this.prisma.copilotMessage.count({ where: { orgId, role: 'ASSISTANT', status: 'FAILED', createdAt: { gte: since } } }),
          this.prisma.policyAiDraft.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
          this.prisma.dashboardAiDraft.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
          this.prisma.reportAiCall.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
        ]).then((n) => n.reduce((a, b) => a + b, 0)),
        this.prisma.collectionDraft.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
        this.prisma.bankAiSuggestion.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
        this.prisma.closeAiReview.count({ where: { orgId, status: 'FAILED', createdAt: { gte: since } } }),
        this.prisma.cfoReport.count({ where: { orgId, aiStatus: 'FAILED', aiStartedAt: { gte: since } } }),
      ]),
      Promise.all([
        this.prisma.copilotMessage.count({ where: { orgId, role: 'ASSISTANT', status: 'PENDING' } }),
        this.prisma.collectionDraft.count({ where: { orgId, status: 'DRAFTING' } }),
        this.prisma.bankAiSuggestion.count({ where: { orgId, status: 'DRAFTING' } }),
        this.prisma.closeAiReview.count({ where: { orgId, status: 'RUNNING' } }),
        this.prisma.cfoReport.count({ where: { orgId, aiStatus: 'RUNNING' } }),
      ]),
      Promise.all([
        this.prisma.copilotMessage.findFirst({ where: { orgId, role: 'ASSISTANT' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.collectionDraft.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.bankAiSuggestion.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.closeAiReview.findFirst({ where: { orgId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
        this.prisma.cfoReport.findFirst({ where: { orgId, aiStartedAt: { not: null } }, orderBy: { aiStartedAt: 'desc' }, select: { aiStartedAt: true } }).then((r) => (r ? { createdAt: r.aiStartedAt! } : null)),
      ]),
    ]);
    const n = <T extends { status: string; _count: number }>(rows: T[], ...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r._count, 0);
    const rate = (accepted: number, rejected: number) => (accepted + rejected ? Math.round((accepted * 1000) / (accepted + rejected)) / 10 : null);
    const accuracy: Record<AiAgent, { accepted: number; acceptedWithEdits: number; rejected: number; waiting: number; rate: number | null } | null> = {
      COPILOT: null,
      COLLECTIONS: (() => {
        const accepted = n(drafts, 'SENT', 'SEND_FAILED');
        const acceptedWithEdits = drafts.filter((d) => (d.status === 'SENT' || d.status === 'SEND_FAILED') && d.edited).reduce((s, d) => s + d._count, 0);
        const rejected = n(drafts, 'REJECTED');
        return { accepted, acceptedWithEdits, rejected, waiting: n(drafts, 'READY'), rate: rate(accepted, rejected) };
      })(),
      BANKING: (() => {
        const accepted = n(bank, 'ACCEPTED');
        const rejected = n(bank, 'DISMISSED');
        return { accepted, acceptedWithEdits: 0, rejected, waiting: n(bank, 'READY'), rate: rate(accepted, rejected) };
      })(),
      CLOSE: (() => {
        const accepted = n(adjustments, 'POSTED');
        const rejected = n(adjustments, 'REJECTED');
        return { accepted, acceptedWithEdits: 0, rejected, waiting: n(adjustments, 'READY'), rate: rate(accepted, rejected) };
      })(),
      CFO: null,
    };
    const ids = [settings?.updatedById, ...agentRows.map((a) => a.updatedById), ...priceRows.map((p) => p.updatedById)].filter((x): x is string => !!x);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const lastHour = await this.usage(orgId, new Date(Date.now() - 3_600_000));
    const agents = AGENT_KEYS.map((key, i) => {
      const row = agentRows.find((a) => a.agent === key);
      const hourly = this.hourlyLimit(row?.hourlyTaskLimit ?? null);
      const u = usage[key];
      const limit = row?.monthlyTokenLimit ?? null;
      return {
        key,
        ...AGENTS[key],
        levelLabel: ACTION_LEVELS[AGENTS[key].level],
        enabled: row?.enabled ?? true,
        monthlyTokenLimit: limit,
        // Execution limits (SEC-037).
        hourlyTaskLimit: row?.hourlyTaskLimit ?? null,
        tasksPerHour: { limit: hourly, own: row?.hourlyTaskLimit != null, started: lastHour[key].calls, reached: !!hourly && lastHour[key].calls >= hourly },
        usage: { ...u, failed: failures[i], percentOfBudget: limit ? Math.min(100, Math.round((u.tokens * 1000) / limit) / 10) : null },
        budgetReached: !!limit && u.tokens >= limit,
        cost: costOf(models[key]),
        accuracy: accuracy[key],
        running: running[i],
        lastUsedAt: last[i]?.createdAt.toISOString() ?? null,
        changedBy: row ? (users.get(row.updatedById) ?? 'Former member') : null,
        changedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
    return {
      month,
      accuracyDays: ACCURACY_DAYS,
      configured: ai.model !== null,
      provider: ai.model?.provider ?? 'Anthropic',
      model: ai.modelName,
      source: ai.source,
      enabled: settings?.enabled ?? false,
      stopped: !!settings?.offReason,
      offReason: settings?.offReason ?? null,
      platformShutdown: await this.platformShutdown(),
      modelAccess: await this.modelAccessView(orgId, ai.modelName),
      changedBy: settings ? (users.get(settings.updatedById) ?? 'Former member') : null,
      changedAt: settings?.updatedAt.toISOString() ?? null,
      canManage: hasPermission(member.role, 'org.manage'),
      levels: Object.entries(ACTION_LEVELS).map(([level, label]) => ({ level: +level, label })),
      totals: {
        calls: agents.reduce((s, a) => s + a.usage.calls, 0),
        tokens: agents.reduce((s, a) => s + a.usage.tokens, 0),
        failed: agents.reduce((s, a) => s + a.usage.failed, 0),
        running: agents.reduce((s, a) => s + a.running, 0),
        waiting: agents.reduce((s, a) => s + (a.accuracy?.waiting ?? 0), 0),
        cost: agents.reduce((s, a) => s.plus(a.cost.amount), new D(0)).toFixed(4),
        unpricedTokens: agents.reduce((s, a) => s + a.cost.unpricedTokens, 0),
      },
      currency: 'USD',
      prices: priceRows.map((p) => ({ model: p.model, ...prices.get(p.model)!, changedBy: users.get(p.updatedById) ?? 'Former member', changedAt: p.updatedAt.toISOString() })),
      modelsUsed: [...new Set(AGENT_KEYS.flatMap((k) => models[k].map((m) => m.model)))].sort(),
      agents,
    };
  }

  async updateAgent(member: Member, actor: Actor, agent: AiAgent, input: { enabled: boolean; monthlyTokenLimit: number | null; hourlyTaskLimit?: number | null }) {
    const { orgId } = member;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.aiAgentSetting.findUnique({ where: { orgId_agent: { orgId, agent } } });
      // Left out, the tasks-per-hour limit stays as it was.
      const hourlyTaskLimit = input.hourlyTaskLimit === undefined ? (before?.hourlyTaskLimit ?? null) : input.hourlyTaskLimit;
      const data = { enabled: input.enabled, monthlyTokenLimit: input.monthlyTokenLimit, hourlyTaskLimit, updatedById: actor.id };
      await tx.aiAgentSetting.upsert({ where: { orgId_agent: { orgId, agent } }, create: { orgId, agent, ...data }, update: data });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'ai.agent_updated',
        entityType: 'ai_agent_setting',
        entityId: orgId,
        data: { agent, from: { enabled: before?.enabled ?? true, monthlyTokenLimit: before?.monthlyTokenLimit ?? null, hourlyTaskLimit: before?.hourlyTaskLimit ?? null }, to: { enabled: input.enabled, monthlyTokenLimit: input.monthlyTokenLimit, hourlyTaskLimit } },
      });
    });
    return this.overview(member);
  }

  /**
   * The emergency stop: turns AI off for the whole organisation at once, with a reason. Nothing
   * more is sent to the AI provider; work already running stops before its next model call, and
   * what it had not reached is marked as not done.
   */
  async stop(member: Member, actor: Actor, reason: string) {
    const { orgId } = member;
    const running = (await this.overview(member)).totals.running;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.copilotSettings.findUnique({ where: { orgId } });
      if (before && !before.enabled && before.offReason) throw new DomainError('AI_ALREADY_STOPPED', 'AI is already stopped for this organisation', HttpStatus.CONFLICT);
      const data = { enabled: false, offReason: reason, updatedById: actor.id };
      await tx.copilotSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ai.emergency_stop', entityType: 'copilot_settings', entityId: orgId, data: { reason, wasOn: before?.enabled ?? false, running } });
    });
    return this.overview(member);
  }

  /** Turn AI back on after a stop (or for the first time). */
  async resume(member: Member, actor: Actor) {
    const { orgId } = member;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.copilotSettings.findUnique({ where: { orgId } });
      if (before?.enabled) throw new DomainError('AI_ALREADY_ON', 'AI is already on for this organisation', HttpStatus.CONFLICT);
      const data = { enabled: true, offReason: null, updatedById: actor.id };
      await tx.copilotSettings.upsert({ where: { orgId }, create: { orgId, ...data }, update: data });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'ai.resumed', entityType: 'copilot_settings', entityId: orgId, data: { stoppedFor: before?.offReason ?? null } });
    });
    return this.overview(member);
  }

  // ------------------------------------------------------------------ platform-wide shutdown (SEC-038)

  /** The platform-wide AI shutdown in force, if any: the latest switch is a stop. */
  async platformShutdown(): Promise<{ reason: string; since: string } | null> {
    const last = await this.prisma.platformAiSwitch.findFirst({ orderBy: { createdAt: 'desc' } });
    return last?.action === 'STOPPED' ? { reason: last.reason, since: last.createdAt.toISOString() } : null;
  }

  /** For platform administrators: whether AI is stopped across Talk2Tax, and every stop and resume. */
  async platformStatus() {
    const rows = await this.prisma.platformAiSwitch.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const people = rows.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId))] } }, select: { id: true, name: true } }) : [];
    const name = new Map(people.map((p) => [p.id, p.name]));
    const last = rows[0];
    return {
      stopped: last?.action === 'STOPPED',
      reason: last?.action === 'STOPPED' ? last.reason : null,
      since: last ? last.createdAt.toISOString() : null,
      history: rows.map((r) => ({ id: r.id, action: r.action as 'STOPPED' | 'RESUMED', reason: r.reason, by: name.get(r.actorId) ?? 'Former administrator', at: r.createdAt.toISOString() })),
      models: await this.platformModels(),
    };
  }

  /** The models allowed across Talk2Tax (SEC-034), and every change. */
  private async platformModels() {
    const rows = await this.prisma.platformModelPolicy.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const people = rows.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.actorId))] } }, select: { id: true, name: true } }) : [];
    const name = new Map(people.map((p) => [p.id, p.name]));
    const allowed = rows[0] && rows[0].allowedModels !== null ? modelList(rows[0].allowedModels) : null;
    return {
      limited: allowed !== null,
      available: knownModels(this.config.COPILOT_MODEL).map((m) => ({ ...m, allowed: !allowed || allowed.includes(m.id) })),
      history: rows.map((r) => ({ id: r.id, allowed: r.allowedModels === null ? null : modelList(r.allowedModels), reason: r.reason, by: name.get(r.actorId) ?? 'Former administrator', at: r.createdAt.toISOString() })),
    };
  }

  /** Limit the models allowed across Talk2Tax, or with null allow every model again. */
  async platformSetModels(actor: Actor, allowed: string[] | null, reason: string) {
    const known = knownModels(this.config.COPILOT_MODEL).map((m) => m.id);
    const unknown = (allowed ?? []).filter((m) => !known.includes(m));
    if (unknown.length) throw new DomainError('UNKNOWN_MODEL', `Not a model Talk2Tax offers: ${unknown.join(', ')}`, HttpStatus.UNPROCESSABLE_ENTITY);
    const next = allowed ? [...new Set(allowed)].sort() : null;
    await this.prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const before = await tx.platformModelPolicy.findFirst({ orderBy: { createdAt: 'desc' } });
      await tx.platformModelPolicy.create({ data: { id, allowedModels: next ?? Prisma.DbNull, reason, actorId: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.ai_models_changed', entityType: 'platform_model_policy', entityId: id, data: { from: before && before.allowedModels !== null ? modelList(before.allowedModels) : null, to: next, reason } });
    });
    return this.platformStatus();
  }

  /**
   * Stops AI for every organisation at once. Every agent checks before each model call, so work
   * already running stops too; what it had not reached is marked as not done.
   */
  async platformStop(actor: Actor, reason: string) {
    if (await this.platformShutdown()) throw new DomainError('AI_ALREADY_STOPPED', 'AI is already stopped across Talk2Tax', HttpStatus.CONFLICT);
    await this.platformSwitch(actor, 'STOPPED', reason);
    return this.platformStatus();
  }

  async platformResume(actor: Actor, reason: string) {
    if (!(await this.platformShutdown())) throw new DomainError('AI_NOT_STOPPED', 'AI is not stopped across Talk2Tax', HttpStatus.CONFLICT);
    await this.platformSwitch(actor, 'RESUMED', reason);
    return this.platformStatus();
  }

  private async platformSwitch(actor: Actor, action: 'STOPPED' | 'RESUMED', reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.platformAiSwitch.create({ data: { id, action, reason, actorId: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: action === 'STOPPED' ? 'platform.ai_stopped' : 'platform.ai_resumed', entityType: 'platform_ai_switch', entityId: id, data: { reason } });
    });
  }
}
