import { HttpStatus, Injectable } from '@nestjs/common';
import {
  BENCHMARK_INDUSTRIES,
  BENCHMARK_METRICS,
  BENCHMARK_SIZE_BANDS,
  benchmarkMetrics,
  comparePeers,
  D,
  MIN_PEERS,
  MIN_PEERS_FOR_QUARTILES,
  minorUnits,
  monthLabel,
  sizeBandFor,
  type BenchmarkIndustry,
  type BenchmarkMetricKey,
  type BenchmarkMetricValue,
  type BenchmarkSizeBand,
  type PeerContribution,
} from '@talk2tax/accounting-engine';
import type { RoleName } from '@talk2tax/security';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { todayIst } from '../cash-flow/cash-flow.service';
import { toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess, type Tx } from '../common/prisma.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { KpisService } from '../kpis/kpis.service';

type Actor = { id: string };
export interface BenchOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

/** Version of the consent wording below. Raising it asks every participant to agree again. */
export const CONSENT_VERSION = 1;
export const CONSENT_TEXT = [
  'Talk2Tax adds the metrics you choose, worked out from your posted books, to an anonymous pool together with your industry, size band, country and currency.',
  'The pool holds no organisation name, no amounts and no records: only rounded ratios under a random key.',
  `Other participants only ever see the median of at least ${MIN_PEERS} participants, and the quartiles of at least ${MIN_PEERS_FOR_QUARTILES}; smaller groups are suppressed.`,
  'You can withdraw at any time. Your contribution is deleted from the pool straight away.',
];
/** Contributions older than this many months are left out of comparisons. */
const FRESH_MONTHS = 3;

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const monthEnd = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);

export interface JoinInput {
  industry: BenchmarkIndustry;
  sizeBand: BenchmarkSizeBand;
  headcount: number | null;
  metrics: BenchmarkMetricKey[];
  consent: true;
}

/**
 * Privacy-preserving benchmarking. An organisation's own metrics are always shown to it. Comparing
 * them needs it to opt in and share them ("give to get"): its rounded ratios go into a pool with no
 * organisation id, under a random key kept only on its own participation row, and comparisons come
 * back as medians and quartiles over at least five other participants. Withdrawing deletes the
 * contribution. Demo organisations are compared only with the clearly labelled synthetic pool.
 */
@Injectable()
export class BenchmarkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kpis: KpisService,
    private readonly dimensions: DimensionsService,
  ) {}

  private lastMonth() {
    return shiftMonth(todayIst().slice(0, 7), -1);
  }

  /** Active employees in payroll at the end of a month. */
  private async payrollHeadcount(orgId: string, month: string) {
    const end = toDbDate(monthEnd(month));
    return this.prisma.employee.count({ where: { orgId, dateOfJoining: { lte: end }, OR: [{ dateOfLeaving: null }, { dateOfLeaving: { gt: end } }] } });
  }

  /** This organisation's ten metrics for the last complete month. */
  async metrics(org: BenchOrg, enteredHeadcount: number | null) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    const month = this.lastMonth();
    const scale = minorUnits(o.functionalCurrency);
    const months = await this.kpis.monthFigures(org.id, month, monthEnd(month), 24);
    const payroll = await this.payrollHeadcount(org.id, month);
    const from = `${shiftMonth(month, -11)}-01`;
    const p = await this.dimensions.profit({ id: org.id, functionalCurrency: o.functionalCurrency, role: org.role }, { type: 'PROJECT', from, to: monthEnd(month), includeInactive: true });
    const rev = p.sections.find((s) => s.type === 'REVENUE');
    const tagged = p.columns.map((c, i) => ({ c, i })).filter(({ c }) => c.code !== null);
    const projects = tagged.length
      ? { revenue: tagged.reduce((t, { i }) => t.plus(rev?.totals[i] ?? 0), new D(0)).toFixed(scale), net: tagged.reduce((t, { i }) => t.plus(p.netProfit[i] ?? 0), new D(0)).toFixed(scale) }
      : null;
    const headcount = payroll > 0 ? payroll : enteredHeadcount;
    return {
      month,
      from,
      to: monthEnd(month),
      currency: o.functionalCurrency,
      countryCode: o.countryCode,
      isDemo: o.isDemo,
      headcount,
      headcountSource: payroll > 0 ? ('PAYROLL' as const) : enteredHeadcount ? ('ENTERED' as const) : null,
      values: benchmarkMetrics({ months, headcount, projects }, scale),
    };
  }

  private serializeParticipation(p: Awaited<ReturnType<PrismaService['benchmarkParticipation']['findUnique']>>) {
    if (!p) return null;
    return {
      status: p.status,
      industry: p.industry,
      sizeBand: p.sizeBand,
      headcount: p.headcount,
      sharedMetrics: p.sharedMetrics,
      consentVersion: p.consentVersion,
      consentCurrent: p.consentVersion === CONSENT_VERSION,
      contributedPeriod: p.contributedPeriod,
      contributedAt: p.contributedAt?.toISOString() ?? null,
      consentedById: p.consentedById,
      consentedAt: p.consentedAt.toISOString(),
      withdrawnAt: p.withdrawnAt?.toISOString() ?? null,
    };
  }

  /** Writes (or replaces) this organisation's row in the pool. Only the shared, rounded ratios go in. */
  private async contribute(tx: Tx, key: string, profile: { industry: string; sizeBand: string; countryCode: string; currency: string; isDemo: boolean }, period: string, values: BenchmarkMetricValue[], shared: string[]) {
    const metrics = Object.fromEntries(values.filter((v) => v.value !== null && shared.includes(v.key)).map((v) => [v.key, v.value]));
    await withSystemAccess(tx, async () => {
      await tx.benchmarkContribution.upsert({
        where: { participantKey: key },
        create: { participantKey: key, period, industry: profile.industry, sizeBand: profile.sizeBand, countryCode: profile.countryCode, currency: profile.currency, isSynthetic: profile.isDemo, metrics },
        update: { period, industry: profile.industry, sizeBand: profile.sizeBand, countryCode: profile.countryCode, currency: profile.currency, isSynthetic: profile.isDemo, metrics },
      });
    });
    return Object.keys(metrics).length;
  }

  /** Other participants' recent contributions, from the same pool (real or synthetic). Never sent to the client. */
  private async peers(ownKey: string | null, synthetic: boolean, month: string): Promise<PeerContribution[]> {
    const rows = await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () =>
        tx.benchmarkContribution.findMany({ where: { isSynthetic: synthetic, period: { gte: shiftMonth(month, -(FRESH_MONTHS - 1)) }, ...(ownKey ? { participantKey: { not: ownKey } } : {}) } }),
      ),
    );
    return rows.map((r) => ({ industry: r.industry as BenchmarkIndustry, sizeBand: r.sizeBand as BenchmarkSizeBand, countryCode: r.countryCode, currency: r.currency, metrics: r.metrics as PeerContribution['metrics'] }));
  }

  /**
   * The benchmarking page: this organisation's metrics, its participation and, when it takes part,
   * the comparison. A participant whose contribution is from an earlier month is brought up to date
   * first, so the pool follows the books.
   */
  async overview(org: BenchOrg) {
    let p = await this.prisma.benchmarkParticipation.findUnique({ where: { orgId: org.id } });
    const own = await this.metrics(org, p?.headcount ?? null);
    if (p?.status === 'OPTED_IN' && p.contributedPeriod !== own.month) {
      const key = p.participantKey!;
      const shared = p.sharedMetrics;
      p = await this.prisma.$transaction(async (tx) => {
        await this.contribute(tx, key, { industry: p!.industry, sizeBand: p!.sizeBand, countryCode: own.countryCode, currency: own.currency, isDemo: own.isDemo }, own.month, own.values, shared);
        return tx.benchmarkParticipation.update({ where: { orgId: org.id }, data: { contributedPeriod: own.month, contributedAt: new Date() } });
      });
    }
    const participating = p?.status === 'OPTED_IN';
    const comparison = participating
      ? comparePeers(
          { industry: p!.industry as BenchmarkIndustry, sizeBand: p!.sizeBand as BenchmarkSizeBand, countryCode: own.countryCode, currency: own.currency },
          own.values,
          p!.sharedMetrics as BenchmarkMetricKey[],
          await this.peers(p!.participantKey, own.isDemo, own.month),
        )
      : null;
    return {
      period: { month: own.month, label: monthLabel(own.month), from: own.from, to: own.to },
      currency: own.currency,
      countryCode: own.countryCode,
      pool: own.isDemo ? ('SYNTHETIC' as const) : ('LIVE' as const),
      headcount: own.headcount,
      headcountSource: own.headcountSource,
      suggestedSizeBand: own.headcount ? sizeBandFor(own.headcount) : null,
      participation: this.serializeParticipation(p),
      metrics: own.values,
      comparison,
      methodology: {
        definitions: BENCHMARK_METRICS,
        industries: BENCHMARK_INDUSTRIES,
        sizeBands: BENCHMARK_SIZE_BANDS,
        minPeers: MIN_PEERS,
        minPeersForQuartiles: MIN_PEERS_FOR_QUARTILES,
        freshMonths: FRESH_MONTHS,
        consentVersion: CONSENT_VERSION,
        consentText: CONSENT_TEXT,
      },
    };
  }

  /** Opt in, or change what is shared. Each time the organisation joins it gets a new random key. */
  async join(org: BenchOrg, actor: Actor, b: JoinInput) {
    if (!b.metrics.length) throw new DomainError('NO_METRICS', 'Choose at least one metric to share');
    const before = await this.prisma.benchmarkParticipation.findUnique({ where: { orgId: org.id } });
    const own = await this.metrics(org, b.headcount);
    const shared = BENCHMARK_METRICS.map((m) => m.key).filter((k) => b.metrics.includes(k));
    const rejoin = before?.status !== 'OPTED_IN';
    const key = rejoin ? randomUUID() : before!.participantKey!;
    const now = new Date();
    const consentChanged = rejoin || before!.consentVersion !== CONSENT_VERSION;
    await this.prisma.$transaction(async (tx) => {
      const data = {
        status: 'OPTED_IN' as const,
        industry: b.industry,
        sizeBand: b.sizeBand,
        headcount: b.headcount,
        sharedMetrics: shared,
        participantKey: key,
        contributedPeriod: own.month,
        contributedAt: now,
        ...(consentChanged ? { consentVersion: CONSENT_VERSION, consentedById: actor.id, consentedAt: now } : {}),
        withdrawnById: null,
        withdrawnAt: null,
      };
      await tx.benchmarkParticipation.upsert({
        where: { orgId: org.id },
        create: { orgId: org.id, ...data, consentVersion: CONSENT_VERSION, consentedById: actor.id, consentedAt: now },
        update: data,
      });
      const contributed = await this.contribute(tx, key, { industry: b.industry, sizeBand: b.sizeBand, countryCode: own.countryCode, currency: own.currency, isDemo: own.isDemo }, own.month, own.values, shared);
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: rejoin ? 'benchmark.opted_in' : 'benchmark.updated',
        entityType: 'benchmark_participation',
        entityId: org.id,
        data: { industry: b.industry, sizeBand: b.sizeBand, sharedMetrics: shared, consentVersion: CONSENT_VERSION, metricsContributed: contributed, period: own.month, ...(rejoin ? {} : { before: { industry: before!.industry, sizeBand: before!.sizeBand, sharedMetrics: before!.sharedMetrics } }) },
      });
    });
    return this.overview(org);
  }

  /** Re-read the books now and replace the contribution. */
  async refresh(org: BenchOrg, actor: Actor) {
    const p = await this.prisma.benchmarkParticipation.findUnique({ where: { orgId: org.id } });
    if (p?.status !== 'OPTED_IN') throw new DomainError('NOT_PARTICIPATING', 'This organisation does not take part in benchmarking', HttpStatus.CONFLICT);
    const own = await this.metrics(org, p.headcount);
    await this.prisma.$transaction(async (tx) => {
      const n = await this.contribute(tx, p.participantKey!, { industry: p.industry, sizeBand: p.sizeBand, countryCode: own.countryCode, currency: own.currency, isDemo: own.isDemo }, own.month, own.values, p.sharedMetrics);
      await tx.benchmarkParticipation.update({ where: { orgId: org.id }, data: { contributedPeriod: own.month, contributedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'benchmark.refreshed', entityType: 'benchmark_participation', entityId: org.id, data: { period: own.month, metricsContributed: n } });
    });
    return this.overview(org);
  }

  /** Withdraw: the contribution is deleted from the pool and the key forgotten. */
  async withdraw(org: BenchOrg, actor: Actor) {
    const p = await this.prisma.benchmarkParticipation.findUnique({ where: { orgId: org.id } });
    if (p?.status !== 'OPTED_IN') throw new DomainError('NOT_PARTICIPATING', 'This organisation does not take part in benchmarking', HttpStatus.CONFLICT);
    await this.prisma.$transaction(async (tx) => {
      const deleted = await withSystemAccess(tx, async () => (await tx.benchmarkContribution.deleteMany({ where: { participantKey: p.participantKey! } })).count);
      await tx.benchmarkParticipation.update({ where: { orgId: org.id }, data: { status: 'WITHDRAWN', participantKey: null, contributedPeriod: null, contributedAt: null, withdrawnById: actor.id, withdrawnAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'benchmark.withdrawn', entityType: 'benchmark_participation', entityId: org.id, data: { contributionsDeleted: deleted } });
    });
    return this.overview(org);
  }

  /**
   * Fills the synthetic demonstration pool, which only demo organisations are compared with. The
   * values are generated, not anyone's books, and every row is marked synthetic. Refused in production.
   */
  async seedSyntheticPeers(count: number, month = this.lastMonth(), seed = 7) {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const between = (lo: number, hi: number, places: number) => new D(lo + (hi - lo) * rnd()).toFixed(places);
    const industries = ['WHOLESALE', 'WHOLESALE', 'WHOLESALE', 'RETAIL', 'MANUFACTURING', 'PROFESSIONAL_SERVICES', 'SOFTWARE', 'LOGISTICS'];
    const sizes = ['SMALL', 'SMALL', 'MICRO', 'MEDIUM'];
    const rows = Array.from({ length: count }, () => {
      const industry = industries[Math.floor(rnd() * industries.length)]!;
      const sizeBand = sizes[Math.floor(rnd() * sizes.length)]!;
      const metrics: Record<string, string> = {
        GROSS_MARGIN: between(18, 55, 1),
        NET_MARGIN: between(-6, 18, 1),
        REVENUE_GROWTH: between(-12, 35, 1),
        OPEX_RATIO: between(12, 45, 1),
        DSO: between(22, 85, 0),
        DPO: between(20, 70, 0),
        WORKING_CAPITAL_DAYS: between(10, 95, 0),
        REVENUE_PER_EMPLOYEE: between(1500000, 9000000, 0),
        CASH_CONVERSION_CYCLE: between(5, 110, 0),
      };
      if (rnd() < 0.6) metrics.PROJECT_MARGIN = between(-5, 35, 1);
      return { participantKey: randomUUID(), period: month, industry, sizeBand, countryCode: 'IN', currency: 'INR', isSynthetic: true, metrics };
    });
    return this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        await tx.benchmarkContribution.deleteMany({ where: { isSynthetic: true, participantKey: { notIn: (await tx.benchmarkParticipation.findMany({ where: { participantKey: { not: null } }, select: { participantKey: true } })).map((p) => p.participantKey!) } } });
        return (await tx.benchmarkContribution.createMany({ data: rows })).count;
      }),
    );
  }
}
