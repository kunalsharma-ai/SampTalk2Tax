import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { allowsOneMore, PlanLimits, recentMonths, usageLevel, usageMonth, usageMonthRange } from '@talk2tax/accounting-engine';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { createHash } from 'node:crypto';
import { agentForRequest, dataSourcesFor, explanationFor, promptText, reasoningWithheld, toolsText, type AiRequestShape, type AiResponseShape } from '@talk2tax/accounting-engine';
import type { AiCallOptions, CopilotModel, CopilotRequest, CopilotResponse } from '../copilot/copilot.model';
import { DocumentStoreService } from '../common/document-store.service';
import { runInOrg } from '../common/tenant-context';
import { aiDecisionRecords } from '../db/collections/ai-decision-records';
import { planLimits } from '../billing/limits';
import { lockName } from '../db/locks';
import { AiCreditsService } from '../billing/ai-credits.service';
import { contractLimits, type BillingCurrency } from '@talk2tax/accounting-engine';

export const UPLOAD_LIMIT_REACHED = 'UPLOAD_LIMIT_REACHED';
export const AI_CREDITS_USED_UP = 'AI_CREDITS_USED_UP';

/**
 * Usage metering (M9 slice 5). Every answered call to the AI model and every stored upload is
 * one row in usage_events; the plan's monthly limits (calendar month, India time) are checked
 * against those rows: AI before each model call (through the AI control center's check), uploads
 * inside the upload's own transaction under a per-organisation lock.
 */
@Injectable()
export class UsageService {
  private readonly log = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: AiCreditsService,
    private readonly store: DocumentStoreService,
  ) {}

  /**
   * Wraps a model so that each answered call is recorded for the organisation, and every call,
   * answered or failed, gets a decision record in the explainable AI ledger (AUDIT-018 and others).
   */
  metered(orgId: string, model: CopilotModel, source: 'ORGANISATION' | 'SERVER'): CopilotModel {
    return {
      provider: model.provider,
      send: async (request: CopilotRequest, options: AiCallOptions): Promise<CopilotResponse> => {
        const startedAt = new Date();
        let res: CopilotResponse;
        try {
          res = await model.send(request, options);
        } catch (e) {
          await this.decisionRecord(orgId, source, request, options, startedAt, null, e);
          throw e;
        }
        await this.decisionRecord(orgId, source, request, options, startedAt, res, null);
        // Past the plan's requests for the month, the request comes from a bought pack (SUBS-018).
        const creditGrantId = await this.creditFor(orgId);
        await this.prisma.usageEvent.create({
          data: { orgId, kind: 'AI_CALL', source, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0, creditGrantId },
        });
        return res;
      },
    };
  }

  /**
   * Writes one call's decision record. It holds the agent and who it acted for, fingerprints of
   * the prompt and tools, the data given, the timing and the model's own short explanation; the
   * model's hidden reasoning is never copied (AUDIT-029). A failure to write it is logged and does
   * not undo the call.
   */
  private async decisionRecord(orgId: string, keySource: 'ORGANISATION' | 'SERVER', request: CopilotRequest, options: AiCallOptions, startedAt: Date, res: CopilotResponse | null, error: unknown) {
    const req = request as unknown as AiRequestShape;
    const out = res as unknown as AiResponseShape | null;
    const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
    const completedAt = new Date();
    const user = (request.metadata as { user_id?: unknown } | undefined)?.user_id;
    try {
      const agent = agentForRequest(req, options.record?.agent);
      await runInOrg(orgId, () =>
        this.store.collection(aiDecisionRecords).insertOne({
          agent,
          actingForUserId: typeof user === 'string' ? user : null,
          keySource,
          modelRequested: String(request.model),
          servedModel: res?.model ?? null,
          promptVersion: hash(promptText(req)),
          toolsVersion: hash(toolsText(req)),
          toolNames: (request.tools ?? []).map((t) => ('name' in t && typeof t.name === 'string' ? t.name : 'tool')).slice(0, 100),
          dataSources: dataSourcesFor(req, options.record?.sources),
          subjectType: options.record?.subject?.type ?? null,
          subjectId: options.record?.subject?.id ?? null,
          // A member's copilot answers stay private to them: only the fact of the answer is kept.
          explanation: out ? explanationFor(out, { privateText: agent === 'COPILOT' }) : null,
          reasoningWithheld: out ? reasoningWithheld(out) : false,
          stopReason: res?.stop_reason ?? null,
          outcome: res ? 'ANSWERED' : 'FAILED',
          errorName: res ? null : error instanceof Error ? error.constructor.name.slice(0, 80) : 'Error',
          inputTokens: res ? res.usage.input_tokens + (res.usage.cache_creation_input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) : 0,
          outputTokens: res?.usage.output_tokens ?? 0,
          startedAt,
          completedAt,
          durationMs: completedAt.getTime() - startedAt.getTime(),
        }),
      );
    } catch (e) {
      this.log.error(`Could not write the AI decision record for ${orgId}`, e instanceof Error ? e.stack : String(e));
    }
  }

  /** A month's uploads, or its AI requests counted against the plan (not those from bought packs). */
  private async count(db: Pick<Tx, 'usageEvent'>, orgId: string, kind: 'AI_CALL' | 'UPLOAD', month = usageMonth(new Date())) {
    const { start, end } = usageMonthRange(month);
    return db.usageEvent.count({ where: { orgId, kind, createdAt: { gte: start, lt: end }, ...(kind === 'AI_CALL' ? { creditGrantId: null } : {}) } });
  }

  /** The bought pack an AI request answered now comes from: null while the plan's requests last, or when none is left. */
  private async creditFor(orgId: string): Promise<string | null> {
    const limit = (await this.limits(orgId))?.limits.aiCreditsPerMonth ?? null;
    if (limit === null || (await this.count(this.prisma, orgId, 'AI_CALL')) < limit) return null;
    return this.credits.next(this.prisma, orgId);
  }

  private async limits(orgId: string): Promise<{ plan: string; limits: PlanLimits } | null> {
    return this.prisma.$transaction(async (tx) => planLimits(tx, orgId));
  }

  /** Why no more AI calls are allowed this month, or null. */
  async aiBlock(orgId: string): Promise<{ code: typeof AI_CREDITS_USED_UP; message: string; status: HttpStatus } | null> {
    const p = await this.limits(orgId);
    const limit = p?.limits.aiCreditsPerMonth ?? null;
    if (limit === null) return null;
    const used = await this.count(this.prisma, orgId, 'AI_CALL');
    if (allowsOneMore(used, limit)) return null;
    if ((await this.credits.balance(this.prisma, orgId)) > 0) return null;
    return {
      code: AI_CREDITS_USED_UP,
      message: `This organisation has used the ${limit.toLocaleString('en-IN')} AI requests in its ${p!.plan} plan for this month${limit > 0 ? ' and any extra requests it bought' : ''}. They start again on the 1st; until then, buy more AI requests under Governance → Usage, or choose a larger plan under Settings → Subscription.`,
      status: HttpStatus.TOO_MANY_REQUESTS,
    };
  }

  /** Inside an upload's transaction: refuse it past the plan's monthly limit, otherwise record it. */
  async takeUpload(tx: Tx, orgId: string, bytes: number) {
    await lockName(tx, 'usage-upload:' + orgId);
    const p = await planLimits(tx, orgId);
    const limit = p?.limits.documentUploadsPerMonth ?? null;
    if (limit !== null) {
      const used = await this.count(tx, orgId, 'UPLOAD');
      if (!allowsOneMore(used, limit)) {
        throw new DomainError(UPLOAD_LIMIT_REACHED, `This organisation has used the ${limit.toLocaleString('en-IN')} uploads in its ${p!.plan} plan for this month. They start again on the 1st, or choose a larger plan under Settings → Subscription.`, HttpStatus.TOO_MANY_REQUESTS, { limit, used });
      }
    }
    await tx.usageEvent.create({ data: { orgId, kind: 'UPLOAD', bytes } });
  }

  /** This month against the plan, the days of this month, and the months before. */
  async summary(orgId: string, now = new Date()) {
    const month = usageMonth(now);
    const months = recentMonths(month, 6);
    const since = usageMonthRange(months[months.length - 1]!).start;
    const [p, rows] = await Promise.all([
      this.limits(orgId),
      this.prisma.usageEvent.findMany({ where: { orgId, createdAt: { gte: since } }, select: { kind: true, source: true, inputTokens: true, outputTokens: true, bytes: true, createdAt: true, creditGrantId: true } }).then((events) => {
        // Grouped by India month and day, kind and source.
        const out = new Map<string, { month: string; day: string; kind: string; source: string | null; extra: boolean; n: number; input: number; output: number; bytes: number }>();
        for (const e of events) {
          const day = new Date(e.createdAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
          const extra = !!e.creditGrantId;
          const k = `${day}|${e.kind}|${e.source ?? ''}|${extra}`;
          const r = out.get(k) ?? { month: day.slice(0, 7), day, kind: e.kind, source: e.source, extra, n: 0, input: 0, output: 0, bytes: 0 };
          out.set(k, { ...r, n: r.n + 1, input: r.input + e.inputTokens, output: r.output + e.outputTokens, bytes: r.bytes + e.bytes });
        }
        return [...out.values()];
      }),
    ]);
    // Extra AI requests (SUBS-018): what is left of the packs bought, and the packs on offer.
    const sub = await this.prisma.subscription.findUnique({ where: { orgId }, select: { currency: true } });
    const credits = sub ? await this.credits.forOrg(orgId, sub.currency as BillingCurrency, now) : null;
    const sum = (f: (r: (typeof rows)[number]) => boolean, k: 'n' | 'input' | 'output' | 'bytes') => rows.filter(f).reduce((a, r) => a + Number(r[k]), 0);
    const ai = (m: string) => (r: (typeof rows)[number]) => r.kind === 'AI_CALL' && r.month === m;
    const up = (m: string) => (r: (typeof rows)[number]) => r.kind === 'UPLOAD' && r.month === m;
    const { start, end } = usageMonthRange(month);
    // Every day of the month, so the chart keeps its scale; days still to come read 0.
    const days = Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86_400_000) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
    return {
      month,
      resetsAt: end,
      plan: p?.plan ?? null,
      ai: {
        // Against the plan: the requests that came from bought packs are counted apart, as extra.
        ...usageLevel(sum((r) => ai(month)(r) && !r.extra, 'n'), p?.limits.aiCreditsPerMonth ?? null),
        extra: sum((r) => ai(month)(r) && r.extra, 'n'),
        inputTokens: sum(ai(month), 'input'),
        outputTokens: sum(ai(month), 'output'),
        ownKey: sum((r) => ai(month)(r) && r.source === 'ORGANISATION', 'n'),
        talk2taxKey: sum((r) => ai(month)(r) && r.source === 'SERVER', 'n'),
      },
      uploads: { ...usageLevel(sum(up(month), 'n'), p?.limits.documentUploadsPerMonth ?? null), bytes: sum(up(month), 'bytes') },
      credits,
      days: days.map((d) => ({ day: d, ai: sum((r) => r.kind === 'AI_CALL' && r.day === d, 'n'), uploads: sum((r) => r.kind === 'UPLOAD' && r.day === d, 'n') })),
      history: months.map((m) => ({ month: m, ai: sum(ai(m), 'n'), uploads: sum(up(m), 'n'), tokens: sum(ai(m), 'input') + sum(ai(m), 'output') })),
    };
  }

  /** Every organisation's use in a month against its plan, the fullest first (platform administration). */
  async platform(month = usageMonth(new Date())) {
    const { start, end } = usageMonthRange(month);
    return this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const [rows, orgs, contracts] = await Promise.all([
          tx.usageEvent.groupBy({ by: ['orgId', 'kind'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, bytes: true } }),
          tx.organization.findMany({ select: { id: true, name: true, countryCode: true, isDemo: true, subscription: { select: { status: true, plan: { select: { name: true, limits: true } } } } } }),
          // Enterprise contracts in force (SUBS-023) set their own limits.
          tx.enterpriseContract.findMany({ where: { status: 'ACTIVE' }, select: { orgId: true, limits: true } }),
        ]);
        const of = (orgId: string, kind: string) => rows.find((r) => r.orgId === orgId && r.kind === kind);
        const list = orgs
          .map((o) => {
            const planOnly = (o.subscription?.plan.limits ?? null) as PlanLimits | null;
            const contract = contracts.find((c) => c.orgId === o.id);
            const limits = planOnly && contract ? contractLimits(planOnly, contract.limits as Partial<Record<keyof PlanLimits, number>>) : planOnly;
            const a = of(o.id, 'AI_CALL');
            const u = of(o.id, 'UPLOAD');
            return {
              org: { id: o.id, name: o.name, countryCode: o.countryCode, isDemo: o.isDemo },
              plan: o.subscription ? { name: o.subscription.plan.name, status: o.subscription.status } : null,
              ai: { ...usageLevel(a?._count._all ?? 0, limits?.aiCreditsPerMonth ?? null), tokens: (a?._sum.inputTokens ?? 0) + (a?._sum.outputTokens ?? 0) },
              uploads: { ...usageLevel(u?._count._all ?? 0, limits?.documentUploadsPerMonth ?? null), bytes: u?._sum.bytes ?? 0 },
            };
          })
          .filter((r) => r.ai.used > 0 || r.uploads.used > 0)
          .sort((x, y) => Math.max(y.ai.percent ?? 0, y.uploads.percent ?? 0) - Math.max(x.ai.percent ?? 0, x.uploads.percent ?? 0) || y.ai.used - x.ai.used);
        const total = (kind: string) => rows.filter((r) => r.kind === kind);
        return {
          month,
          months: recentMonths(usageMonth(new Date()), 12),
          totals: {
            aiCalls: total('AI_CALL').reduce((s, r) => s + r._count._all, 0),
            tokens: total('AI_CALL').reduce((s, r) => s + (r._sum.inputTokens ?? 0) + (r._sum.outputTokens ?? 0), 0),
            uploads: total('UPLOAD').reduce((s, r) => s + r._count._all, 0),
            bytes: total('UPLOAD').reduce((s, r) => s + (r._sum.bytes ?? 0), 0),
            atLimit: list.filter((r) => r.ai.state === 'REACHED' || r.uploads.state === 'REACHED').length,
            nearLimit: list.filter((r) => r.ai.state === 'NEAR' || r.uploads.state === 'NEAR').length,
          },
          organisations: list,
        };
      }),
      // Every organisation on the platform: more than the default 5 seconds once there are many.
      { timeout: 30_000 },
    );
  }

  /** For the month query parameter: a valid YYYY-MM or an error. */
  static month(m: string | undefined): string | undefined {
    if (m === undefined) return undefined;
    try {
      usageMonthRange(m);
      return m;
    } catch {
      throw new DomainError('INVALID_MONTH', 'A month is written YYYY-MM', HttpStatus.BAD_REQUEST);
    }
  }
}
