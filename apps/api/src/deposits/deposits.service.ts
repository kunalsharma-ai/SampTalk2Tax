import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { checkDepositTerms, D, depositClosing, depositInterest, depositMaturityValue, interestToAccrue, minorUnits, type DepositCompounding, type DepositTerms } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { DepositDoc, depositEvents, DepositEventDoc, deposits } from '../db/collections/deposits';
import { users } from '../db/collections/identity';
import { nextCounter } from '../db/counters';
import { holdLock } from '../db/locks';
import { JournalsService } from '../journals/journals.service';

export interface DepositOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

export interface DepositInput {
  name: string;
  institution: string;
  institutionRef?: string | null;
  principal: string;
  annualRate: string;
  compounding: DepositCompounding;
  startDate: string;
  maturityDate: string;
  bankAccountId: string;
  depositAccountId: string;
  accruedInterestAccountId: string;
  interestIncomeAccountId: string;
}

export interface CloseInput {
  date: string;
  /** What the bank paid into the account. */
  received: string;
  /** Tax deducted at source on the interest, with the asset account it is claimed back from. */
  tds: string;
  tdsAccountId?: string | null;
  bankAccountId?: string | null;
  note?: string | null;
}

type Acc = { id: string; code: string; name: string; type: string; subtype: string | null; isPostable: boolean };
const RULES = {
  bank: (a: Acc) => a.type === 'ASSET' && ['BANK', 'CASH'].includes(a.subtype ?? ''),
  deposit: (a: Acc) => a.type === 'ASSET' && ['OTHER_CURRENT_ASSET', 'OTHER_NON_CURRENT_ASSET'].includes(a.subtype ?? ''),
  accrued: (a: Acc) => a.type === 'ASSET' && ['OTHER_CURRENT_ASSET', 'PREPAID'].includes(a.subtype ?? ''),
  income: (a: Acc) => a.type === 'REVENUE' && a.subtype === 'OTHER_INCOME',
  tds: (a: Acc) => a.type === 'ASSET' && ['TAX_RECEIVABLE', 'OTHER_CURRENT_ASSET'].includes(a.subtype ?? ''),
};

/**
 * Term deposits and the interest they earn (BANK-011, TRS-012). Placing a deposit posts Dr
 * deposit, Cr bank. Accruing posts the interest earned since the last accrual (Dr accrued
 * interest, Cr interest income), worked out by the engine from the terms, so accruals add up to
 * the maturity interest. Closing, at maturity or early, posts what the bank paid and the tax it
 * deducted, clears the deposit and the accrued interest, and books the rest as income (or, after
 * a penalty for breaking early, takes it back). The latest posting can be reversed. MongoDB only.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  private can(org: DepositOrg) {
    return { manage: hasPermission(org.role, 'loans.manage') };
  }

  private scale(org: DepositOrg) {
    return minorUnits(org.functionalCurrency);
  }

  private invalid(issues: string[], code = 'INVALID_DEPOSIT'): never {
    throw new DomainError(code, issues.join('; '), HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  private money(v: string | null | undefined, label: string, scale: number, allowZero = true) {
    let d: InstanceType<typeof D>;
    try {
      d = new D((v ?? '').trim() || 'x');
    } catch {
      this.invalid([`${label} must be an amount`]);
    }
    if (!d.isFinite() || d.lt(0) || (!allowZero && d.isZero())) this.invalid([`${label} must be ${allowZero ? 'zero or more' : 'more than zero'}`]);
    if (d.decimalPlaces() > scale) this.invalid([`${label} has more than ${scale} decimal places`]);
    return d;
  }

  private async chart(orgId: string, ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? await this.store.collection(accounts).find({ id: { $in: list } }) : [];
    return new Map(rows.map((a) => [a.id, a as unknown as Acc]));
  }

  private check(chart: Map<string, Acc>, id: string | null | undefined, ok: (a: Acc) => boolean, message: string, errors: string[]) {
    const a = id ? chart.get(id) : undefined;
    if (!a || !a.isPostable || !ok(a)) errors.push(message);
  }

  private terms(d: DepositDoc): DepositTerms {
    return { principal: d.principal, annualRate: d.annualRate, startDate: fromDbDate(d.startDate), maturityDate: fromDbDate(d.maturityDate), compounding: d.compounding };
  }

  private async find(id: string) {
    const d = await this.store.collection(deposits).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Deposit not found' });
    return d;
  }

  async create(org: DepositOrg, actorId: string, input: DepositInput) {
    const scale = this.scale(org);
    const errors = checkDepositTerms(input);
    const name = input.name?.trim();
    const institution = input.institution?.trim();
    if (!name) errors.push('Give the deposit a name');
    if (!institution) errors.push('Say which bank or institution holds it');
    if (errors.length) this.invalid(errors);
    const principal = this.money(input.principal, 'The amount deposited', scale, false);
    const chart = await this.chart(org.id, [input.bankAccountId, input.depositAccountId, input.accruedInterestAccountId, input.interestIncomeAccountId]);
    this.check(chart, input.bankAccountId, RULES.bank, 'Pay the deposit from a bank or cash account', errors);
    this.check(chart, input.depositAccountId, RULES.deposit, 'Hold the deposit in an other current or non-current asset account', errors);
    this.check(chart, input.accruedInterestAccountId, RULES.accrued, 'Keep accrued interest in an other current asset account', errors);
    this.check(chart, input.interestIncomeAccountId, RULES.income, 'Book the interest to an other income account', errors);
    if (input.depositAccountId === input.accruedInterestAccountId) errors.push('Use different accounts for the deposit and its accrued interest');
    if (input.startDate > todayIso()) errors.push('The start date cannot be in the future');
    if (errors.length) this.invalid(errors);

    const { je, number } = await this.prisma.$transaction(async (tx) => {
      const n = `FD-${String(await nextCounter(tx, org.id, 'doc:DEPOSIT')).padStart(6, '0')}`;
      const entry = await this.journals.postSystemEntry(tx, org, { id: actorId }, {
        date: input.startDate,
        source: 'BANK',
        memo: `${n} placed: ${name} with ${institution}`,
        reference: n,
        lines: [
          { accountId: input.depositAccountId, debit: principal.toFixed(scale), description: `${n} ${name}` },
          { accountId: input.bankAccountId, credit: principal.toFixed(scale), description: `${n} placed with ${institution}` },
        ],
      });
      return { je: entry, number: n };
    });
    const now = new Date();
    let id: string;
    try {
      id = (
        await this.store.collection(deposits).insertOne({
          orgId: org.id,
          number,
          name: name!,
          institution: institution!,
          institutionRef: input.institutionRef?.trim() || null,
          principal: principal.toFixed(scale),
          annualRate: new D(input.annualRate).toFixed(),
          compounding: input.compounding,
          startDate: toDbDate(input.startDate),
          maturityDate: toDbDate(input.maturityDate),
          bankAccountId: input.bankAccountId,
          depositAccountId: input.depositAccountId,
          accruedInterestAccountId: input.accruedInterestAccountId,
          interestIncomeAccountId: input.interestIncomeAccountId,
          accrued: '0',
          accruedTo: null,
          status: 'OPEN',
          placementEntryId: je.id,
          createdById: actorId,
          createdAt: now,
          updatedAt: now,
        })
      ).id;
      await this.event(org.id, actorId, { depositId: id, kind: 'PLACED', date: input.startDate, amount: principal.toFixed(scale), entryId: je.id });
    } catch (e) {
      await this.prisma.$transaction((tx) => this.journals.reverseSystemEntry(tx, org, { id: actorId }, je.id, { date: input.startDate, memo: `${number} not saved` }));
      throw e;
    }
    await this.log(org.id, actorId, 'deposit.placed', id, { number, principal: principal.toFixed(scale), annualRate: input.annualRate, compounding: input.compounding, startDate: input.startDate, maturityDate: input.maturityDate, entryNumber: je.entryNumber });
    return this.get(org, id);
  }

  private async event(orgId: string, actorId: string, e: Partial<Omit<DepositEventDoc, 'date'>> & Pick<DepositEventDoc, 'depositId' | 'kind' | 'amount' | 'entryId'> & { date: string }) {
    await this.store.collection(depositEvents).insertOne({
      orgId,
      depositId: e.depositId,
      kind: e.kind,
      date: toDbDate(e.date),
      amount: e.amount,
      received: e.received ?? null,
      tds: e.tds ?? null,
      interest: e.interest ?? null,
      incomeNow: e.incomeNow ?? null,
      early: e.early ?? false,
      entryId: e.entryId,
      accruedBefore: e.accruedBefore ?? null,
      accruedToBefore: e.accruedToBefore ?? null,
      reversedAt: null,
      reversalEntryId: null,
      note: e.note ?? null,
      createdById: actorId,
      createdAt: new Date(),
    });
  }

  private async lastEvent(depositId: string) {
    return this.store.collection(depositEvents).findOne({ depositId, reversedAt: null }, { sort: { date: -1, createdAt: -1 } });
  }

  /** Accrues the interest earned up to `date` that is not accrued yet. */
  async accrue(org: DepositOrg, actorId: string, id: string, input: { date: string }) {
    const scale = this.scale(org);
    await this.prisma.$transaction(async (tx) => {
      await holdLock(`deposit:${id}`);
      const d = await this.find(id);
      if (d.status !== 'OPEN') this.invalid(['This deposit is closed'], 'DEPOSIT_CLOSED');
      const start = fromDbDate(d.startDate);
      const maturity = fromDbDate(d.maturityDate);
      if (input.date <= start) this.invalid(['Accrue to a date after the deposit started']);
      if (input.date > maturity) this.invalid([`Accrue to ${maturity} at the latest; close the deposit after that`]);
      if (input.date > todayIso()) this.invalid(['Interest cannot be accrued to a future date']);
      if (d.accruedTo && input.date <= fromDbDate(d.accruedTo)) this.invalid([`Interest is already accrued to ${fromDbDate(d.accruedTo)}`], 'ALREADY_ACCRUED');
      const amount = interestToAccrue(this.terms(d), d.accrued, input.date, scale);
      if (!amount.gt(0)) this.invalid(['No interest has been earned since the last accrual'], 'NOTHING_TO_ACCRUE');
      const je = await this.journals.postSystemEntry(tx, org, { id: actorId }, {
        date: input.date,
        source: 'ACCRUAL',
        memo: `${d.number} interest accrued to ${input.date}: ${d.name}`,
        reference: d.number,
        lines: [
          { accountId: d.accruedInterestAccountId, debit: amount.toFixed(scale), description: `${d.number} interest to ${input.date}` },
          { accountId: d.interestIncomeAccountId, credit: amount.toFixed(scale), description: `${d.number} interest earned` },
        ],
      });
      const accrued = new D(d.accrued).plus(amount).toFixed(scale);
      await this.store.collection(deposits).updateOne({ id }, { $set: { accrued, accruedTo: toDbDate(input.date), updatedAt: new Date() } });
      await this.event(org.id, actorId, { depositId: id, kind: 'ACCRUED', date: input.date, amount: amount.toFixed(scale), entryId: je.id, accruedBefore: d.accrued, accruedToBefore: d.accruedTo });
      await this.audit.append(tx, { orgId: org.id, actorId, action: 'deposit.interest_accrued', entityType: 'deposit', entityId: id, data: { number: d.number, to: input.date, amount: amount.toFixed(scale), entryNumber: je.entryNumber } });
    });
    return this.get(org, id);
  }

  /** Accrues every open deposit to `date` (capped at each one's maturity); skips those with nothing to add. */
  async accrueAll(org: DepositOrg, actorId: string, input: { date: string }) {
    const open = await this.store.collection(deposits).find({ status: 'OPEN', startDate: { $lt: toDbDate(input.date) } }, { sort: { number: 1 } });
    const done: { number: string; amount: string }[] = [];
    for (const d of open) {
      const to = fromDbDate(d.maturityDate) < input.date ? fromDbDate(d.maturityDate) : input.date;
      if (d.accruedTo && fromDbDate(d.accruedTo) >= to) continue;
      if (!interestToAccrue(this.terms(d), d.accrued, to, this.scale(org)).gt(0)) continue;
      const after = await this.accrue(org, actorId, d.id, { date: to });
      done.push({ number: d.number, amount: new D(after.accrued).minus(d.accrued).toFixed(this.scale(org)) });
    }
    return { accrued: done };
  }

  /** Closes the deposit with what the bank paid, at maturity or early. */
  async close(org: DepositOrg, actorId: string, id: string, input: CloseInput) {
    const scale = this.scale(org);
    await this.prisma.$transaction(async (tx) => {
      await holdLock(`deposit:${id}`);
      const d = await this.find(id);
      if (d.status !== 'OPEN') this.invalid(['This deposit is already closed'], 'DEPOSIT_CLOSED');
      const received = this.money(input.received, 'The amount received', scale, false);
      const tds = this.money(input.tds || '0', 'The tax deducted', scale);
      const errors: string[] = [];
      const bankId = input.bankAccountId || d.bankAccountId;
      const chart = await this.chart(org.id, [bankId, input.tdsAccountId]);
      this.check(chart, bankId, RULES.bank, 'Receive the money into a bank or cash account', errors);
      if (tds.gt(0)) this.check(chart, input.tdsAccountId, RULES.tds, 'Claim the tax deducted in a tax receivable or other current asset account', errors);
      if (tds.gt(0) && (input.tdsAccountId === d.depositAccountId || input.tdsAccountId === d.accruedInterestAccountId)) errors.push('Claim the tax deducted in an account other than the deposit and its accrued interest');
      if (input.date < fromDbDate(d.startDate)) errors.push('The deposit cannot close before it started');
      if (d.accruedTo && input.date < fromDbDate(d.accruedTo)) errors.push(`Interest is accrued to ${fromDbDate(d.accruedTo)}; close on or after that date`);
      if (input.date > todayIso()) errors.push('The closing date cannot be in the future');
      if (errors.length) this.invalid(errors);
      const early = input.date < fromDbDate(d.maturityDate);
      const { interest, incomeNow } = depositClosing(d.principal, d.accrued, received, tds);
      if (interest.lt(0)) this.invalid([`The bank paid back less than the ${d.principal} deposited; record a loss separately`]);
      const lines = [
        { accountId: bankId, debit: received.toFixed(scale), description: `${d.number} ${early ? 'closed early' : 'matured'}` },
        ...(tds.gt(0) ? [{ accountId: input.tdsAccountId!, debit: tds.toFixed(scale), description: `${d.number} tax deducted on interest` }] : []),
        { accountId: d.depositAccountId, credit: new D(d.principal).toFixed(scale), description: `${d.number} principal returned` },
        ...(new D(d.accrued).gt(0) ? [{ accountId: d.accruedInterestAccountId, credit: new D(d.accrued).toFixed(scale), description: `${d.number} accrued interest received` }] : []),
        ...(incomeNow.gt(0) ? [{ accountId: d.interestIncomeAccountId, credit: incomeNow.toFixed(scale), description: `${d.number} interest to ${input.date}` }] : []),
        ...(incomeNow.lt(0) ? [{ accountId: d.interestIncomeAccountId, debit: incomeNow.abs().toFixed(scale), description: `${d.number} interest given up on closing early` }] : []),
      ];
      const je = await this.journals.postSystemEntry(tx, org, { id: actorId }, { date: input.date, source: 'BANK', memo: `${d.number} ${early ? 'closed early' : 'matured'}: ${d.name}`, reference: d.number, lines });
      await this.store.collection(deposits).updateOne({ id }, { $set: { status: 'CLOSED', updatedAt: new Date() } });
      await this.event(org.id, actorId, { depositId: id, kind: 'CLOSED', date: input.date, amount: received.toFixed(scale), received: received.toFixed(scale), tds: tds.toFixed(scale), interest: interest.toFixed(scale), incomeNow: incomeNow.toFixed(scale), early, entryId: je.id, note: input.note?.trim() || null });
      await this.audit.append(tx, { orgId: org.id, actorId, action: 'deposit.closed', entityType: 'deposit', entityId: id, data: { number: d.number, date: input.date, received: received.toFixed(scale), tds: tds.toFixed(scale), interest: interest.toFixed(scale), early, entryNumber: je.entryNumber } });
    });
    return this.get(org, id);
  }

  /** Reverses the latest accrual or the closing (the placement is undone by reversing to nothing). */
  async reverseLatest(org: DepositOrg, actorId: string, id: string, input: { date: string; reason: string }) {
    const reason = input.reason?.trim();
    if (!reason) this.invalid(['Say why it is being reversed']);
    await this.prisma.$transaction(async (tx) => {
      await holdLock(`deposit:${id}`);
      const d = await this.find(id);
      const e = await this.lastEvent(id);
      if (!e || e.kind === 'PLACED') this.invalid(['Nothing to reverse: only interest accruals and the closing can be reversed'], 'NOTHING_TO_REVERSE');
      const rev = await this.journals.reverseSystemEntry(tx, org, { id: actorId }, e.entryId, { date: input.date, memo: `Reversal: ${d.number} ${e.kind === 'ACCRUED' ? 'interest accrual' : 'closing'} (${reason})` });
      await this.store.collection(depositEvents).updateOne({ id: e.id }, { $set: { reversedAt: new Date(), reversalEntryId: rev.id } });
      if (e.kind === 'ACCRUED') await this.store.collection(deposits).updateOne({ id }, { $set: { accrued: e.accruedBefore ?? '0', accruedTo: e.accruedToBefore, updatedAt: new Date() } });
      else await this.store.collection(deposits).updateOne({ id }, { $set: { status: 'OPEN', updatedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId, action: 'deposit.reversed', entityType: 'deposit', entityId: id, data: { number: d.number, kind: e.kind, reason, reversalEntryId: rev.id } });
    });
    return this.get(org, id);
  }

  async list(org: DepositOrg) {
    const scale = this.scale(org);
    const rows = await this.store.collection(deposits).find({}, { sort: { status: -1, maturityDate: 1 } });
    const today = todayIso();
    const items = rows.map((d) => this.summary(d, today, scale));
    const open = items.filter((d) => d.status === 'OPEN');
    const sum = (f: (x: (typeof items)[number]) => string) => open.reduce((s, x) => s.plus(f(x)), new D(0)).toFixed(scale);
    return {
      items,
      totals: { principal: sum((x) => x.principal), accrued: sum((x) => x.accrued), earnedToDate: sum((x) => x.earnedToDate), atMaturity: sum((x) => x.maturityValue) },
      maturingIn30Days: open.filter((d) => d.daysToMaturity <= 30).length,
      can: this.can(org),
    };
  }

  private summary(d: DepositDoc, today: string, scale: number) {
    const t = this.terms(d);
    const { interest, value } = depositMaturityValue(t, scale);
    const earned = depositInterest(t, today, scale);
    const maturity = fromDbDate(d.maturityDate);
    return {
      id: d.id,
      number: d.number,
      name: d.name,
      institution: d.institution,
      institutionRef: d.institutionRef,
      principal: new D(d.principal).toFixed(scale),
      annualRate: d.annualRate,
      compounding: d.compounding,
      startDate: fromDbDate(d.startDate),
      maturityDate: maturity,
      status: d.status,
      accrued: new D(d.accrued).toFixed(scale),
      accruedTo: d.accruedTo ? fromDbDate(d.accruedTo) : null,
      earnedToDate: earned.toFixed(scale),
      /** Earned to today but not accrued in the books yet. */
      notAccrued: d.status === 'OPEN' ? interestToAccrue(t, d.accrued, today, scale).toFixed(scale) : new D(0).toFixed(scale),
      maturityInterest: interest.toFixed(scale),
      maturityValue: value.toFixed(scale),
      daysToMaturity: Math.round((Date.parse(`${maturity}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
    };
  }

  async get(org: DepositOrg, id: string) {
    const scale = this.scale(org);
    const d = await this.find(id);
    const events = await this.store.collection(depositEvents).find({ depositId: id }, { sort: { date: 1, createdAt: 1 } });
    const chart = await this.chart(org.id, [d.bankAccountId, d.depositAccountId, d.accruedInterestAccountId, d.interestIncomeAccountId]);
    const names = await this.names(events.map((e) => e.createdById));
    const acc = (aid: string) => {
      const a = chart.get(aid);
      return a ? { id: a.id, code: a.code, name: a.name } : { id: aid, code: '', name: '' };
    };
    const latest = events.filter((e) => !e.reversedAt).at(-1);
    return {
      ...this.summary(d, todayIso(), scale),
      can: this.can(org),
      accounts: { bank: acc(d.bankAccountId), deposit: acc(d.depositAccountId), accruedInterest: acc(d.accruedInterestAccountId), interestIncome: acc(d.interestIncomeAccountId) },
      events: events.map((e) => ({
        id: e.id,
        kind: e.kind,
        date: fromDbDate(e.date),
        amount: new D(e.amount).toFixed(scale),
        received: e.received,
        tds: e.tds,
        interest: e.interest,
        incomeNow: e.incomeNow,
        early: e.early,
        entryId: e.entryId,
        reversed: !!e.reversedAt,
        reversalEntryId: e.reversalEntryId,
        note: e.note,
        by: names.get(e.createdById) ?? null,
        canReverse: !!latest && latest.id === e.id && e.kind !== 'PLACED',
      })),
    };
  }

  /** Accounts that fit each role, for the form. */
  async accountChoices() {
    const rows = (await this.store.collection(accounts).find({ isPostable: true, isActive: true }, { sort: { code: 1 } })) as unknown as Acc[];
    const pick = (ok: (a: Acc) => boolean) => rows.filter(ok).map((a) => ({ id: a.id, code: a.code, name: a.name }));
    // Tax deducted is usually claimed in a tax receivable account, so those come first.
    const tds = [...pick((a) => RULES.tds(a) && a.subtype === 'TAX_RECEIVABLE'), ...pick((a) => RULES.tds(a) && a.subtype !== 'TAX_RECEIVABLE')];
    return { bank: pick(RULES.bank), deposit: pick(RULES.deposit), accruedInterest: pick(RULES.accrued), interestIncome: pick(RULES.income), tds };
  }

  private async names(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'deposit', entityId, data }));
  }
}
