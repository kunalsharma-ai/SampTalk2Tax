import { HttpStatus, Injectable } from '@nestjs/common';
import { D, toFunctional } from '@talk2tax/accounting-engine';
import {
  taxPeriodChange,
  VAT_STAGGER_LABEL,
  vatJurisdiction,
  vatReturnCsv,
  type TaxReturnCorrection,
  type VatEntry,
  type VatJurisdiction,
  type VatRateInfo,
  type VatStagger,
  type VatTreatment,
} from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { vatReturns, vatSettings, type VatReturnDoc, type VatSettingsDoc } from '../db/collections/vat-returns';

export interface VatSettingsBody {
  vrn: string;
  registeredFrom: string;
  stagger: VatStagger;
  untaxedTreatment: VatTreatment;
  treatments: { taxRateId: string; treatment: VatTreatment }[];
}

const PERIODS_SHOWN = 8;

/**
 * VAT and GST returns (TAX-030 United Kingdom, TAX-036 Singapore, TAX-041 one jurisdiction at a
 * time): the boxes for a period, prepared from posted invoices, credit notes, bills, vendor
 * credits and approved expense claims with the country's rules (vatJurisdiction); changes to
 * periods already submitted carried as corrections when within the authority's limit; entries on
 * the tax accounts that are not on the return listed for checking; and a record of each return
 * the business submitted. Books kept in the country's currency only. reports.read reads;
 * accounts.manage sets the registration up and records submissions. Nothing is sent to HMRC, IRAS, the ATO or the CRA.
 */
const direction = (output = '0', input = '0'): 'PAY' | 'RECLAIM' | 'NIL' => (new D(output).gt(input) ? 'PAY' : new D(output).lt(input) ? 'RECLAIM' : 'NIL');

@Injectable()
export class VatReturnService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The organisation's VAT or GST return rules: the UK, Singapore and Australia, in their own currency. */
  private async jurisdiction(org: OrgContext): Promise<VatJurisdiction> {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    const j = vatJurisdiction(o.countryCode);
    if (!j) throw new DomainError('NO_VAT_RETURN', 'A VAT or GST return is prepared here for organisations in the United Kingdom, Singapore, Australia and Canada', HttpStatus.UNPROCESSABLE_ENTITY);
    if (org.functionalCurrency !== j.currency) throw new DomainError('WRONG_CURRENCY', `The ${j.returnName} is prepared from books kept in ${j.currency}`, HttpStatus.UNPROCESSABLE_ENTITY);
    return j;
  }

  private async rates(org: OrgContext, j: VatJurisdiction, s: VatSettingsDoc | null): Promise<(VatRateInfo & { isActive: boolean; suggested: VatTreatment | null; salesAccountId: string | null; purchaseAccountId: string | null })[]> {
    const set = new Map((s?.treatments ?? []).map((t) => [t.taxRateId, t.treatment as VatTreatment]));
    const rows = await this.prisma.taxRate.findMany({ where: { orgId: org.id }, select: { id: true, name: true, rate: true, isActive: true, salesAccountId: true, purchaseAccountId: true }, orderBy: [{ rate: 'desc' }, { name: 'asc' }] });
    return rows.map((r) => ({ id: r.id, name: r.name, rate: r.rate.toFixed(), isActive: r.isActive, treatment: set.get(r.id) ?? null, suggested: j.suggest(r.rate.toFixed(), r.name), salesAccountId: r.salesAccountId, purchaseAccountId: r.purchaseAccountId }));
  }

  private stored(org: OrgContext) {
    return this.store.collection(vatSettings).findOne({});
  }

  private async required(org: OrgContext, j: VatJurisdiction) {
    const s = await this.stored(org);
    if (!s) throw new DomainError('VAT_NOT_SET_UP', `Add your ${j.numberName} and return periods first`, HttpStatus.UNPROCESSABLE_ENTITY);
    return s;
  }

  // ---- settings ----

  /** What the page says for this country. */
  private describe(j: VatJurisdiction) {
    return { country: j.country, currency: j.currency, taxName: j.taxName, returnName: j.returnName, authority: j.authority, authorityThe: j.authorityThe, unitsNote: j.unitsNote, numberName: j.numberName, numberShort: j.numberShort, numberHint: j.numberHint, dueRule: j.dueRule, netBox: j.netBox, wholeBoxes: j.wholeBoxes, intro: j.intro, treatmentNote: j.treatmentNote, overLimit: j.overLimit, correctionRule: j.correctionRule ?? null, cardTitles: j.cardTitles };
  }

  async settings(org: OrgContext) {
    const j = await this.jurisdiction(org);
    const s = await this.stored(org);
    const rates = await this.rates(org, j, s);
    const by = s ? await this.store.collection(users).findById(s.updatedById) : null;
    return {
      settings: s ? { vrn: s.vrn, registeredFrom: s.registeredFrom, stagger: s.stagger, untaxedTreatment: s.untaxedTreatment, updatedAt: s.updatedAt.toISOString(), updatedBy: by?.name ?? 'Former member' } : null,
      rates: rates.map(({ salesAccountId: _s, purchaseAccountId: _p, ...r }) => r),
      staggers: j.staggers.map((k) => ({ key: k, label: VAT_STAGGER_LABEL[k] })),
      treatments: j.treatments.map((k) => ({ key: k, label: j.treatmentLabel[k] })),
      jurisdiction: this.describe(j),
    };
  }

  async saveSettings(org: OrgContext, user: AuthUser, body: VatSettingsBody) {
    const j = await this.jurisdiction(org);
    const vrn = j.normaliseNumber(body.vrn);
    if (!vrn) throw new DomainError('INVALID_VRN', j.invalidNumber, HttpStatus.UNPROCESSABLE_ENTITY);
    const wrong = body.treatments.find((t) => !j.treatments.includes(t.treatment)) ?? (j.treatments.includes(body.untaxedTreatment) ? null : { treatment: body.untaxedTreatment });
    if (wrong) throw new DomainError('VALIDATION_FAILED', `${j.treatmentLabel[wrong.treatment]} is not a treatment in ${j.countryName}`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (!j.staggers.includes(body.stagger)) throw new DomainError('VALIDATION_FAILED', `${VAT_STAGGER_LABEL[body.stagger]} returns are not a return cycle ${j.authority} uses`, HttpStatus.UNPROCESSABLE_ENTITY);
    const known = new Set((await this.prisma.taxRate.findMany({ where: { orgId: org.id }, select: { id: true } })).map((r) => r.id));
    const unknown = body.treatments.filter((t) => !known.has(t.taxRateId));
    if (unknown.length) throw new DomainError('UNKNOWN_TAX_RATE', 'A tax rate in the list is not one of this organisation’s', HttpStatus.UNPROCESSABLE_ENTITY);
    const treatments = [...new Map(body.treatments.map((t) => [t.taxRateId, t])).values()];
    const col = this.store.collection(vatSettings);
    const before = await col.findOne({});
    if (body.registeredFrom > todayIso()) throw new DomainError('VALIDATION_FAILED', 'The registration date cannot be in the future', HttpStatus.UNPROCESSABLE_ENTITY);
    const fields = { vrn, registeredFrom: body.registeredFrom, stagger: body.stagger, untaxedTreatment: body.untaxedTreatment, treatments, updatedById: user.id, updatedAt: new Date() };
    if (before) await col.updateOne({ id: before.id }, { $set: fields });
    else await col.insertOne(fields);
    const changed = (k: 'vrn' | 'registeredFrom' | 'stagger' | 'untaxedTreatment') => (before?.[k] !== fields[k] ? { [k]: { from: before?.[k] ?? null, to: fields[k] } } : {});
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'vat_settings.updated', entityType: 'vat_settings', entityId: org.id, data: { ...changed('vrn'), ...changed('registeredFrom'), ...changed('stagger'), ...changed('untaxedTreatment'), treatments: treatments.length } }),
    );
    return this.settings(org);
  }

  // ---- the books ----

  /** Every line on the return for a period, in the books' currency, with the journal entries they posted. */
  private async entries(org: OrgContext, from: string, to: string) {
    const cur = org.functionalCurrency;
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    const kinds = { in: ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'] as ('INVOICE' | 'CREDIT_NOTE' | 'BILL' | 'VENDOR_CREDIT')[] };
    const docSelect = { id: true, kind: true, number: true, issueDate: true, voidDate: true, exchangeRate: true, journalEntryId: true, voidJournalEntryId: true, lines: { select: { taxRateId: true, taxRate: true, netAmount: true, taxAmount: true } } } as const;
    const claimSelect = { id: true, number: true, postingDate: true, voidDate: true, journalEntryId: true, voidJournalEntryId: true, lines: { select: { taxRateId: true, taxRate: true, netAmount: true, taxAmount: true } } } as const;
    const [issued, voided, claims, voidedClaims] = await Promise.all([
      this.prisma.document.findMany({ where: { orgId: org.id, kind: kinds, status: { in: ['POSTED', 'VOID'] }, issueDate: range }, select: docSelect }),
      this.prisma.document.findMany({ where: { orgId: org.id, kind: kinds, status: 'VOID', voidDate: range }, select: docSelect }),
      this.prisma.expenseClaim.findMany({ where: { orgId: org.id, status: { in: ['APPROVED', 'REIMBURSED', 'VOID'] }, postingDate: range }, select: claimSelect }),
      this.prisma.expenseClaim.findMany({ where: { orgId: org.id, status: 'VOID', voidDate: range }, select: claimSelect }),
    ]);
    const out: VatEntry[] = [];
    const journals = new Set<string>();
    const local = (v: { toFixed(): string }, rate: string) => toFunctional(new D(v.toFixed()), rate, cur).toFixed(2);
    const fromDoc = (d: (typeof issued)[number], reversal: boolean) => {
      const rate = d.exchangeRate.toFixed();
      const j = reversal ? d.voidJournalEntryId : d.journalEntryId;
      if (j) journals.add(j);
      for (const l of d.lines) out.push({ source: d.kind, id: d.id, number: d.number ?? 'Draft', date: reversal && d.voidDate ? fromDbDate(d.voidDate) : fromDbDate(d.issueDate), ...(reversal ? { reversal: true } : {}), taxRateId: l.taxRateId, rate: l.taxRate.toFixed(), net: local(l.netAmount, rate), vat: local(l.taxAmount, rate) });
    };
    const fromClaim = (c: (typeof claims)[number], reversal: boolean) => {
      const j = reversal ? c.voidJournalEntryId : c.journalEntryId;
      if (j) journals.add(j);
      const date = reversal ? c.voidDate : c.postingDate;
      for (const l of c.lines) out.push({ source: 'EXPENSE_CLAIM', id: c.id, number: c.number, date: date ? fromDbDate(date) : from, ...(reversal ? { reversal: true } : {}), taxRateId: l.taxRateId, rate: l.taxRate.toFixed(), net: l.netAmount.toFixed(2), vat: l.taxAmount.toFixed(2) });
    };
    for (const d of issued) fromDoc(d, false);
    for (const d of voided) fromDoc(d, true);
    for (const c of claims) fromClaim(c, false);
    for (const c of voidedClaims) fromClaim(c, true);
    out.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
    return { entries: out, journals };
  }

  /** Posted entries in the period on the VAT accounts that no document or claim on the return made: VAT paid to HMRC, manual journals and the like. */
  private async otherVatEntries(org: OrgContext, from: string, to: string, onReturn: Set<string>, rates: { salesAccountId: string | null; purchaseAccountId: string | null }[]) {
    const taxAccounts = (await this.store.collection(accounts).find({ subtype: { $in: ['TAX_PAYABLE', 'TAX_RECEIVABLE'] } }, { projection: { id: 1, code: 1, name: 1 } })) as { id: string; code: string; name: string }[];
    const ids = new Set([...taxAccounts.map((a) => a.id), ...rates.flatMap((r) => [r.salesAccountId, r.purchaseAccountId]).filter((x): x is string => !!x)]);
    if (!ids.size) return [];
    const names = new Map(taxAccounts.map((a) => [a.id, `${a.code} · ${a.name}`]));
    const rows = (await this.store.collection(journalEntries).find({ status: 'POSTED', date: { $gte: toDbDate(from), $lte: toDbDate(to) }, 'lines.accountId': { $in: [...ids] } }, { sort: { date: 1, entryNumber: 1 }, limit: 500 })) as unknown as {
      id: string;
      entryNumber: number | null;
      date: Date;
      memo: string | null;
      source: string;
      lines: { accountId: string; functionalDebit: unknown; functionalCredit: unknown }[];
    }[];
    return rows
      .filter((e) => !onReturn.has(e.id))
      .map((e) => {
        const ls = e.lines.filter((l) => ids.has(l.accountId));
        const debit = ls.reduce((a, l) => a.plus(String(l.functionalDebit)), new D(0));
        const credit = ls.reduce((a, l) => a.plus(String(l.functionalCredit)), new D(0));
        return { id: e.id, number: e.entryNumber, date: fromDbDate(e.date), memo: e.memo, source: e.source, accounts: [...new Set(ls.map((l) => names.get(l.accountId) ?? 'VAT account'))], debit: debit.toFixed(2), credit: credit.toFixed(2) };
      });
  }

  /** Revenue for the period from the ledger (credits less debits on revenue accounts, closing entries left out). */
  private async revenue(org: OrgContext, from: string, to: string) {
    const ids = ((await this.store.collection(accounts).find({ type: 'REVENUE' }, { projection: { id: 1 } })) as { id: string }[]).map((a) => a.id);
    if (!ids.length) return '0';
    const sums = await lineSums(this.store, org.id, { entry: postedBetween(toDbDate(from), toDbDate(to), { excludeClosing: true }), line: { accountId: { $in: ids } }, by: {} });
    return sums.reduce((a, x) => a.plus(x.credit).minus(x.debit), new D(0)).toFixed(2);
  }

  private async figures(org: OrgContext, j: VatJurisdiction, s: VatSettingsDoc, from: string, to: string, corrections: TaxReturnCorrection[] = []) {
    const rates = await this.rates(org, j, s);
    const { entries, journals } = await this.entries(org, from, to);
    const revenue = j.needsRevenue ? await this.revenue(org, from, to) : '0';
    const r = j.compute(entries, rates, { untaxed: s.untaxedTreatment as VatTreatment, revenue, corrections });
    return { rates, entries, journals, r };
  }

  // ---- periods and returns ----

  /** Submitted returns, oldest first, with their own figures and corrections as output and input tax (returns recorded before Singapore was added kept UK box names). */
  private async recorded() {
    const rows = await this.store.collection(vatReturns).find({}, { sort: { periodEnd: 1 } });
    type Legacy = Record<string, string | undefined>;
    return rows.map((r) => {
      const own = r.own as unknown as Legacy;
      return {
        ...r,
        own: { output: own.output ?? own.box1 ?? '0', input: own.input ?? own.box4 ?? '0', supplies: own.supplies ?? own.box6 ?? '0', purchases: own.purchases ?? own.box7 ?? '0' },
        corrections: r.corrections.map((c) => {
          const x = c as unknown as Legacy;
          return { periodEnd: c.periodEnd, output: x.output ?? x.box1 ?? '0', input: x.input ?? x.box4 ?? '0' };
        }),
      };
    });
  }

  async periods(org: OrgContext, today = todayIso()) {
    const j = await this.jurisdiction(org);
    const s = await this.stored(org);
    if (!s) return { setUp: false, periods: [], jurisdiction: this.describe(j) };
    const filed = new Map((await this.recorded()).map((r) => [r.periodEnd, r]));
    const periods = j.recentPeriods(s.stagger as VatStagger, today, PERIODS_SHOWN).filter((p) => p.end >= s.registeredFrom).map((p) => {
      const f = filed.get(p.end);
      const status = f ? 'SUBMITTED' : p.end >= today ? 'OPEN' : p.due < today ? 'OVERDUE' : 'DUE';
      return { ...p, start: p.start < s.registeredFrom ? s.registeredFrom : p.start, status, submittedOn: f?.submittedOn ?? null, net: f ? (f.boxes[j.netBox] ?? null) : null, direction: f ? direction(f.boxes[j.outputBox], f.boxes[j.inputBox]) : null };
    });
    // Returns recorded under an earlier stagger stay listed.
    const shown = new Set(periods.map((p) => p.end));
    const older = [...filed.values()].filter((f) => !shown.has(f.periodEnd) && f.periodEnd < (periods.at(-1)?.start ?? today)).slice(-PERIODS_SHOWN);
    return { setUp: true, stagger: s.stagger, vrn: s.vrn, periods, older: older.reverse().map((f) => ({ start: f.periodStart, end: f.periodEnd, submittedOn: f.submittedOn, net: f.boxes[j.netBox] ?? null })), jurisdiction: this.describe(j) };
  }

  private period(j: VatJurisdiction, s: VatSettingsDoc, end: string, filed: { periodStart: string; periodEnd: string } | undefined) {
    if (filed) return { start: filed.periodStart, end: filed.periodEnd, due: j.dueDate(filed.periodEnd, s.stagger as VatStagger) };
    const p = j.periodFor(s.stagger as VatStagger, end);
    if (!p) throw new DomainError('NOT_A_PERIOD', `${end} is not the last day of a ${j.taxName} period on your return cycle`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (end < s.registeredFrom) throw new DomainError('BEFORE_REGISTRATION', `The period ends before your ${j.taxName} registration took effect on ${s.registeredFrom}`, HttpStatus.UNPROCESSABLE_ENTITY);
    // The first return starts on the registration date.
    return p.start < s.registeredFrom ? { ...p, start: s.registeredFrom } : p;
  }

  /** Changes to submitted periods since they were submitted (within the years a correction is allowed), less corrections already made. */
  private async changes(org: OrgContext, j: VatJurisdiction, s: VatSettingsDoc, start: string, filed: Awaited<ReturnType<VatReturnService['recorded']>>) {
    const back = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 - j.correctionMonths; // not money: months
    const earliest = `${Math.floor(back / 12)}-${String((back % 12) + 1).padStart(2, '0')}${start.slice(7)}`; // not money
    const out: (TaxReturnCorrection & { net: string; periodStart: string })[] = [];
    for (const f of filed.filter((x) => x.periodEnd < start && x.periodEnd >= earliest)) {
      const now = (await this.figures(org, j, s, f.periodStart, f.periodEnd)).r.own;
      const done = filed.flatMap((x) => x.corrections.filter((c) => c.periodEnd === f.periodEnd));
      const c = taxPeriodChange(f.own, now, done);
      if (c.changed) out.push({ periodStart: f.periodStart, periodEnd: f.periodEnd, output: c.output, input: c.input, net: c.net });
    }
    return out;
  }

  async vatReturn(org: OrgContext, periodEnd: string, today = todayIso()) {
    const j = await this.jurisdiction(org);
    const s = await this.required(org, j);
    const filed = await this.recorded();
    const mine = filed.find((f) => f.periodEnd === periodEnd);
    const p = this.period(j, s, periodEnd, mine);
    const due = p.due;

    const pending = mine ? [] : await this.changes(org, j, s, p.start, filed);
    const first = await this.figures(org, j, s, p.start, p.end);
    const allowance = j.correctionAllowance(pending, first.r.own);
    const included = !mine && pending.length && allowance.allowed ? pending : mine ? mine.corrections : [];
    const { r, entries, journals, rates } = included.length ? await this.figures(org, j, s, p.start, p.end, included) : first;
    const other = await this.otherVatEntries(org, p.start, p.end, journals, rates);
    const byRate = new Map(rates.map((x) => [x.id, x]));
    const treatmentOf = (e: VatEntry) => (e.taxRateId ? (byRate.get(e.taxRateId)?.treatment ?? byRate.get(e.taxRateId)?.suggested ?? 'UNCLASSIFIED') : s.untaxedTreatment);

    let submitted = null;
    if (mine) {
      const by = await this.store.collection(users).findById(mine.recordedById);
      const change = taxPeriodChange(mine.own, r.own, filed.flatMap((x) => x.corrections.filter((c) => c.periodEnd === mine.periodEnd)));
      submitted = { boxes: mine.boxes, corrections: mine.corrections, submittedOn: mine.submittedOn, reference: mine.reference, recordedBy: by?.name ?? 'Former member', recordedAt: mine.recordedAt.toISOString(), changedSince: change.changed ? { output: change.output, input: change.input, net: change.net } : null };
    }
    const issues = [...r.issues];
    if (!mine && p.end >= today) issues.push(`The period ends on ${p.end}; record the return once it has ended`);
    return {
      period: { start: p.start, end: p.end, due },
      vrn: s.vrn,
      status: mine ? 'SUBMITTED' : p.end >= today ? 'OPEN' : due < today ? 'OVERDUE' : 'DUE',
      jurisdiction: this.describe(j),
      boxes: (mine ? mine.boxes : r.boxes) as Record<string, string>,
      prepared: r.boxes,
      labels: j.boxLabels,
      net: ((mine ? mine.boxes : r.boxes) as Record<string, string>)[j.netBox] ?? '0.00',
      direction: mine ? direction(mine.boxes[j.outputBox], mine.boxes[j.inputBox]) : r.direction,
      own: r.own,
      breakdown: r.breakdown,
      corrections: { pending, included: !mine && included.length > 0, allowance },
      unclassified: r.unclassified,
      issues,
      warnings: [...r.warnings, ...(pending.length && !allowance.allowed ? [j.correctionRule ? `The changes to earlier returns cannot go on this return (${j.correctionRule}): ${j.overLimit}` : `The corrections of earlier returns come to ${j.currency} ${allowance.net}, over the ${j.currency} ${allowance.limit} that may go on this return: ${j.overLimit}`] : [])],
      otherVatEntries: other,
      entries: entries.map((e) => ({ ...e, treatment: treatmentOf(e) })),
      submitted,
    };
  }

  async exportCsv(org: OrgContext, user: AuthUser, periodEnd: string) {
    const v = await this.vatReturn(org, periodEnd);
    const csv = vatReturnCsv(v.period, v.boxes, v.entries, { title: v.jurisdiction.returnName, labels: v.labels, taxName: v.jurisdiction.taxName });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'vat_return.exported', entityType: 'vat_return', entityId: `vat:${v.period.end}`, data: { periodStart: v.period.start, periodEnd: v.period.end, net: v.net } }));
    return { fileName: `${v.jurisdiction.taxName.toLowerCase().replace(/[^a-z]+/g, '-')}-return-${v.period.start}-to-${v.period.end}.csv`, csv };
  }

  /** Records that the business submitted the period's return to the tax authority: the boxes as prepared now are kept and never change. */
  async record(org: OrgContext, user: AuthUser, body: { periodEnd: string; submittedOn: string; reference?: string | null; net?: string }, today = todayIso()) {
    const v = await this.vatReturn(org, body.periodEnd, today);
    if (v.submitted) throw new DomainError('ALREADY_RECORDED', `The return for the period ending ${v.period.end} is already recorded as submitted`, HttpStatus.CONFLICT);
    if (v.issues.length) throw new DomainError('RETURN_NOT_READY', v.issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: v.issues });
    if (body.submittedOn <= v.period.end || body.submittedOn > today) throw new DomainError('VALIDATION_FAILED', 'The submission date falls after the period ends and no later than today', HttpStatus.UNPROCESSABLE_ENTITY);
    // The figures must still be the ones the person looked at.
    if (body.net !== undefined && !new D(body.net).eq(v.net)) throw new DomainError('FIGURES_CHANGED', `The return has changed since it was opened: the net ${v.jurisdiction.taxName} is now ${v.jurisdiction.currency} ${v.net}. Check it again`, HttpStatus.CONFLICT);
    const corrections = v.corrections.included ? v.corrections.pending.map((c) => ({ periodEnd: c.periodEnd, output: c.output, input: c.input })) : [];
    const doc = await this.store.collection(vatReturns).insertOne({
      periodStart: v.period.start,
      periodEnd: v.period.end,
      vrn: v.vrn,
      boxes: v.boxes,
      own: v.own,
      corrections,
      submittedOn: body.submittedOn,
      reference: body.reference?.trim() || null,
      recordedById: user.id,
      recordedAt: new Date(),
    });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'vat_return.recorded', entityType: 'vat_return', entityId: doc.id, data: { periodStart: v.period.start, periodEnd: v.period.end, submittedOn: body.submittedOn, reference: doc.reference, boxes: v.boxes, corrections } }),
    );
    return this.vatReturn(org, body.periodEnd, today);
  }
}
