import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { checkRate, FxError, isMonetary, isSupportedCurrency, minorUnits, nextDay, rateOn, revaluationJournal, revaluationPlan, type AccountType, type ForeignBalance } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { nextCounter } from '../db/counters';

type Org = { id: string; functionalCurrency: string };
type Actor = { id: string };

/**
 * Exchange rates and period-end revaluation of foreign-currency balances. A revaluation posts
 * one FX_REVALUATION journal on its date and its reversal the next day, and keeps a record of
 * the balances and rates used. See docs/MULTI_CURRENCY.md.
 */
@Injectable()
export class FxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journals: JournalsService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  private invalid(message: string, code = 'FX_INVALID', status = HttpStatus.UNPROCESSABLE_ENTITY): never {
    throw new DomainError(code, message, status);
  }

  async listRates(orgId: string, currency?: string) {
    const rows = await this.prisma.exchangeRate.findMany({ where: { orgId, ...(currency ? { currency } : {}) }, orderBy: [{ currency: 'asc' }, { date: 'desc' }], take: 500 });
    return rows.map(serializeRate);
  }

  /** Records the rate for a currency and date, replacing one already there for that day. */
  async setRate(org: Org, actor: Actor, input: { currency: string; date: string; rate: string; source?: string | null }) {
    if (input.currency === org.functionalCurrency) this.invalid('The functional currency always has a rate of 1.');
    if (!isSupportedCurrency(input.currency)) this.invalid(`${input.currency} is not a supported currency.`);
    let rate;
    try {
      rate = checkRate(input.rate);
    } catch (e) {
      this.invalid(e instanceof FxError ? e.message : 'Invalid rate');
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.exchangeRate.findUnique({ where: { orgId_currency_date: { orgId: org.id, currency: input.currency, date: toDbDate(input.date) } } });
      const row = await tx.exchangeRate.upsert({
        where: { orgId_currency_date: { orgId: org.id, currency: input.currency, date: toDbDate(input.date) } },
        create: { orgId: org.id, currency: input.currency, date: toDbDate(input.date), rate: rate.toFixed(), source: input.source ?? null, createdById: actor.id },
        update: { rate: rate.toFixed(), source: input.source ?? null },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: before ? 'fx.rate_changed' : 'fx.rate_added', entityType: 'exchange_rate', entityId: row.id, data: { currency: input.currency, date: input.date, rate: rate.toFixed(), before: before ? before.rate.toFixed() : null } });
      return serializeRate(row);
    });
  }

  async deleteRate(org: Org, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.exchangeRate.findFirst({ where: { id, orgId: org.id } });
      if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Exchange rate not found' });
      await tx.exchangeRate.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'fx.rate_deleted', entityType: 'exchange_rate', entityId: id, data: { currency: row.currency, date: fromDbDate(row.date), rate: row.rate.toFixed() } });
    });
  }

  /** Posted balances by account and foreign currency at the end of a date. */
  private async balances(db: Tx | PrismaService, orgId: string, functionalCurrency: string, asOf: string): Promise<ForeignBalance[]> {
    const sums = await lineSums(this.store, orgId, { entry: postedBetween(null, toDbDate(asOf)), line: { currency: { $ne: functionalCurrency } }, by: { accountId: 'lines.accountId', currency: 'lines.currency' } });
    const accounts = new Map((sums.length ? await db.account.findMany({ where: { orgId, id: { in: [...new Set(sums.map((r) => r.key.accountId as string))] } }, select: { id: true, code: true, name: true, type: true, subtype: true } }) : []).map((a) => [a.id, a]));
    const rows = sums.flatMap((r) => {
      const a = accounts.get(r.key.accountId as string);
      return a ? [{ id: a.id, code: a.code, name: a.name, type: a.type as AccountType, subtype: a.subtype as string | null, currency: String(r.key.currency), foreign: r.txDebit.minus(r.txCredit), carried: r.debit.minus(r.credit) }] : [];
    });
    return rows.map((r) => ({ accountId: r.id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, currency: r.currency.trim(), foreign: r.foreign.toFixed(), carried: r.carried.toFixed() }));
  }

  /** The rate on or before the date for each currency, from the rate table. */
  private async ratesOn(db: Tx | PrismaService, orgId: string, currencies: string[], date: string) {
    const out: Record<string, { rate: string; date: string }> = {};
    if (!currencies.length) return out;
    const rows = await db.exchangeRate.findMany({ where: { orgId, currency: { in: currencies }, date: { lte: toDbDate(date) } } });
    for (const c of currencies) {
      const r = rateOn(rows.filter((x) => x.currency === c).map((x) => ({ date: fromDbDate(x.date), rate: x.rate.toFixed() })), date);
      if (r) out[c] = r;
    }
    return out;
  }

  /** Foreign-currency balances at a date and what a revaluation at the recorded rates would post. */
  async exposure(org: Org, asOf: string, overrides: Record<string, string> = {}) {
    const balances = await this.balances(this.prisma, org.id, org.functionalCurrency, asOf);
    const currencies = [...new Set(balances.filter((b) => isMonetary(b.type, b.subtype)).map((b) => b.currency))].sort();
    const recorded = await this.ratesOn(this.prisma, org.id, currencies, asOf);
    const rates: Record<string, string> = Object.fromEntries(Object.entries(recorded).map(([c, r]) => [c, r.rate]));
    Object.assign(rates, overrides);
    let plan;
    try {
      plan = revaluationPlan(balances, rates, org.functionalCurrency);
    } catch (e) {
      this.invalid(e instanceof FxError ? e.message : 'Invalid rate');
    }
    const scale = minorUnits(org.functionalCurrency);
    const last = await this.prisma.fxRevaluation.findFirst({ where: { orgId: org.id }, orderBy: { date: 'desc' } });
    return {
      asOf,
      functionalCurrency: org.functionalCurrency,
      currencies: currencies.map((c) => ({ currency: c, rate: rates[c] ?? null, rateDate: overrides[c] !== undefined ? null : (recorded[c]?.date ?? null), entered: overrides[c] !== undefined })),
      lines: plan.lines.map((l) => ({ accountId: l.accountId, code: l.code, name: l.name, currency: l.currency, foreign: l.foreign.toFixed(minorUnits(l.currency)), rate: l.rate.toFixed(), carried: l.carried.toFixed(scale), revalued: l.revalued.toFixed(scale), adjustment: l.adjustment.toFixed(scale) })),
      gain: plan.gain.toFixed(scale),
      missingRates: plan.missingRates,
      skipped: plan.skipped,
      lastRevaluation: last ? { number: last.number, date: fromDbDate(last.date), reversalDate: fromDbDate(last.reversalDate) } : null,
    };
  }

  /** Posts the revaluation at a date and its reversal the next day. */
  async revalue(org: Org, actor: Actor, input: { date: string; rates?: Record<string, string> }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id}::uuid FOR UPDATE`;
      const last = await tx.fxRevaluation.findFirst({ where: { orgId: org.id }, orderBy: { date: 'desc' } });
      if (last && input.date <= fromDbDate(last.date)) {
        this.invalid(`Revaluation ${last.number} is dated ${fromDbDate(last.date)}. A new one must be dated after it.`, 'FX_ORDER', HttpStatus.CONFLICT);
      }
      const balances = await this.balances(tx, org.id, org.functionalCurrency, input.date);
      const currencies = [...new Set(balances.filter((b) => isMonetary(b.type, b.subtype)).map((b) => b.currency))].sort();
      const recorded = await this.ratesOn(tx, org.id, currencies, input.date);
      const rates: Record<string, string> = { ...Object.fromEntries(Object.entries(recorded).map(([c, r]) => [c, r.rate])), ...(input.rates ?? {}) };
      let plan;
      try {
        plan = revaluationPlan(balances, rates, org.functionalCurrency);
      } catch (e) {
        this.invalid(e instanceof FxError ? e.message : 'Invalid rate');
      }
      if (plan.missingRates.length) this.invalid(`Add a rate for ${plan.missingRates.join(', ')} on or before ${input.date}, or enter one here.`, 'FX_RATE_MISSING');
      const fxAccount = await tx.account.findFirst({ where: { orgId: org.id, subtype: 'FX_GAIN_LOSS', isActive: true, isPostable: true }, orderBy: { code: 'asc' } });
      if (!fxAccount) this.invalid('Add an active expense account with the subtype FX_GAIN_LOSS (such as 7200 Foreign Exchange Gain/Loss) for exchange gains and losses.', 'FX_ACCOUNT_MISSING', HttpStatus.CONFLICT);
      const lines = revaluationJournal(plan, fxAccount.id, org.functionalCurrency);
      if (!lines) this.invalid(plan.lines.length ? 'Nothing to post: the balances are already at these rates.' : `No foreign-currency monetary balances on ${input.date}.`, 'FX_NOTHING', HttpStatus.CONFLICT);
      const reversalDate = nextDay(input.date);
      const used = Object.fromEntries(currencies.map((c) => [c, { rate: rates[c], date: input.rates?.[c] !== undefined ? null : (recorded[c]?.date ?? null) }]));
      const [{ value: number }] = [{ value: await nextCounter(tx, org.id, 'fx_revaluation') }];
      const reference = `FXR-${String(number).padStart(4, '0')}`;
      const je = await this.journals.postSystemEntry(tx, org, actor, { date: input.date, source: 'FX_REVALUATION', memo: `Revaluation of foreign-currency balances at ${input.date}`, reference, lines });
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, je.id, { date: reversalDate, memo: `Reversal of ${reference} (unrealised exchange differences restart from the entries)` });
      const scale = minorUnits(org.functionalCurrency);
      const record = await tx.fxRevaluation.create({
        data: {
          orgId: org.id,
          number,
          date: toDbDate(input.date),
          reversalDate: toDbDate(reversalDate),
          rates: used,
          lines: plan.lines.map((l) => ({ accountId: l.accountId, code: l.code, name: l.name, currency: l.currency, foreign: l.foreign.toFixed(), rate: l.rate.toFixed(), carried: l.carried.toFixed(scale), revalued: l.revalued.toFixed(scale), adjustment: l.adjustment.toFixed(scale) })),
          gain: plan.gain.toFixed(scale),
          journalEntryId: je.id,
          reversalEntryId: rev.id,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'fx.revalued', entityType: 'fx_revaluation', entityId: record.id, data: { reference, date: input.date, gain: plan.gain.toFixed(scale), rates: used, journalEntry: je.entryNumber, reversalEntry: rev.entryNumber } });
      return this.serialize(record, je.entryNumber, rev.entryNumber, scale);
    });
  }

  async listRevaluations(org: Org) {
    const scale = minorUnits(org.functionalCurrency);
    const rows = await this.prisma.fxRevaluation.findMany({ where: { orgId: org.id }, orderBy: { date: 'desc' }, include: { journalEntry: { select: { entryNumber: true } }, reversalEntry: { select: { entryNumber: true } } } });
    return rows.map((r) => this.serialize(r, r.journalEntry.entryNumber, r.reversalEntry.entryNumber, scale));
  }

  private serialize(r: { id: string; number: number; date: Date; reversalDate: Date; rates: Prisma.JsonValue; lines: Prisma.JsonValue; gain: Prisma.Decimal; journalEntryId: string; reversalEntryId: string; createdAt: Date }, entryNumber: number | null, reversalNumber: number | null, scale: number) {
    return {
      id: r.id,
      number: r.number,
      reference: `FXR-${String(r.number).padStart(4, '0')}`,
      date: fromDbDate(r.date),
      reversalDate: fromDbDate(r.reversalDate),
      rates: r.rates,
      lines: r.lines,
      gain: r.gain.toFixed(scale),
      journalEntryId: r.journalEntryId,
      journalEntryNumber: entryNumber,
      reversalEntryId: r.reversalEntryId,
      reversalEntryNumber: reversalNumber,
      createdAt: r.createdAt.toISOString(),
    };
  }
}

function serializeRate(r: { id: string; currency: string; date: Date; rate: Prisma.Decimal; source: string | null; updatedAt: Date }) {
  return { id: r.id, currency: r.currency, date: fromDbDate(r.date), rate: r.rate.toFixed(), source: r.source, updatedAt: r.updatedAt.toISOString() };
}
