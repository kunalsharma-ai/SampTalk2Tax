import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import { AiAgent } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AppConfig, CONFIG } from '../config';
import { CopilotModel } from '../copilot/copilot.model';
import { todayIst } from '../tasks/tasks.service';
import { UsageService } from '../usage/usage.service';

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

export type AgentBlock = { code: 'AI_NOT_CONFIGURED' | 'AI_OFF' | 'AGENT_OFF' | 'AI_BUDGET_REACHED' | 'AI_CREDITS_USED_UP'; message: string; status: HttpStatus };

/** The start of the current calendar month in India time, as an instant. */
export function monthStartIst(now: Date = new Date()): { month: string; since: Date } {
  const month = todayIst(now).slice(0, 7);
  return { month, since: new Date(`${month}-01T00:00:00+05:30`) };
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
  async check(orgId: string, agent: AiAgent): Promise<AgentBlock | null> {
    if (!(await this.integrations.ai(orgId)).model) return { code: 'AI_NOT_CONFIGURED', message: 'AI is not set up: an owner or admin can add a Claude API key in Settings → Integrations. Nothing was sent anywhere.', status: HttpStatus.SERVICE_UNAVAILABLE };
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
    if (a?.monthlyTokenLimit) {
      const used = (await this.usage(orgId))[agent].tokens;
      if (used >= a.monthlyTokenLimit) {
        return { code: 'AI_BUDGET_REACHED', message: `The ${AGENTS[agent].name.toLowerCase()} has used its ${a.monthlyTokenLimit.toLocaleString('en-IN')} tokens for this month. An owner or admin can raise the budget in the AI control center.`, status: HttpStatus.TOO_MANY_REQUESTS };
      }
    }
    // The plan's AI requests for the month, shared by every agent.
    return this.metering.aiBlock(orgId);
  }

  async assert(orgId: string, agent: AiAgent) {
    const b = await this.check(orgId, agent);
    if (b) throw new DomainError(b.code, b.message, b.status);
  }

  /** The error stored on work that was waiting when a check started failing. */
  /** For an agent's own page: why it cannot run when that is the stop, its switch or its budget (not simply AI never turned on). */
  async notice(orgId: string, agent: AiAgent): Promise<{ code: AgentBlock['code']; message: string } | null> {
    const b = await this.check(orgId, agent);
    if (!b || b.code === 'AI_NOT_CONFIGURED') return null;
    if (b.code === 'AI_OFF' && !b.message.startsWith('AI was stopped')) return null;
    return { code: b.code, message: b.message };
  }

  static stoppedError(b: AgentBlock): { errorCode: string; errorMessage: string } {
    const code = b.code === 'AI_OFF' ? 'AI_STOPPED' : b.code;
    return { errorCode: code, errorMessage: `Not done: ${b.message}` };
  }

  // ------------------------------------------------------------------ the control center

  async overview(member: Member) {
    const ai = await this.integrations.ai(member.orgId);
    const { orgId } = member;
    const { month, since } = monthStartIst();
    const accuracySince = new Date(Date.now() - ACCURACY_DAYS * 86_400_000);
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
    const ids = [settings?.updatedById, ...agentRows.map((a) => a.updatedById)].filter((x): x is string => !!x);
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const agents = AGENT_KEYS.map((key, i) => {
      const row = agentRows.find((a) => a.agent === key);
      const u = usage[key];
      const limit = row?.monthlyTokenLimit ?? null;
      return {
        key,
        ...AGENTS[key],
        levelLabel: ACTION_LEVELS[AGENTS[key].level],
        enabled: row?.enabled ?? true,
        monthlyTokenLimit: limit,
        usage: { ...u, failed: failures[i], percentOfBudget: limit ? Math.min(100, Math.round((u.tokens * 1000) / limit) / 10) : null },
        budgetReached: !!limit && u.tokens >= limit,
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
      },
      agents,
    };
  }

  async updateAgent(member: Member, actor: Actor, agent: AiAgent, input: { enabled: boolean; monthlyTokenLimit: number | null }) {
    const { orgId } = member;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.aiAgentSetting.findUnique({ where: { orgId_agent: { orgId, agent } } });
      const data = { enabled: input.enabled, monthlyTokenLimit: input.monthlyTokenLimit, updatedById: actor.id };
      await tx.aiAgentSetting.upsert({ where: { orgId_agent: { orgId, agent } }, create: { orgId, agent, ...data }, update: data });
      await this.audit.append(tx, {
        orgId,
        actorId: actor.id,
        action: 'ai.agent_updated',
        entityType: 'ai_agent_setting',
        entityId: orgId,
        data: { agent, from: { enabled: before?.enabled ?? true, monthlyTokenLimit: before?.monthlyTokenLimit ?? null }, to: { enabled: input.enabled, monthlyTokenLimit: input.monthlyTokenLimit } },
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
}
