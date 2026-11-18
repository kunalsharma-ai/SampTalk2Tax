import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, Dec } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { ByHead, GST_HEADS, gstPeriodRange, gstSetOff, GstSetOff } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { GstPaymentDoc, gstPayments } from '../db/collections/gst-payments';
import { users } from '../db/collections/identity';
import { nextCounter } from '../db/counters';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { JournalsService } from '../journals/journals.service';
import { GstService } from './gst.service';

export interface GstPaymentInput {
  period: string;
  paymentDate: string;
  bankAccountId: string | null;
  cpin: string | null;
  cin: string | null;
  interest: string;
  lateFee: string;
  chargesAccountId: string | null;
  memo: string | null;
}

type Heads = { igst: string; cgst: string; sgst: string };
const LABEL = { igst: 'IGST', cgst: 'CGST', sgst: 'SGST' } as const;

/**
 * GST payments (TAX-022). MongoDB only. For a return month: the tax payable and the credit
 * available in the books at the month's end, set off in the order the CGST Act requires, and
 * the cash to pay by PMT-06. Recording it posts one journal: the output tax accounts debited,
 * the input tax credit accounts credited with the credit used, and the bank credited with the
 * cash, interest and late fee. Months are settled in order; only the latest payment can be
 * voided. reports.read sees them; recording and voiding need journals.post.
 */
@Injectable()
export class GstPaymentsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly gst: GstService,
  ) {}

  private async registration(orgId: string) {
    const reg = await this.prisma.gstRegistration.findUnique({ where: { orgId } });
    if (!reg) throw new DomainError('GST_NOT_REGISTERED', 'Set up the GST registration first (Settings → GST)', HttpStatus.CONFLICT);
    return reg;
  }

  private range(period: string) {
    try {
      return gstPeriodRange(period);
    } catch {
      throw new DomainError('INVALID_PERIOD', 'Give the month as YYYY-MM', HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * What the month leaves to settle: the output and input account balances at its end, less
   * what payments for it or earlier months dated after its end have already settled.
   */
  async preview(org: OrgContext, period: string) {
    const reg = await this.registration(org.id);
    const { from, to } = this.range(period);
    const output: ByHead<string> = { igst: reg.outputIgstAccountId, cgst: reg.outputCgstAccountId, sgst: reg.outputSgstAccountId };
    const input: ByHead<string> = { igst: reg.inputIgstAccountId, cgst: reg.inputCgstAccountId, sgst: reg.inputSgstAccountId };
    const ids = [...Object.values(output), ...Object.values(input)];
    const sums = await lineSums(this.store, org.id, { entry: postedBetween(null, toDbDate(to)), line: { accountId: { $in: ids } }, by: { accountId: 'lines.accountId' } });
    const bal = (id: string, creditSide: boolean) => {
      const s = sums.find((x) => x.key.accountId === id);
      return s ? (creditSide ? s.credit.minus(s.debit) : s.debit.minus(s.credit)) : new D(0);
    };
    const liability = { igst: bal(output.igst, true), cgst: bal(output.cgst, true), sgst: bal(output.sgst, true) };
    const credit = { igst: bal(input.igst, false), cgst: bal(input.cgst, false), sgst: bal(input.sgst, false) };
    const later = await this.store.collection(gstPayments).find({ status: 'POSTED', period: { $lte: period }, paymentDate: { $gt: toDbDate(to) } });
    for (const p of later) {
      for (const h of GST_HEADS) {
        liability[h] = liability[h].minus(p.cash[h]).minus(this.paidByCredit(p)[h]);
        credit[h] = credit[h].minus(p.creditUsed[h]);
      }
    }
    // Reverse-charge tax on the month's bills can only be paid in cash.
    const rcm = (await this.gst.gstr3b(org.id, from, to)).reverseChargeCash;
    const r = gstSetOff(liability, credit, rcm);
    const latest = await this.store.collection(gstPayments).findOne({ status: 'POSTED' }, { sort: { period: -1, createdAt: -1 } });
    const blocked = latest && latest.period > period ? `A payment for ${latest.period} is already recorded; months are settled in order` : null;
    const totalCash = GST_HEADS.reduce((s, h) => s.plus(r.cash[h]), new D(0));
    const totalLiability = GST_HEADS.reduce((s, h) => s.plus(r.liability[h]), new D(0));
    return {
      period,
      from,
      to,
      currency: 'INR',
      liability: heads(r.liability),
      credit: heads(r.credit),
      uses: r.uses.map((u) => ({ from: u.from, against: u.against, amount: m(u.amount), label: `${LABEL[u.from]} credit against ${LABEL[u.against]}` })),
      creditUsed: heads(r.creditUsed),
      paidByCredit: heads(r.paidByCredit),
      cash: heads(r.cash),
      reverseCharge: heads(r.reverseCharge),
      creditLeft: heads(r.creditLeft),
      totalCash: m(totalCash),
      nothingToPay: totalLiability.isZero(),
      blocked,
      _setOff: r,
    };
  }

  private paidByCredit(p: Pick<GstPaymentDoc, 'uses'>): ByHead {
    const out: ByHead = { igst: new D(0), cgst: new D(0), sgst: new D(0) };
    for (const u of p.uses) out[u.against] = out[u.against].plus(u.amount);
    return out;
  }

  async list(org: OrgContext) {
    await this.registration(org.id);
    const rows = await this.store.collection(gstPayments).find({}, { sort: { period: -1, createdAt: -1 }, limit: 200 });
    const accts = await this.store.collection(accounts).find({ id: { $in: [...new Set(rows.flatMap((r) => [r.bankAccountId, r.chargesAccountId]).filter((x): x is string => !!x))] } });
    const names = await this.names(rows.flatMap((r) => [r.createdById, r.voidedById]));
    const latest = rows.find((r) => r.status === 'POSTED');
    return rows.map((r) => this.serialize(r, accts, names, latest?.id === r.id));
  }

  private serialize(r: GstPaymentDoc, accts: { id: string; code: string; name: string }[], names: Map<string, string>, canVoid: boolean) {
    const acc = (id: string | null) => (id ? (accts.find((a) => a.id === id) ?? { id, code: '', name: 'Unknown account' }) : null);
    const cash = GST_HEADS.reduce((s, h) => s.plus(r.cash[h]), new D(0));
    return {
      id: r.id,
      number: r.number,
      period: r.period,
      paymentDate: fromDbDate(r.paymentDate),
      liability: heads(r.liability),
      credit: heads(r.credit),
      uses: r.uses.map((u) => ({ from: u.from, against: u.against, amount: m(new D(u.amount)), label: `${LABEL[u.from]} credit against ${LABEL[u.against]}` })),
      creditUsed: heads(r.creditUsed),
      cash: heads(r.cash),
      totalCash: m(cash),
      interest: m(new D(r.interest)),
      lateFee: m(new D(r.lateFee)),
      totalPaid: m(cash.plus(r.interest).plus(r.lateFee)),
      bankAccount: acc(r.bankAccountId),
      chargesAccount: acc(r.chargesAccountId),
      cpin: r.cpin,
      cin: r.cin,
      memo: r.memo,
      journalEntryId: r.journalEntryId,
      status: r.status,
      voidReason: r.voidReason,
      reversalEntryId: r.reversalEntryId,
      createdBy: names.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
      voidedBy: r.voidedById ? (names.get(r.voidedById) ?? null) : null,
      voidedAt: r.voidedAt?.toISOString() ?? null,
      canVoid: canVoid && r.status === 'POSTED',
    };
  }

  async create(org: OrgContext, actorId: string, input: GstPaymentInput) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot record GST payments; it needs journals.post`, HttpStatus.FORBIDDEN);
    const reg = await this.registration(org.id);
    const p = await this.preview(org, input.period);
    const issues: string[] = [];
    if (p.blocked) throw new DomainError('OUT_OF_ORDER', p.blocked, HttpStatus.CONFLICT);
    if (p.nothingToPay) throw new DomainError('NOTHING_TO_PAY', `There is no GST payable for ${input.period} in the books`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.paymentDate <= p.to) issues.push(`The payment date must be after the month (${p.to})`);
    if (input.paymentDate > todayIso()) issues.push('The payment date cannot be in the future');
    const money = (v: string, what: string) => {
      const d = /^\d{1,15}(\.\d{1,2})?$/.test(v.trim()) ? new D(v.trim()) : null;
      if (!d) issues.push(`${what}: enter an amount in rupees and paise`);
      return d ?? new D(0);
    };
    const interest = money(input.interest || '0', 'Interest');
    const lateFee = money(input.lateFee || '0', 'Late fee');
    const s = p._setOff;
    const cash = GST_HEADS.reduce((t, h) => t.plus(s.cash[h]), new D(0));
    const outgoing = cash.plus(interest).plus(lateFee);
    const cpin = input.cpin?.trim().toUpperCase() || null;
    const cin = input.cin?.trim().toUpperCase() || null;
    if (outgoing.gt(0)) {
      if (!input.bankAccountId) issues.push('Choose the bank account the challan was paid from');
      if (!cin) issues.push('Enter the CIN the bank gave for the challan');
      if (cpin && !/^[0-9A-Z]{14}$/.test(cpin)) issues.push('The CPIN has 14 letters and digits');
      if (cin && !/^[0-9A-Z]{6,30}$/.test(cin)) issues.push('The CIN has 6 to 30 letters and digits');
    }
    const chart = await this.store.collection(accounts).find({ id: { $in: [input.bankAccountId, input.chargesAccountId].filter((x): x is string => !!x) } });
    const bank = outgoing.gt(0) && input.bankAccountId ? chart.find((a) => a.id === input.bankAccountId) : null;
    if (outgoing.gt(0) && input.bankAccountId && (!bank || !bank.isPostable || !bank.isActive || !['BANK', 'CASH'].includes(bank.subtype ?? ''))) issues.push('Choose an active bank or cash account');
    if (interest.plus(lateFee).gt(0)) {
      const c = input.chargesAccountId ? chart.find((a) => a.id === input.chargesAccountId) : null;
      if (!c || !c.isPostable || !c.isActive || c.type !== 'EXPENSE') issues.push('Choose an active expense account for the interest and late fee');
    }
    if (issues.length) throw new DomainError('INVALID_GST_PAYMENT', issues.length === 1 ? issues[0] : `${issues.length} problems with the payment`, HttpStatus.UNPROCESSABLE_ENTITY, { issues });

    const output: ByHead<string> = { igst: reg.outputIgstAccountId, cgst: reg.outputCgstAccountId, sgst: reg.outputSgstAccountId };
    const inputAcc: ByHead<string> = { igst: reg.inputIgstAccountId, cgst: reg.inputCgstAccountId, sgst: reg.inputSgstAccountId };
    const c = org.functionalCurrency;
    const lines = [
      ...GST_HEADS.filter((h) => s.cash[h].plus(s.paidByCredit[h]).gt(0)).map((h) => ({ accountId: output[h], currency: c, debit: s.cash[h].plus(s.paidByCredit[h]).toFixed(), description: `${LABEL[h]} for ${input.period} settled` })),
      ...GST_HEADS.filter((h) => s.creditUsed[h].gt(0)).map((h) => ({ accountId: inputAcc[h], currency: c, credit: s.creditUsed[h].toFixed(), description: `${LABEL[h]} credit used for ${input.period}` })),
      ...(interest.plus(lateFee).gt(0) ? [{ accountId: input.chargesAccountId!, currency: c, debit: interest.plus(lateFee).toFixed(), description: `GST interest ${m(interest)} and late fee ${m(lateFee)} for ${input.period}` }] : []),
      ...(outgoing.gt(0) ? [{ accountId: bank!.id, currency: c, credit: outgoing.toFixed(), description: `GST challan ${cin}${cpin ? ` (CPIN ${cpin})` : ''}` }] : []),
    ];
    const { je, number } = await this.prisma.$transaction(async (tx) => {
      const n = `GSTP-${String(await nextCounter(tx, org.id, 'doc:GST_PAYMENT')).padStart(6, '0')}`;
      const entry = await this.journals.postSystemEntry(tx, org, { id: actorId }, { date: input.paymentDate, source: 'TAX', memo: `${n} · GST for ${input.period}${cin ? ` · challan ${cin}` : ' · set off by credit'}${input.memo ? ` · ${input.memo}` : ''}`, reference: n, lines });
      return { je: entry, number: n };
    });
    const str = (x: ByHead): Heads => ({ igst: x.igst.toFixed(), cgst: x.cgst.toFixed(), sgst: x.sgst.toFixed() });
    let id: string;
    try {
      id = (
        await this.store.collection(gstPayments).insertOne({
          orgId: org.id,
          number,
          period: input.period,
          paymentDate: toDbDate(input.paymentDate),
          liability: str(s.liability),
          credit: str(s.credit),
          uses: s.uses.map((u) => ({ from: u.from, against: u.against, amount: u.amount.toFixed() })),
          creditUsed: str(s.creditUsed),
          cash: str(s.cash),
          interest: interest.toFixed(),
          lateFee: lateFee.toFixed(),
          chargesAccountId: interest.plus(lateFee).gt(0) ? input.chargesAccountId : null,
          bankAccountId: outgoing.gt(0) ? bank!.id : null,
          cpin: outgoing.gt(0) ? cpin : null,
          cin: outgoing.gt(0) ? cin : null,
          memo: input.memo?.trim() || null,
          journalEntryId: je.id,
          status: 'POSTED',
          voidReason: null,
          reversalEntryId: null,
          createdById: actorId,
          createdAt: new Date(),
          voidedById: null,
          voidedAt: null,
        })
      ).id;
    } catch (e) {
      await this.prisma.$transaction((tx) => this.journals.reverseSystemEntry(tx, org, { id: actorId }, je.id, { date: input.paymentDate, memo: `${number} not saved` }));
      throw e;
    }
    await this.log(org.id, actorId, 'gst_payment.recorded', id, { number, period: input.period, cash: cash.toFixed(), interest: interest.toFixed(), lateFee: lateFee.toFixed(), cin, cpin, journalEntryId: je.id });
    return (await this.list(org)).find((r) => r.id === id)!;
  }

  async void(org: OrgContext, actorId: string, id: string, input: { date: string; reason: string }) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot void GST payments; it needs journals.post`, HttpStatus.FORBIDDEN);
    const p = await this.store.collection(gstPayments).findById(id);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'GST payment not found' });
    if (p.status !== 'POSTED') throw new DomainError('ALREADY_VOID', 'This payment is already void', HttpStatus.CONFLICT);
    const latest = await this.store.collection(gstPayments).findOne({ status: 'POSTED' }, { sort: { period: -1, createdAt: -1 } });
    if (latest && latest.id !== p.id) throw new DomainError('NOT_LATEST', `Void the payment for ${latest.period} (${latest.number}) first; months are settled in order`, HttpStatus.CONFLICT);
    const reason = input.reason.trim();
    if (reason.length < 3) throw new DomainError('INVALID_REASON', 'Say why the payment is void', HttpStatus.UNPROCESSABLE_ENTITY);
    const rev = await this.prisma.$transaction((tx) => this.journals.reverseSystemEntry(tx, org, { id: actorId }, p.journalEntryId, { date: input.date, memo: `Void ${p.number}: ${reason}` }));
    await this.store.collection(gstPayments).updateOne({ id }, { $set: { status: 'VOID', voidReason: reason, reversalEntryId: rev.id, voidedById: actorId, voidedAt: new Date() } });
    await this.log(org.id, actorId, 'gst_payment.voided', id, { number: p.number, reason, reversalEntryId: rev.id });
    return (await this.list(org)).find((r) => r.id === id)!;
  }

  /** Posted payments by month, for the compliance calendar. */
  async byMonth(orgId: string, months: string[]) {
    if (!months.length) return [];
    const rows = await this.store.collection(gstPayments).find({ orgId, status: 'POSTED', period: { $in: months } });
    return rows.map((r) => ({ id: r.id, number: r.number, period: r.period, cin: r.cin, cash: GST_HEADS.reduce((s, h) => s.plus(r.cash[h]), new D(0)) }));
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'gst_payment', entityId, data }));
  }
}

const m = (x: Dec) => x.toFixed(2);
const heads = (x: ByHead<Dec | string>) => ({ igst: m(new D(x.igst.toString())), cgst: m(new D(x.cgst.toString())), sgst: m(new D(x.sgst.toString())) });
export type { GstSetOff };
