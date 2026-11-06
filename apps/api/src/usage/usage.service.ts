import { HttpStatus, Injectable } from '@nestjs/common';
import { allowsOneMore, PlanLimits, recentMonths, usageLevel, usageMonth, usageMonthRange } from '@talk2tax/accounting-engine';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import type { CopilotModel, CopilotRequest, CopilotResponse } from '../copilot/copilot.model';
import { planLimits } from '../billing/limits';

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
  constructor(private readonly prisma: PrismaService) {}

  /** Wraps a model so that each answered call is recorded for the organisation. */
  metered(orgId: string, model: CopilotModel, source: 'ORGANISATION' | 'SERVER'): CopilotModel {
    return {
      provider: model.provider,
      send: async (request: CopilotRequest, options: { signal: AbortSignal }): Promise<CopilotResponse> => {
        const res = await model.send(request, options);
        await this.prisma.usageEvent.create({
          data: { orgId, kind: 'AI_CALL', source, inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
        });
        return res;
      },
    };
  }

  private async count(db: Pick<Tx, 'usageEvent'>, orgId: string, kind: 'AI_CALL' | 'UPLOAD', month = usageMonth(new Date())) {
    const { start, end } = usageMonthRange(month);
    return db.usageEvent.count({ where: { orgId, kind, createdAt: { gte: start, lt: end } } });
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
    return {
      code: AI_CREDITS_USED_UP,
      message: `This organisation has used the ${limit.toLocaleString('en-IN')} AI requests in its ${p!.plan} plan for this month. They start again on the 1st, or choose a larger plan under Settings → Subscription.`,
      status: HttpStatus.TOO_MANY_REQUESTS,
    };
  }

  /** Inside an upload's transaction: refuse it past the plan's monthly limit, otherwise record it. */
  async takeUpload(tx: Tx, orgId: string, bytes: number) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'usage-upload:' + orgId}))`;
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
      this.prisma.$queryRaw<{ month: string; day: string; kind: string; source: string | null; n: bigint; input: bigint; output: bigint; bytes: bigint }[]>`
        SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
               to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
               kind, source, count(*) AS n, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(bytes) AS bytes
        FROM usage_events WHERE org_id = ${orgId}::uuid AND created_at >= ${since}
        GROUP BY 1, 2, 3, 4`,
    ]);
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
        ...usageLevel(sum(ai(month), 'n'), p?.limits.aiCreditsPerMonth ?? null),
        inputTokens: sum(ai(month), 'input'),
        outputTokens: sum(ai(month), 'output'),
        ownKey: sum((r) => ai(month)(r) && r.source === 'ORGANISATION', 'n'),
        talk2taxKey: sum((r) => ai(month)(r) && r.source === 'SERVER', 'n'),
      },
      uploads: { ...usageLevel(sum(up(month), 'n'), p?.limits.documentUploadsPerMonth ?? null), bytes: sum(up(month), 'bytes') },
      days: days.map((d) => ({ day: d, ai: sum((r) => r.kind === 'AI_CALL' && r.day === d, 'n'), uploads: sum((r) => r.kind === 'UPLOAD' && r.day === d, 'n') })),
      history: months.map((m) => ({ month: m, ai: sum(ai(m), 'n'), uploads: sum(up(m), 'n'), tokens: sum(ai(m), 'input') + sum(ai(m), 'output') })),
    };
  }

  /** Every organisation's use in a month against its plan, the fullest first (platform administration). */
  async platform(month = usageMonth(new Date())) {
    const { start, end } = usageMonthRange(month);
    return this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const [rows, orgs] = await Promise.all([
          tx.usageEvent.groupBy({ by: ['orgId', 'kind'], where: { createdAt: { gte: start, lt: end } }, _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, bytes: true } }),
          tx.organization.findMany({ select: { id: true, name: true, countryCode: true, isDemo: true, subscription: { select: { status: true, plan: { select: { name: true, limits: true } } } } } }),
        ]);
        const of = (orgId: string, kind: string) => rows.find((r) => r.orgId === orgId && r.kind === kind);
        const list = orgs
          .map((o) => {
            const limits = (o.subscription?.plan.limits ?? null) as PlanLimits | null;
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
