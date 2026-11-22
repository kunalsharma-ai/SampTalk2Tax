import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, type Dec, minorUnits } from '@talk2tax/accounting-engine';
import { ADVANCE_TAX_REGIME, ADVANCE_TAX_REGIMES, type AdvanceTaxRegime, compareRegimes, SCENARIO_GST_RATES, simulateTaxScenario, type TaxScenarioInput } from '@talk2tax/tax-engine';
import { AdvanceTaxService } from '../advance-tax/advance-tax.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { taxScenarios, type TaxScenarioDoc } from '../db/collections/tax-scenarios';
import { users } from '../db/collections/identity';

/** Saved scenarios a tax year can hold. */
const MAX_SCENARIOS = 20;

export type ScenarioBody = TaxScenarioInput & { name?: string; note?: string | null };

/**
 * Tax scenario simulations (TAX-049): what-if changes to the year's sales, expenses, depreciation,
 * add-backs and regime, worked out against the advance tax estimate (taxable income, regime and
 * credits as the Advance tax page has them) with simulateTaxScenario. reports.read simulates and
 * reads; accounts.manage saves and deletes named scenarios. Nothing here changes the books.
 */
@Injectable()
export class TaxScenariosService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly advanceTax: AdvanceTaxService,
  ) {}

  private async baseline(org: OrgContext, taxYear?: string) {
    const a = await this.advanceTax.get(org, taxYear);
    const regime = a.plan.regime as AdvanceTaxRegime;
    return {
      taxYear: a.taxYear,
      from: a.from,
      to: a.to,
      asOf: a.asOf,
      method: a.plan.method,
      regime,
      regimeLabel: ADVANCE_TAX_REGIME[regime].label,
      income: a.income.taxable,
      tax: a.tax.total,
      credits: a.credits.total,
      netLiability: a.netLiability,
    };
  }

  private view(org: OrgContext, base: Awaited<ReturnType<TaxScenariosService['baseline']>>, input: TaxScenarioInput) {
    const scale = minorUnits(org.functionalCurrency);
    const m = (x: Dec) => x.toFixed(scale);
    const r = simulateTaxScenario({ income: base.income, regime: base.regime, credits: base.credits }, input);
    return {
      regime: r.regime,
      regimeLabel: ADVANCE_TAX_REGIME[r.regime].label,
      bookProfit: m(r.bookProfit),
      taxableIncome: m(r.taxableIncome),
      tax: { tax: m(r.tax.tax), surchargeRate: r.tax.surchargeRate.times(100).toFixed(), surcharge: m(r.tax.surcharge), marginalRelief: m(r.tax.marginalRelief), cess: m(r.tax.cess), total: m(r.tax.total) },
      taxChange: m(r.taxChange),
      netPayable: m(r.netPayable),
      profitAfterTax: m(r.profitAfterTax),
      effectiveRate: r.effectiveRate,
      gst: { output: m(r.gst.output), input: m(r.gst.input), net: m(r.gst.net) },
      cashEffect: m(r.cashEffect),
      notes: r.notes,
    };
  }

  private input(d: TaxScenarioDoc | ScenarioBody): TaxScenarioInput {
    const norm = (x: string) => new D(x).toFixed();
    return {
      regime: (d.regime as AdvanceTaxRegime | null) ?? null,
      revenueChange: norm(d.revenueChange),
      revenueGstRate: d.revenueGstRate,
      expenseChange: norm(d.expenseChange),
      expenseGstRate: d.expenseGstRate,
      extraDepreciation: norm(d.extraDepreciation),
      disallowed: norm(d.disallowed),
    } as TaxScenarioInput;
  }

  async list(org: OrgContext, taxYear?: string) {
    const base = await this.baseline(org, taxYear);
    const saved = await this.store.collection(taxScenarios).find({ taxYear: base.taxYear }, { sort: { createdAt: 1 } });
    const people = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(saved.map((s) => s.createdById))] } })).map((u) => [u.id, u.name]));
    const scale = minorUnits(org.functionalCurrency);
    return {
      currency: org.functionalCurrency,
      baseline: base,
      regimes: ADVANCE_TAX_REGIMES.map((k) => ({ key: k, label: ADVANCE_TAX_REGIME[k].label })),
      gstRates: SCENARIO_GST_RATES,
      comparison: compareRegimes(base.income, base.regime).map((c) => ({ regime: c.regime, label: c.label, total: c.total.toFixed(scale), current: c.current, saving: new D(base.tax).minus(c.total).toFixed(scale) })),
      scenarios: saved.map((s) => ({ id: s.id, name: s.name, note: s.note, createdBy: people.get(s.createdById) ?? null, createdAt: s.createdAt.toISOString(), input: this.input(s), result: this.view(org, base, this.input(s)) })),
    };
  }

  async simulate(org: OrgContext, taxYear: string | undefined, body: ScenarioBody) {
    const base = await this.baseline(org, taxYear);
    return { currency: org.functionalCurrency, baseline: base, input: this.input(body), result: this.view(org, base, this.input(body)) };
  }

  async create(org: OrgContext, user: AuthUser, taxYear: string | undefined, body: ScenarioBody) {
    const base = await this.baseline(org, taxYear);
    const name = (body.name ?? '').trim();
    if (!name) throw new DomainError('VALIDATION_FAILED', 'Give the scenario a name', HttpStatus.UNPROCESSABLE_ENTITY);
    const col = this.store.collection(taxScenarios);
    const existing = await col.find({ taxYear: base.taxYear });
    if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new DomainError('NAME_TAKEN', `A scenario called "${name}" is already saved for ${base.taxYear}`, HttpStatus.CONFLICT);
    if (existing.length >= MAX_SCENARIOS) throw new DomainError('TOO_MANY', `Keep up to ${MAX_SCENARIOS} scenarios a year; delete one first`, HttpStatus.UNPROCESSABLE_ENTITY);
    const input = this.input(body);
    const doc = await col.insertOne({
      taxYear: base.taxYear,
      name,
      regime: input.regime ?? null,
      revenueChange: input.revenueChange,
      revenueGstRate: input.revenueGstRate,
      expenseChange: input.expenseChange,
      expenseGstRate: input.expenseGstRate,
      extraDepreciation: input.extraDepreciation,
      disallowed: input.disallowed,
      note: body.note?.trim() || null,
      createdById: user.id,
      createdAt: new Date(),
    });
    const result = this.view(org, base, input);
    await this.log(org, user, 'tax_scenario.saved', doc.id, { taxYear: base.taxYear, name, ...input, taxChange: result.taxChange });
    return { id: doc.id, name, note: doc.note, createdBy: user.name ?? null, createdAt: doc.createdAt.toISOString(), input, result };
  }

  async remove(org: OrgContext, user: AuthUser, id: string) {
    const col = this.store.collection(taxScenarios);
    const s = await col.findById(id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Tax scenario not found' });
    await col.deleteOne({ id });
    await this.log(org, user, 'tax_scenario.deleted', id, { taxYear: s.taxYear, name: s.name });
    return { deleted: true };
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'tax_scenario', entityId, data }));
  }
}
