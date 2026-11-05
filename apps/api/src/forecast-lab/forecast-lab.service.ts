import { HttpStatus, Injectable } from '@nestjs/common';
import {
  accuracy,
  addMonths,
  backtest,
  D,
  type ErrorPoint,
  forecastAhead,
  LAB_HORIZONS,
  LAB_MODELS,
  LAB_SERIES,
  type LabModel,
  type LabSeries,
  minorUnits,
  type MonthFigures,
  seriesValue,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { KpisService } from '../kpis/kpis.service';

type Actor = { id: string };
type Forecast = { series: LabSeries; model: LabModel; month: string; horizon: number; value: string };
/** How many months of books the lab reads at most. */
const HISTORY_MONTHS = 36;

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
const fl = (n: number) => `FL-${String(n).padStart(4, '0')}`;

/**
 * The forecast evaluation lab. Backtests are worked out from the posted books every time; a saved
 * run keeps what each model forecast for the next three months, and is measured against the
 * books once those months are over. Reading needs reports.read; saving needs budgets.manage.
 */
@Injectable()
export class ForecastLabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly kpis: KpisService,
  ) {}

  private async scale(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return { currency: o.functionalCurrency, scale: minorUnits(o.functionalCurrency) };
  }

  /** Monthly figures up to the last complete month, without the empty months before the books start. */
  private async history(orgId: string) {
    const last = addMonths(todayIso().slice(0, 7), -1);
    const all = await this.kpis.monthFigures(orgId, last, monthEnd(last), HISTORY_MONTHS);
    const active = (m: MonthFigures) => LAB_SERIES.some((s) => !seriesValue(m, s.key).isZero());
    const start = all.findIndex(active);
    return { last, months: start < 0 ? [] : all.slice(start) };
  }

  meta() {
    return { series: LAB_SERIES, models: LAB_MODELS, horizons: LAB_HORIZONS, windows: [6, 12, 18] };
  }

  private compute(months: MonthFigures[], window: number, scale: number) {
    const series = LAB_SERIES.map((s) => backtest(s.key, months.map((m) => ({ month: m.month, value: seriesValue(m, s.key) })), window, LAB_HORIZONS, scale));
    const last = months[months.length - 1]?.month;
    const ahead: Forecast[] = last ? LAB_SERIES.flatMap((s) => forecastAhead(months.map((m) => seriesValue(m, s.key)), last, LAB_HORIZONS, scale).map((f) => ({ series: s.key, ...f }))) : [];
    return { series, ahead };
  }

  /** Saved forecasts measured against the books, by series and model. */
  private track(forecasts: Forecast[], actualByMonth: Map<string, MonthFigures>, scale: number) {
    return LAB_SERIES.map((s) => {
      const models = LAB_MODELS.map((m) => {
        const points: ErrorPoint[] = forecasts
          .filter((f) => f.series === s.key && f.model === m.key && actualByMonth.has(f.month))
          .map((f) => ({ month: f.month, horizon: f.horizon, forecast: new D(f.value), actual: seriesValue(actualByMonth.get(f.month)!, s.key) }));
        return { model: m.key, stats: accuracy(points, scale) };
      });
      const ranked = models.filter((m) => m.stats.wape !== null).sort((a, b) => Number(a.stats.wape) - Number(b.stats.wape) || Number(a.stats.mae) - Number(b.stats.mae));
      return { series: s.key, models, best: ranked[0]?.model ?? null };
    });
  }

  async overview(orgId: string, q: { window: number }) {
    const { currency, scale } = await this.scale(orgId);
    const h = await this.history(orgId);
    const { series, ahead } = this.compute(h.months, q.window, scale);
    const runs = await this.prisma.forecastLabRun.findMany({ where: { orgId }, orderBy: { number: 'asc' }, select: { forecasts: true } });
    const byMonth = new Map(h.months.map((m) => [m.month, m]));
    const tracking = this.track(runs.flatMap((r) => r.forecasts as unknown as Forecast[]), byMonth, scale);
    return {
      currency,
      baseMonth: h.last,
      window: q.window,
      historyMonths: h.months.length,
      firstMonth: h.months[0]?.month ?? null,
      series,
      ahead,
      tracking: { runs: runs.length, series: tracking },
      meta: this.meta(),
    };
  }

  async save(orgId: string, actor: Actor, input: { window: number; note?: string | null }) {
    const { scale } = await this.scale(orgId);
    const h = await this.history(orgId);
    if (h.months.length < 2) throw new DomainError('NOT_ENOUGH_HISTORY', 'At least two months of posted books are needed to save a forecast run');
    const { series, ahead } = this.compute(h.months, input.window, scale);
    const results = Object.fromEntries(
      series.map((s) => [s.series, { best: s.best, summary: s.summary, months: s.months, models: s.models.map((m) => ({ model: m.model, rank: m.rank, stats: m.stats, byHorizon: m.byHorizon, note: m.note })) }]),
    );
    const run = await this.prisma.$transaction(async (tx) => {
      const last = await tx.forecastLabRun.aggregate({ where: { orgId }, _max: { number: true } });
      const r = await tx.forecastLabRun.create({
        data: { orgId, number: (last._max.number ?? 0) + 1, baseMonth: h.last, window: input.window, note: input.note ?? null, results: results as unknown as Prisma.InputJsonValue, forecasts: ahead as unknown as Prisma.InputJsonValue, createdById: actor.id },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'forecast_lab.run_saved', entityType: 'forecast_lab_run', entityId: r.id, data: { number: fl(r.number), baseMonth: h.last, window: input.window, best: Object.fromEntries(series.map((s) => [s.series, s.best])), forecasts: ahead.length } });
      return r;
    });
    return this.get(orgId, run.id);
  }

  async list(orgId: string) {
    const { scale } = await this.scale(orgId);
    const runs = await this.prisma.forecastLabRun.findMany({ where: { orgId }, orderBy: { number: 'desc' }, take: 100 });
    const h = await this.history(orgId);
    const byMonth = new Map(h.months.map((m) => [m.month, m]));
    const people = await this.names(runs.map((r) => r.createdById));
    return {
      items: runs.map((r) => {
        const f = r.forecasts as unknown as Forecast[];
        const results = r.results as unknown as Record<string, { best: LabModel | null }>;
        return {
          id: r.id,
          number: fl(r.number),
          baseMonth: r.baseMonth,
          window: r.window,
          note: r.note,
          createdBy: people[r.createdById] ?? null,
          createdAt: r.createdAt.toISOString(),
          best: Object.fromEntries(LAB_SERIES.map((s) => [s.key, results[s.key]?.best ?? null])),
          forecastMonths: [...new Set(f.map((x) => x.month))].sort(),
          measuredMonths: [...new Set(f.filter((x) => byMonth.has(x.month)).map((x) => x.month))].sort(),
        };
      }),
      scale,
    };
  }

  private async names(ids: string[]) {
    const list = [...new Set(ids)];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }) : [];
    return Object.fromEntries(users.map((u) => [u.id, u.name])) as Record<string, string>;
  }

  async get(orgId: string, id: string) {
    const r = await this.prisma.forecastLabRun.findFirst({ where: { orgId, id } });
    if (!r) throw new DomainError('NOT_FOUND', 'Forecast run not found', HttpStatus.NOT_FOUND);
    const { currency, scale } = await this.scale(orgId);
    const h = await this.history(orgId);
    const byMonth = new Map(h.months.map((m) => [m.month, m]));
    const forecasts = r.forecasts as unknown as Forecast[];
    const people = await this.names([r.createdById]);
    return {
      id: r.id,
      number: fl(r.number),
      baseMonth: r.baseMonth,
      window: r.window,
      note: r.note,
      createdBy: people[r.createdById] ?? null,
      createdAt: r.createdAt.toISOString(),
      currency,
      results: r.results,
      forecasts: forecasts.map((f) => ({ ...f, actual: byMonth.has(f.month) ? seriesValue(byMonth.get(f.month)!, f.series).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale) : null })),
      tracking: this.track(forecasts, byMonth, scale),
      meta: this.meta(),
    };
  }
}
