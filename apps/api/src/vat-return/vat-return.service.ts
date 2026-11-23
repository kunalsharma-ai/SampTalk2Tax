import { HttpStatus, Injectable } from '@nestjs/common';
import { D, toFunctional } from '@talk2tax/accounting-engine';
import {
  normaliseVrn,
  recentVatPeriods,
  suggestVatTreatment,
  ukVatReturn,
  VAT_BOX_LABEL,
  VAT_STAGGER_LABEL,
  VAT_STAGGERS,
  VAT_TREATMENT_LABEL,
  VAT_TREATMENTS,
  vatCorrectionAllowance,
  vatDueDate,
  vatPeriodChange,
  vatPeriodFor,
  vatReturnCsv,
  type VatCorrection,
  type VatEntry,
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
import { vatReturns, vatSettings, type VatReturnDoc, type VatSettingsDoc } from '../db/collections/vat-returns';

export interface VatSettingsBody {
  vrn: string;
  registeredFrom: string;
  stagger: VatStagger;
  untaxedTreatment: VatTreatment;
  treatments: { taxRateId: string; treatment: VatTreatment }[];
}

/** HMRC lets an earlier return be corrected for four years. */
const CORRECTION_YEARS = 4;
const PERIODS_SHOWN = 8;

/**
 * UK VAT return (TAX-030): the nine boxes for a VAT period, prepared from posted invoices, credit
 * notes, bills, vendor credits and approved expense claims with ukVatReturn; changes to periods
 * already submitted carried as corrections when within HMRC's limit; entries on the VAT accounts
 * that are not on the return listed for checking; and a record of each return the business
 * submitted to HMRC. GB organisations keeping books in pounds only. reports.read reads;
 * accounts.manage sets the registration up and records submissions. Nothing is sent to HMRC.
 */
@Injectable()
export class VatReturnService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async uk(org: OrgContext) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'GB') throw new DomainError('NOT_UK', 'The VAT return is prepared for organisations in the United Kingdom', HttpStatus.UNPROCESSABLE_ENTITY);
    if (org.functionalCurrency !== 'GBP') throw new DomainError('NOT_GBP', 'The VAT return is prepared from books kept in pounds (GBP)', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async rates(org: OrgContext, s: VatSettingsDoc | null): Promise<(VatRateInfo & { isActive: boolean; suggested: VatTreatment | null; salesAccountId: string | null; purchaseAccountId: string | null })[]> {
    const set = new Map((s?.treatments ?? []).map((t) => [t.taxRateId, t.treatment as VatTreatment]));
    const rows = await this.prisma.taxRate.findMany({ where: { orgId: org.id }, select: { id: true, name: true, rate: true, isActive: true, salesAccountId: true, purchaseAccountId: true }, orderBy: [{ rate: 'desc' }, { name: 'asc' }] });
    return rows.map((r) => ({ id: r.id, name: r.name, rate: r.rate.toFixed(), isActive: r.isActive, treatment: set.get(r.id) ?? null, suggested: suggestVatTreatment(r.rate.toFixed(), r.name), salesAccountId: r.salesAccountId, purchaseAccountId: r.purchaseAccountId }));
  }

  private stored(org: OrgContext) {
    return this.store.collection(vatSettings).findOne({});
  }

  private async required(org: OrgContext) {
    const s = await this.stored(org);
    if (!s) throw new DomainError('VAT_NOT_SET_UP', 'Add your VAT registration number and return periods first', HttpStatus.UNPROCESSABLE_ENTITY);
    return s;
  }

  // ---- settings ----

  async settings(org: OrgContext) {
    await this.uk(org);
    const s = await this.stored(org);
    const rates = await this.rates(org, s);
    const by = s ? await this.store.collection(users).findById(s.updatedById) : null;
    return {
      settings: s ? { vrn: s.vrn, registeredFrom: s.registeredFrom, stagger: s.stagger, untaxedTreatment: s.untaxedTreatment, updatedAt: s.updatedAt.toISOString(), updatedBy: by?.name ?? 'Former member' } : null,
      rates: rates.map(({ salesAccountId: _s, purchaseAccountId: _p, ...r }) => r),
      staggers: VAT_STAGGERS.map((k) => ({ key: k, label: VAT_STAGGER_LABEL[k] })),
      treatments: VAT_TREATMENTS.map((k) => ({ key: k, label: VAT_TREATMENT_LABEL[k] })),
    };
  }

  async saveSettings(org: OrgContext, user: AuthUser, body: VatSettingsBody) {
    await this.uk(org);
    const vrn = normaliseVrn(body.vrn);
    if (!vrn) throw new DomainError('INVALID_VRN', 'That is not a valid UK VAT registration number (9 digits, or 12 for a branch)', HttpStatus.UNPROCESSABLE_ENTITY);
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

  /** Every line on the return for a period, in pounds, with the journal entries they posted. */
  private async entries(org: OrgContext, from: string, to: string) {
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
    const gbp = (v: { toFixed(): string }, rate: string) => toFunctional(new D(v.toFixed()), rate, 'GBP').toFixed(2);
    const fromDoc = (d: (typeof issued)[number], reversal: boolean) => {
      const rate = d.exchangeRate.toFixed();
      const j = reversal ? d.voidJournalEntryId : d.journalEntryId;
      if (j) journals.add(j);
      for (const l of d.lines) out.push({ source: d.kind, id: d.id, number: d.number ?? 'Draft', date: reversal && d.voidDate ? fromDbDate(d.voidDate) : fromDbDate(d.issueDate), ...(reversal ? { reversal: true } : {}), taxRateId: l.taxRateId, rate: l.taxRate.toFixed(), net: gbp(l.netAmount, rate), vat: gbp(l.taxAmount, rate) });
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

  private async figures(org: OrgContext, s: VatSettingsDoc, from: string, to: string, corrections: VatCorrection[] = []) {
    const rates = await this.rates(org, s);
    const { entries, journals } = await this.entries(org, from, to);
    const r = ukVatReturn(entries, rates, { untaxed: s.untaxedTreatment as VatTreatment, corrections });
    return { rates, entries, journals, r };
  }

  // ---- periods and returns ----

  private async recorded() {
    return this.store.collection(vatReturns).find({}, { sort: { periodEnd: 1 } });
  }

  async periods(org: OrgContext, today = todayIso()) {
    await this.uk(org);
    const s = await this.stored(org);
    if (!s) return { setUp: false, periods: [] };
    const filed = new Map((await this.recorded()).map((r) => [r.periodEnd, r]));
    const periods = recentVatPeriods(s.stagger as VatStagger, today, PERIODS_SHOWN).filter((p) => p.end >= s.registeredFrom).map((p) => {
      const f = filed.get(p.end);
      const status = f ? 'SUBMITTED' : p.end >= today ? 'OPEN' : p.due < today ? 'OVERDUE' : 'DUE';
      return { ...p, start: p.start < s.registeredFrom ? s.registeredFrom : p.start, status, submittedOn: f?.submittedOn ?? null, box5: f?.boxes.box5 ?? null, direction: f ? (new D(f.boxes.box3).gt(f.boxes.box4) ? 'PAY' : new D(f.boxes.box3).lt(f.boxes.box4) ? 'RECLAIM' : 'NIL') : null };
    });
    // Returns recorded under an earlier stagger stay listed.
    const shown = new Set(periods.map((p) => p.end));
    const older = [...filed.values()].filter((f) => !shown.has(f.periodEnd) && f.periodEnd < (periods.at(-1)?.start ?? today)).slice(-PERIODS_SHOWN);
    return { setUp: true, stagger: s.stagger, vrn: s.vrn, periods, older: older.reverse().map((f) => ({ start: f.periodStart, end: f.periodEnd, submittedOn: f.submittedOn, box5: f.boxes.box5 })) };
  }

  private period(s: VatSettingsDoc, end: string, filed: VatReturnDoc | undefined) {
    if (filed) return { start: filed.periodStart, end: filed.periodEnd, due: vatDueDate(filed.periodEnd) };
    const p = vatPeriodFor(s.stagger as VatStagger, end);
    if (!p) throw new DomainError('NOT_A_PERIOD', `${end} is not the last day of a VAT period on your stagger`, HttpStatus.UNPROCESSABLE_ENTITY);
    if (end < s.registeredFrom) throw new DomainError('BEFORE_REGISTRATION', `The period ends before your VAT registration took effect on ${s.registeredFrom}`, HttpStatus.UNPROCESSABLE_ENTITY);
    // The first return starts on the registration date.
    return p.start < s.registeredFrom ? { ...p, start: s.registeredFrom } : p;
  }

  /** Changes to submitted periods since they were submitted (within four years of this period), less corrections already made. */
  private async changes(org: OrgContext, s: VatSettingsDoc, start: string, filed: VatReturnDoc[]) {
    const earliest = `${Number(start.slice(0, 4)) - CORRECTION_YEARS}${start.slice(4)}`; // not money
    const out: (VatCorrection & { net: string; periodStart: string })[] = [];
    for (const f of filed.filter((x) => x.periodEnd < start && x.periodEnd >= earliest)) {
      const now = (await this.figures(org, s, f.periodStart, f.periodEnd)).r.own;
      const done = filed.flatMap((x) => x.corrections.filter((c) => c.periodEnd === f.periodEnd));
      const c = vatPeriodChange(f.own, now, done);
      if (c.changed) out.push({ periodStart: f.periodStart, periodEnd: f.periodEnd, box1: c.box1, box4: c.box4, net: c.net });
    }
    return out;
  }

  async vatReturn(org: OrgContext, periodEnd: string, today = todayIso()) {
    await this.uk(org);
    const s = await this.required(org);
    const filed = await this.recorded();
    const mine = filed.find((f) => f.periodEnd === periodEnd);
    const p = this.period(s, periodEnd, mine);
    const due = p.due;

    const pending = mine ? [] : await this.changes(org, s, p.start, filed);
    const first = await this.figures(org, s, p.start, p.end);
    const allowance = vatCorrectionAllowance(pending, first.r.own.box6);
    const included = !mine && pending.length && allowance.allowed ? pending : mine ? mine.corrections : [];
    const { r, entries, journals, rates } = included.length ? await this.figures(org, s, p.start, p.end, included) : first;
    const other = await this.otherVatEntries(org, p.start, p.end, journals, rates);
    const byRate = new Map(rates.map((x) => [x.id, x]));
    const treatmentOf = (e: VatEntry) => (e.taxRateId ? (byRate.get(e.taxRateId)?.treatment ?? byRate.get(e.taxRateId)?.suggested ?? 'UNCLASSIFIED') : s.untaxedTreatment);

    let submitted = null;
    if (mine) {
      const by = await this.store.collection(users).findById(mine.recordedById);
      const change = vatPeriodChange(mine.own, r.own, filed.flatMap((x) => x.corrections.filter((c) => c.periodEnd === mine.periodEnd)));
      submitted = { boxes: mine.boxes, corrections: mine.corrections, submittedOn: mine.submittedOn, reference: mine.reference, recordedBy: by?.name ?? 'Former member', recordedAt: mine.recordedAt.toISOString(), changedSince: change.changed ? { box1: change.box1, box4: change.box4, net: change.net } : null };
    }
    const issues = [...r.issues];
    if (!mine && p.end >= today) issues.push(`The period ends on ${p.end}; record the return once it has ended`);
    return {
      period: { start: p.start, end: p.end, due },
      vrn: s.vrn,
      status: mine ? 'SUBMITTED' : p.end >= today ? 'OPEN' : due < today ? 'OVERDUE' : 'DUE',
      boxes: mine ? mine.boxes : r.boxes,
      prepared: r.boxes,
      labels: VAT_BOX_LABEL,
      direction: r.direction,
      own: r.own,
      breakdown: r.breakdown,
      corrections: { pending, included: !mine && included.length > 0, allowance },
      unclassified: r.unclassified,
      issues,
      warnings: [...r.warnings, ...(pending.length && !allowance.allowed ? [`The corrections of earlier returns come to £${allowance.net}, over the £${allowance.limit} that may go on this return: tell HMRC about them separately (form VAT652)`] : [])],
      otherVatEntries: other,
      entries: entries.map((e) => ({ ...e, treatment: treatmentOf(e) })),
      submitted,
    };
  }

  async exportCsv(org: OrgContext, user: AuthUser, periodEnd: string) {
    const v = await this.vatReturn(org, periodEnd);
    const csv = vatReturnCsv(v.period, v.boxes, v.entries);
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'vat_return.exported', entityType: 'vat_return', entityId: `vat:${v.period.end}`, data: { periodStart: v.period.start, periodEnd: v.period.end, box5: v.boxes.box5 } }));
    return { fileName: `vat-return-${v.period.start}-to-${v.period.end}.csv`, csv };
  }

  /** Records that the business submitted the period's return to HMRC: the boxes as prepared now are kept and never change. */
  async record(org: OrgContext, user: AuthUser, body: { periodEnd: string; submittedOn: string; reference?: string | null; box5?: string }, today = todayIso()) {
    const v = await this.vatReturn(org, body.periodEnd, today);
    if (v.submitted) throw new DomainError('ALREADY_RECORDED', `The return for the period ending ${v.period.end} is already recorded as submitted`, HttpStatus.CONFLICT);
    if (v.issues.length) throw new DomainError('RETURN_NOT_READY', v.issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues: v.issues });
    if (body.submittedOn <= v.period.end || body.submittedOn > today) throw new DomainError('VALIDATION_FAILED', 'The submission date falls after the period ends and no later than today', HttpStatus.UNPROCESSABLE_ENTITY);
    // The figures must still be the ones the person looked at.
    if (body.box5 !== undefined && !new D(body.box5).eq(v.boxes.box5)) throw new DomainError('FIGURES_CHANGED', `The return has changed since it was opened: box 5 is now £${v.boxes.box5}. Check it again`, HttpStatus.CONFLICT);
    const corrections = v.corrections.included ? v.corrections.pending.map((c) => ({ periodEnd: c.periodEnd, box1: c.box1, box4: c.box4 })) : [];
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
