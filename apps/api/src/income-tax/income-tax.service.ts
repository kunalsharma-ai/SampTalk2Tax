import { HttpStatus, Injectable } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { type AdvanceTaxRegime, ADVANCE_TAX_REGIME, ADVANCE_TAX_REGIMES, incomeComputation, taxYearOf } from '@talk2tax/tax-engine';
import { AdvanceTaxService } from '../advance-tax/advance-tax.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { type ComputationAdjustmentDoc, incomeTaxComputations } from '../db/collections/income-tax-computations';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { TaxAuditService } from '../tax-audit/tax-audit.service';

export interface ComputationInput {
  regime: AdvanceTaxRegime;
  taxDepreciation: string | null;
  broughtForwardLoss: string;
  adjustments: ComputationAdjustmentDoc[];
  otherCredits: string;
}

const DEFAULTS = { taxDepreciation: null, broughtForwardLoss: '0', adjustments: [] as ComputationAdjustmentDoc[], otherCredits: '0' };

/**
 * Income tax computation (TAX-019, TAX-020) for an Indian company or firm, one financial year at a
 * time: profit before tax from posted journals (closing entries and income tax expense left out),
 * book depreciation added back, depreciation under section 32 and the preparer's other adjustments,
 * cash payments over 10,000 from the tax audit working (section 40A(3)), brought forward loss, tax
 * at the corporate rates, and TDS and advance tax from the advance tax plan's accounts. Live while a
 * draft; finalising, once the year has ended, freezes it. reports.read to read; accounts.manage to
 * save and finalise; every change is audited.
 */
@Injectable()
export class IncomeTaxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly advanceTax: AdvanceTaxService,
    private readonly taxAudit: TaxAuditService,
  ) {}

  private async year(org: OrgContext, year: string | undefined, today: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'The income tax computation follows the Indian Income-tax Act', HttpStatus.UNPROCESSABLE_ENTITY);
    const current = taxYearOf(today);
    const ty = year ? taxYearOf(`${year.slice(0, 4)}-04-01`) : taxYearOf(`${Number(current.from.slice(0, 4)) - 1}-04-01`);
    if (year && ty.label !== year) throw new DomainError('INVALID_TAX_YEAR', 'Give the financial year as 2025-26', HttpStatus.BAD_REQUEST);
    if (ty.from > today) throw new DomainError('FUTURE_YEAR', `The financial year ${ty.label} has not started`, HttpStatus.UNPROCESSABLE_ENTITY);
    return ty;
  }

  private async books(org: OrgContext, from: string, to: string) {
    const chart = new Map((await this.store.collection(accounts).find({})).map((a) => [a.id, a]));
    const sums = await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(from), toDbDate(to), { excludeClosing: true }), by: { accountId: 'lines.accountId' } });
    let profit = new D(0);
    let tax = new D(0);
    let depreciation = new D(0);
    for (const s of sums) {
      const a = chart.get(s.key.accountId as string);
      if (!a || (a.type !== 'REVENUE' && a.type !== 'EXPENSE')) continue;
      if (a.subtype === 'TAX_EXPENSE') {
        tax = tax.plus(s.debit.minus(s.credit));
        continue;
      }
      profit = profit.plus(s.credit.minus(s.debit));
      if (a.subtype === 'DEPRECIATION') depreciation = depreciation.plus(s.debit.minus(s.credit));
    }
    return { profit, tax, depreciation };
  }

  private async compute(org: OrgContext, ty: { from: string; to: string; label: string }, input: ComputationInput, today: string) {
    const asOf = ty.to < today ? ty.to : today;
    const [books, audit, advance] = await Promise.all([this.books(org, ty.from, asOf), this.taxAudit.report(org, ty.label, today), this.advanceTax.get(org, ty.label)]);
    const result = incomeComputation({
      profitBeforeTax: books.profit.toFixed(2),
      taxInBooks: books.tax.toFixed(2),
      bookDepreciation: books.depreciation.toFixed(2),
      taxDepreciation: input.taxDepreciation,
      cashDisallowance: audit.cashPayments.disallowed,
      adjustments: input.adjustments,
      broughtForwardLoss: input.broughtForwardLoss,
      regime: input.regime,
      credits: { tds: advance.credits.tds, advanceTax: advance.paid, other: input.otherCredits },
    });
    const sources = {
      cashPaymentDays: audit.cashPayments.days.length,
      tdsAccount: advance.plan.tdsAccount,
      advanceTaxAccount: advance.plan.paidAccount,
    };
    if (!advance.plan.tdsAccount || !advance.plan.paidAccount) result.warnings.push('Choose the TDS receivable and advance tax accounts on the Advance tax page so tax already paid is taken off.');
    return { taxYear: ty.label, from: ty.from, to: ty.to, asOf, yearEnded: ty.to < today, regimeLabel: ADVANCE_TAX_REGIME[input.regime].label, ...result, sources };
  }

  async get(org: OrgContext, year?: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    const row = await this.store.collection(incomeTaxComputations).findOne({ taxYear: ty.label });
    const input: ComputationInput = row
      ? { regime: row.regime as AdvanceTaxRegime, taxDepreciation: row.taxDepreciation, broughtForwardLoss: row.broughtForwardLoss, adjustments: row.adjustments, otherCredits: row.otherCredits }
      : { regime: (await this.advanceTax.get(org, ty.label)).plan.regime, ...DEFAULTS };
    const ids = [row?.updatedById, row?.finalisedById].filter((x): x is string => !!x);
    const who = new Map((ids.length ? await this.store.collection(users).find({ id: { $in: ids } }) : []).map((u) => [u.id, u.name]));
    const meta = {
      currency: org.functionalCurrency,
      status: row?.status ?? 'DRAFT',
      saved: !!row,
      input,
      regimes: ADVANCE_TAX_REGIMES.map((k) => ({ key: k, label: ADVANCE_TAX_REGIME[k].label })),
      updatedBy: row ? (who.get(row.updatedById) ?? 'Former member') : null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      finalisedBy: row?.finalisedById ? (who.get(row.finalisedById) ?? 'Former member') : null,
      finalisedAt: row?.finalisedAt?.toISOString() ?? null,
    };
    const live = await this.compute(org, ty, input, today);
    if (row?.status === 'FINAL' && row.snapshot) {
      const snap = row.snapshot as unknown as typeof live;
      const changedSince = snap.lines[0]!.amount === live.lines[0]!.amount ? null : { then: snap.lines[0]!.amount, now: live.lines[0]!.amount };
      return { ...snap, ...meta, changedSince };
    }
    return { ...live, ...meta, changedSince: null as { then: string; now: string } | null };
  }

  async save(org: OrgContext, user: AuthUser, year: string, input: ComputationInput, today = todayIso()) {
    const ty = await this.year(org, year, today);
    const clean: ComputationInput = {
      regime: input.regime,
      taxDepreciation: input.taxDepreciation === null ? null : new D(input.taxDepreciation).toFixed(),
      broughtForwardLoss: new D(input.broughtForwardLoss).toFixed(),
      adjustments: input.adjustments.map((a) => ({ label: a.label.trim(), section: a.section?.trim() || null, kind: a.kind, amount: new D(a.amount).toFixed() })),
      otherCredits: new D(input.otherCredits).toFixed(),
    };
    const col = this.store.collection(incomeTaxComputations);
    const row = await col.findOne({ taxYear: ty.label });
    if (row?.status === 'FINAL') throw new DomainError('COMPUTATION_FINAL', `The computation for ${ty.label} is final and cannot be changed`, HttpStatus.CONFLICT);
    const now = new Date();
    let id: string;
    if (row) {
      const r = await col.updateOne({ id: row.id, status: 'DRAFT' }, { $set: { ...clean, updatedById: user.id, updatedAt: now } });
      if (!r.matched) throw new DomainError('CHANGED', 'The computation changed meanwhile; reload and try again', HttpStatus.CONFLICT);
      id = row.id;
    } else {
      id = (await this.insert(ty.label, clean, user, now)).id;
    }
    await this.log(org, user, 'income_tax_computation.saved', id, { taxYear: ty.label, regime: clean.regime, taxDepreciation: clean.taxDepreciation, broughtForwardLoss: clean.broughtForwardLoss, adjustments: clean.adjustments.length, otherCredits: clean.otherCredits });
    return this.get(org, ty.label, today);
  }

  private async insert(taxYear: string, input: ComputationInput, user: AuthUser, now: Date) {
    try {
      return await this.store.collection(incomeTaxComputations).insertOne({ taxYear, ...input, status: 'DRAFT', snapshot: null, createdById: user.id, createdAt: now, updatedById: user.id, updatedAt: now, finalisedById: null, finalisedAt: null });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new DomainError('CHANGED', 'The computation was saved meanwhile; reload and try again', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async finalise(org: OrgContext, user: AuthUser, year: string, today = todayIso()) {
    const ty = await this.year(org, year, today);
    if (ty.to >= today) throw new DomainError('YEAR_NOT_ENDED', `The computation for ${ty.label} can be finalised once the year has ended`, HttpStatus.CONFLICT);
    const col = this.store.collection(incomeTaxComputations);
    const existing = await col.findOne({ taxYear: ty.label });
    if (!existing) throw new DomainError('NOT_SAVED', 'Save the computation before finalising it', HttpStatus.CONFLICT);
    if (existing.status === 'FINAL') throw new DomainError('COMPUTATION_FINAL', `The computation for ${ty.label} is already final`, HttpStatus.CONFLICT);
    const snapshot = await this.compute(org, ty, { regime: existing.regime as AdvanceTaxRegime, taxDepreciation: existing.taxDepreciation, broughtForwardLoss: existing.broughtForwardLoss, adjustments: existing.adjustments, otherCredits: existing.otherCredits }, today);
    const now = new Date();
    const r = await col.updateOne({ id: existing.id, status: 'DRAFT' }, { $set: { status: 'FINAL', snapshot, finalisedById: user.id, finalisedAt: now, updatedById: user.id, updatedAt: now } });
    if (!r.matched) throw new DomainError('CHANGED', 'The computation changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'income_tax_computation.finalised', existing.id, { taxYear: ty.label, totalIncome: snapshot.totalIncome, tax: snapshot.tax.total, payable: snapshot.payable, refund: snapshot.refund });
    return this.get(org, ty.label, today);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'income_tax_computation', entityId, data }));
  }
}
