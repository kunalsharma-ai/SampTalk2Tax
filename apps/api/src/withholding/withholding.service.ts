import { ChartService } from '../accounts/chart.service';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, dec, minorUnits } from '@talk2tax/accounting-engine';
import { Contact, Prisma, ThresholdBasis, ThresholdWindow, WithholdingKind, WithholdingSection, WithholdingSettings } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { checkPan, computeWithholding, depositDueDate, TDS_TEMPLATES, tanIssue, thresholdWindow, WithholdingResult, WithholdingRule } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { nextCounter } from '../db/counters';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';

export interface WithholdingOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

export interface SectionInput {
  kind: WithholdingKind;
  code: string;
  name: string;
  rate: string;
  rateIndividualHuf?: string | null;
  rateNoPan: string;
  singleThreshold?: string | null;
  aggregateThreshold?: string | null;
  thresholdWindow: ThresholdWindow;
  thresholdBasis: ThresholdBasis;
  validFrom: string;
  source?: string | null;
}

export interface DepositInput {
  kind: WithholdingKind;
  depositDate: string;
  bankAccountId: string;
  challanReference: string;
  documentIds: string[];
  interestAmount?: string;
  interestAccountId?: string | null;
  memo?: string | null;
}

/** Facts a document stores about the tax withheld on it. */
export interface WithholdingFacts {
  section: WithholdingSection;
  kind: WithholdingKind;
  accountId: string;
  pan: string | null;
  result: WithholdingResult;
}

const DEFAULT_ACCOUNTS = {
  tdsPayableAccountId: { code: '2320', name: 'TDS payable', subtype: 'TAX_PAYABLE' },
  tcsPayableAccountId: { code: '2321', name: 'TCS payable', subtype: 'TAX_PAYABLE' },
} as const;

/**
 * India income-tax withholding (Directive Part 8): TDS on bills, TCS on invoices,
 * deposits of the tax to the government, and the register behind the quarterly
 * statements. The calculation is packages/tax-engine computeWithholding; this
 * service supplies each counterparty's history from posted documents.
 */
@Injectable()
export class WithholdingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly chart: ChartService,
    private readonly store: DocumentStoreService,
  ) {}

  // ------------------------------------------------------------------ settings

  settings(db: Tx | PrismaService, orgId: string) {
    return db.withholdingSettings.findUnique({ where: { orgId } });
  }

  async getSettings(orgId: string) {
    const s = await this.settings(this.prisma, orgId);
    if (!s) return { configured: false as const };
    return { configured: true as const, ...(await this.serializeSettings(this.prisma, s)) };
  }

  async saveSettings(orgId: string, actor: { id: string }, input: { tan: string; accounts?: { tdsPayableAccountId: string; tcsPayableAccountId: string } }) {
    const tan = input.tan.trim().toUpperCase();
    const issue = tanIssue(tan);
    if (issue) throw new DomainError('INVALID_TAN', issue);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE`;
      const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId } });
      if (org.countryCode !== 'IN' || org.functionalCurrency !== 'INR') throw new DomainError('NOT_INDIA', 'TDS and TCS are available to organisations in India that keep their books in INR');
      const before = await tx.withholdingSettings.findUnique({ where: { orgId } });
      const accounts = input.accounts ?? (before ? { tdsPayableAccountId: before.tdsPayableAccountId, tcsPayableAccountId: before.tcsPayableAccountId } : await this.defaultAccounts(tx, orgId, actor));
      await this.checkAccounts(tx, orgId, accounts);
      if (before && (before.tdsPayableAccountId !== accounts.tdsPayableAccountId || before.tcsPayableAccountId !== accounts.tcsPayableAccountId)) {
        const used = await tx.document.count({ where: { orgId, withholdingAmount: { gt: 0 } } });
        if (used > 0) throw new DomainError('WITHHOLDING_IN_USE', 'Tax has already been withheld to these accounts, so they cannot change', HttpStatus.CONFLICT);
      }
      const data = { tan, ...accounts };
      const s = before ? await tx.withholdingSettings.update({ where: { orgId }, data }) : await tx.withholdingSettings.create({ data: { orgId, ...data } });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: before ? 'withholding.settings_updated' : 'withholding.configured', entityType: 'withholding_settings', entityId: orgId, data });
      return { configured: true as const, ...(await this.serializeSettings(tx, s)) };
    });
  }

  // ------------------------------------------------------------------ sections

  templates() {
    return TDS_TEMPLATES;
  }

  async listSections(orgId: string, includeInactive: boolean) {
    const rows = await this.prisma.withholdingSection.findMany({ where: { orgId, ...(includeInactive ? {} : { isActive: true }) }, orderBy: [{ kind: 'asc' }, { code: 'asc' }] });
    return rows.map(serializeSection);
  }

  async createSection(orgId: string, actor: { id: string }, input: SectionInput | { template: string }) {
    const spec: SectionInput = 'template' in input ? fromTemplate(input.template) : input;
    const issues = sectionIssues(spec);
    if (issues.length) throw new DomainError('INVALID_SECTION', 'The section is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.settings(tx, orgId))) throw new DomainError('WITHHOLDING_NOT_CONFIGURED', 'Set up TDS and TCS first (Settings → TDS and TCS)', HttpStatus.CONFLICT);
      const dup = await tx.withholdingSection.findUnique({ where: { orgId_kind_code: { orgId, kind: spec.kind, code: spec.code } } });
      if (dup) throw new DomainError('SECTION_EXISTS', `${spec.kind} section ${spec.code} already exists`, HttpStatus.CONFLICT);
      const s = await tx.withholdingSection.create({
        data: {
          orgId,
          kind: spec.kind,
          code: spec.code,
          name: spec.name,
          rate: dec(spec.rate).toFixed(),
          rateIndividualHuf: spec.rateIndividualHuf ? dec(spec.rateIndividualHuf).toFixed() : null,
          rateNoPan: dec(spec.rateNoPan).toFixed(),
          singleThreshold: spec.singleThreshold ? dec(spec.singleThreshold).toFixed() : null,
          aggregateThreshold: spec.aggregateThreshold ? dec(spec.aggregateThreshold).toFixed() : null,
          thresholdWindow: spec.thresholdWindow,
          thresholdBasis: spec.thresholdBasis,
          validFrom: toDbDate(spec.validFrom),
          source: spec.source ?? null,
        },
      });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'withholding.section_created', entityType: 'withholding_section', entityId: s.id, data: { ...spec } });
      return serializeSection(s);
    });
  }

  async updateSection(orgId: string, actor: { id: string }, id: string, input: { name?: string; isActive?: boolean }) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.withholdingSection.findFirst({ where: { id, orgId } });
      if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Section not found' });
      const s = await tx.withholdingSection.update({ where: { id }, data: input });
      await this.audit.append(tx, { orgId, actorId: actor.id, action: 'withholding.section_updated', entityType: 'withholding_section', entityId: id, data: input });
      return serializeSection(s);
    });
  }

  // ------------------------------------------------------------------ calculation

  /**
   * The tax to withhold on a document. `amount` is what the section is measured
   * on: the taxable value for TDS (GST shown separately is left out) and the
   * invoice value including GST for TCS. Earlier posted documents of the same
   * contact, section and threshold window supply the history; drafts do not count.
   */
  async compute(
    db: Tx | PrismaService,
    orgId: string,
    input: { documentKind: string; contact: Contact; sectionId: string; issueDate: string; amount: string; excludeDocumentId?: string },
  ): Promise<WithholdingFacts> {
    const settings = await this.settings(db, orgId);
    if (!settings) throw new DomainError('WITHHOLDING_NOT_CONFIGURED', 'Set up TDS and TCS first (Settings → TDS and TCS)', HttpStatus.CONFLICT);
    const section = await db.withholdingSection.findFirst({ where: { id: input.sectionId, orgId } });
    if (!section) throw new DomainError('SECTION_NOT_FOUND', 'TDS/TCS section not found');
    const kind: WithholdingKind | null = input.documentKind === 'BILL' ? 'TDS' : input.documentKind === 'INVOICE' ? 'TCS' : null;
    if (!kind) throw new DomainError('DOCUMENT_INVALID', 'Only bills carry TDS and only invoices carry TCS');
    if (section.kind !== kind) throw new DomainError('DOCUMENT_INVALID', `${section.code} is a ${section.kind} section; ${input.documentKind === 'BILL' ? 'bills take TDS' : 'invoices take TCS'}`);
    if (!section.isActive) throw new DomainError('DOCUMENT_INVALID', `${section.kind} section ${section.code} is inactive`);
    if (input.issueDate < fromDbDate(section.validFrom)) throw new DomainError('DOCUMENT_INVALID', `${section.kind} section ${section.code} applies from ${fromDbDate(section.validFrom)}`);
    const w = thresholdWindow(section.thresholdWindow, input.issueDate);
    const exclude = input.excludeDocumentId ?? '00000000-0000-0000-0000-000000000000';
    const { _sum: sum } = await db.document.aggregate({
      where: { orgId, contactId: input.contact.id, withholdingSectionId: section.id, status: 'POSTED', issueDate: { gte: toDbDate(w.from), lte: toDbDate(w.to) }, id: { not: exclude } },
      _sum: { withholdingSubject: true, withholdingBase: true },
    });
    const h = { subject: sum.withholdingSubject, base: sum.withholdingBase };
    const pan = input.contact.pan;
    const result = computeWithholding(ruleOf(section), input.amount, { aggregateBefore: h?.subject?.toFixed() ?? '0', taxedBefore: h?.base?.toFixed() ?? '0' }, pan, 'INR');
    return { section, kind, accountId: kind === 'TDS' ? settings.tdsPayableAccountId : settings.tcsPayableAccountId, pan, result };
  }

  /** Serialise posting for one contact so two documents cannot both miss a threshold crossing. */
  async lockContact(tx: Tx, orgId: string, contactId: string) {
    await tx.$queryRaw`SELECT id FROM contacts WHERE id = ${contactId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
  }

  async preview(orgId: string, input: { documentKind: 'BILL' | 'INVOICE'; contactId: string; sectionId: string; issueDate: string; amount: string; documentId?: string }) {
    const contact = await this.prisma.contact.findFirst({ where: { id: input.contactId, orgId } });
    if (!contact) throw new DomainError('CONTACT_NOT_FOUND', 'Contact not found');
    const f = await this.compute(this.prisma, orgId, { documentKind: input.documentKind, contact, sectionId: input.sectionId, issueDate: input.issueDate, amount: input.amount, excludeDocumentId: input.documentId });
    return { kind: f.kind, section: { id: f.section.id, code: f.section.code, name: f.section.name }, pan: f.pan, ...f.result };
  }

  // ------------------------------------------------------------------ register

  /** Every document with a section in the period: what was withheld, and whether it has been deposited. */
  async register(org: WithholdingOrg, kind: WithholdingKind, from: string, to: string) {
    const settings = await this.requireSettings(org.id);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, withholdingKind: kind, status: { in: ['POSTED', 'VOID'] }, issueDate: { gte: toDbDate(from), lte: toDbDate(to) } },
      include: {
        contact: { select: { id: true, name: true } },
        withholdingSection: { select: { id: true, code: true, name: true } },
        depositItems: { where: { active: true }, include: { deposit: { select: { id: true, number: true, depositDate: true, challanReference: true } } } },
      },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
    });
    const today = todayIso();
    const scale = minorUnits(org.functionalCurrency);
    const rows = docs.map((d) => {
      const dep = d.depositItems[0]?.deposit;
      const amount = new D(d.withholdingAmount.toFixed());
      const due = depositDueDate(fromDbDate(d.issueDate));
      return {
        documentId: d.id,
        kind: d.kind,
        number: d.number,
        status: d.status,
        date: fromDbDate(d.issueDate),
        contact: d.contact,
        pan: d.counterpartyPan,
        section: d.withholdingSection!,
        subject: d.withholdingSubject.toFixed(scale),
        base: d.withholdingBase.toFixed(scale),
        rate: d.withholdingRate.toFixed(),
        amount: amount.toFixed(scale),
        dueDate: due,
        deposit: dep ? { id: dep.id, number: dep.number, date: fromDbDate(dep.depositDate), challanReference: dep.challanReference } : null,
        overdue: d.status === 'POSTED' && amount.gt(0) && !dep && due < today,
      };
    });
    const live = rows.filter((r) => r.status === 'POSTED');
    const bySection = new Map<string, { section: (typeof rows)[number]['section']; count: number; base: InstanceType<typeof D>; amount: InstanceType<typeof D>; deposited: InstanceType<typeof D> }>();
    for (const r of live) {
      const e = bySection.get(r.section.id) ?? { section: r.section, count: 0, base: new D(0), amount: new D(0), deposited: new D(0) };
      e.count += 1;
      e.base = e.base.plus(r.base);
      e.amount = e.amount.plus(r.amount);
      if (r.deposit) e.deposited = e.deposited.plus(r.amount);
      bySection.set(r.section.id, e);
    }
    const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new D(0));
    const withheld = sum(live.map((r) => r.amount));
    const deposited = sum(live.filter((r) => r.deposit).map((r) => r.amount));
    return {
      kind,
      tan: settings.tan,
      from,
      to,
      rows,
      sections: [...bySection.values()]
        .sort((a, b) => a.section.code.localeCompare(b.section.code))
        .map((e) => ({ section: e.section, count: e.count, base: e.base.toFixed(scale), amount: e.amount.toFixed(scale), deposited: e.deposited.toFixed(scale), pending: e.amount.minus(e.deposited).toFixed(scale) })),
      totals: { withheld: withheld.toFixed(scale), deposited: deposited.toFixed(scale), pending: withheld.minus(deposited).toFixed(scale), overdue: sum(live.filter((r) => r.overdue).map((r) => r.amount)).toFixed(scale) },
      ledger: await this.ledgerCheck(org, kind, settings, to < today ? to : today),
    };
  }

  /**
   * The payable account's balance at `to` against the documents: tax withheld on
   * documents posted by then (and not voided by then) less tax deposited by then
   * (on deposits not voided by then). A difference means something else posted
   * to the account, such as a manual journal.
   */
  private async ledgerCheck(org: WithholdingOrg, kind: WithholdingKind, settings: WithholdingSettings, to: string) {
    const accountId = kind === 'TDS' ? settings.tdsPayableAccountId : settings.tcsPayableAccountId;
    const t = toDbDate(to);
    const [bal] = await lineSums(this.store, org.id, { entry: postedBetween(null, t), line: { accountId }, by: {} });
    const live = { OR: [{ status: 'POSTED' as const }, { status: 'VOID' as const, voidDate: { gt: t } }] };
    const w = await this.prisma.document.aggregate({ where: { orgId: org.id, withholdingKind: kind, issueDate: { lte: t }, ...live }, _sum: { withholdingAmount: true } });
    const d = await this.prisma.withholdingDeposit.aggregate({ where: { orgId: org.id, kind, depositDate: { lte: t }, ...live }, _sum: { taxAmount: true } });
    const scale = minorUnits(org.functionalCurrency);
    const ledger = bal ? bal.credit.minus(bal.debit) : new D(0);
    const expected = new D(w._sum.withholdingAmount?.toFixed() ?? '0').minus(d._sum.taxAmount?.toFixed() ?? '0');
    const account = await this.prisma.account.findUniqueOrThrow({ where: { id: accountId }, select: { id: true, code: true, name: true } });
    return { asOf: to, account, balance: ledger.toFixed(scale), expected: expected.toFixed(scale), agrees: ledger.eq(expected) };
  }

  // ------------------------------------------------------------------ deposits

  async listDeposits(org: WithholdingOrg, kind: WithholdingKind) {
    const rows = await this.prisma.withholdingDeposit.findMany({
      where: { orgId: org.id, kind },
      include: { items: { include: { document: { select: { id: true, number: true, issueDate: true, contact: { select: { name: true } } } } } } },
      orderBy: [{ depositDate: 'desc' }, { number: 'desc' }],
      take: 200,
    });
    const banks = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.bankAccountId))] } }, select: { id: true, code: true, name: true } });
    return rows.map((r) => this.serializeDeposit(org, r, banks));
  }

  async createDeposit(org: WithholdingOrg, actor: { id: string }, input: DepositInput) {
    if (!hasPermission(org.role, 'journals.post')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot record deposits; it needs journals.post`, HttpStatus.FORBIDDEN);
    const ids = [...new Set(input.documentIds)];
    if (ids.length !== input.documentIds.length) throw new DomainError('INVALID_DEPOSIT', 'Each document can appear only once');
    if (!ids.length) throw new DomainError('INVALID_DEPOSIT', 'Choose the documents whose tax this deposit pays');
    const interest = dec(input.interestAmount ?? '0');
    if (interest.decimalPlaces() > 2) throw new DomainError('INVALID_AMOUNT', 'Interest has too many decimal places');
    const challan = input.challanReference.trim();
    if (!challan) throw new DomainError('INVALID_DEPOSIT', 'Enter the challan reference');
    return this.prisma.$transaction(async (tx) => {
      const settings = await this.settings(tx, org.id);
      if (!settings) throw new DomainError('WITHHOLDING_NOT_CONFIGURED', 'Set up TDS and TCS first (Settings → TDS and TCS)', HttpStatus.CONFLICT);
      for (const id of [...ids].sort()) await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      const docs = await tx.document.findMany({ where: { orgId: org.id, id: { in: ids } }, include: { depositItems: { where: { active: true } } } });
      const issues: string[] = [];
      for (const id of ids) {
        const d = docs.find((x) => x.id === id);
        if (!d) issues.push(`Document ${id} not found`);
        else if (d.withholdingKind !== input.kind) issues.push(`${d.number ?? 'A draft'} has no ${input.kind}`);
        else if (d.status !== 'POSTED') issues.push(`${d.number ?? 'A draft'} is not posted`);
        else if (d.withholdingAmount.isZero()) issues.push(`${d.number}: no ${input.kind} was withheld (below the threshold)`);
        else if (d.depositItems.length) issues.push(`${d.number}: its ${input.kind} is already in a deposit`);
        else if (fromDbDate(d.issueDate) > input.depositDate) issues.push(`${d.number} is dated after the deposit`);
      }
      if (issues.length) throw new DomainError('INVALID_DEPOSIT', 'The deposit is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
      const bank = await tx.account.findFirst({ where: { id: input.bankAccountId, orgId: org.id } });
      if (!bank || !bank.isPostable || !bank.isActive || !['BANK', 'CASH'].includes(bank.subtype ?? '')) throw new DomainError('INVALID_BANK_ACCOUNT', 'Choose an active bank or cash account');
      if (interest.gt(0)) {
        const a = input.interestAccountId ? await tx.account.findFirst({ where: { id: input.interestAccountId, orgId: org.id } }) : null;
        if (!a || !a.isPostable || !a.isActive || a.type !== 'EXPENSE') throw new DomainError('INVALID_ACCOUNT', 'Choose an active expense account for the interest');
      }
      const tax = docs.reduce((s, d) => s.plus(d.withholdingAmount.toFixed()), new D(0));
      const payable = input.kind === 'TDS' ? settings.tdsPayableAccountId : settings.tcsPayableAccountId;
      const value = await nextCounter(tx, org.id, `doc:${input.kind}_DEPOSIT`);
      const number = `${input.kind}D-${String(value).padStart(6, '0')}`;
      const c = org.functionalCurrency;
      const lines = [
        { accountId: payable, currency: c, debit: tax.toFixed(), description: `${input.kind} deposited` },
        ...(interest.gt(0) ? [{ accountId: input.interestAccountId!, currency: c, debit: interest.toFixed(), description: `Interest on late ${input.kind}` }] : []),
        { accountId: bank.id, currency: c, credit: tax.plus(interest).toFixed(), description: `Challan ${challan}` },
      ];
      const je = await this.journals.postSystemEntry(tx, org, actor, { date: input.depositDate, source: 'TAX', memo: `${number} · ${input.kind} challan ${challan}${input.memo ? ` · ${input.memo}` : ''}`, reference: number, lines });
      const dep = await tx.withholdingDeposit.create({
        data: {
          orgId: org.id,
          kind: input.kind,
          number,
          depositDate: toDbDate(input.depositDate),
          bankAccountId: bank.id,
          challanReference: challan,
          taxAmount: tax.toFixed(),
          interestAmount: interest.toFixed(),
          interestAccountId: interest.gt(0) ? input.interestAccountId! : null,
          memo: input.memo || null,
          journalEntryId: je.id,
          createdById: actor.id,
        },
      });
      await tx.withholdingDepositItem.createMany({ data: docs.map((d) => ({ orgId: org.id, depositId: dep.id, documentId: d.id, amount: d.withholdingAmount.toFixed() })) });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'withholding.deposited', entityType: 'withholding_deposit', entityId: dep.id, data: { kind: input.kind, number, tax: tax.toFixed(), interest: interest.toFixed(), challanReference: challan, documentIds: ids, journalEntryId: je.id } });
      return this.depositById(tx, org, dep.id);
    });
  }

  async voidDeposit(org: WithholdingOrg, actor: { id: string }, id: string, input: { date: string; reason: string }) {
    if (!hasPermission(org.role, 'journals.reverse')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot void deposits; it needs journals.reverse`, HttpStatus.FORBIDDEN);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM withholding_deposits WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Deposit not found' });
      const dep = await tx.withholdingDeposit.findUniqueOrThrow({ where: { id } });
      if (dep.status !== 'POSTED') throw new DomainError('ALREADY_VOID', 'Deposit is already void', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(dep.depositDate)) throw new DomainError('INVALID_DATE', 'The void date cannot be before the deposit date');
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, dep.journalEntryId, { date: input.date, memo: `Void ${dep.number}: ${input.reason}` });
      await tx.withholdingDeposit.update({ where: { id }, data: { status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date), voidReason: input.reason } });
      await tx.withholdingDepositItem.updateMany({ where: { depositId: id, active: true }, data: { active: false } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'withholding.deposit_voided', entityType: 'withholding_deposit', entityId: id, data: { number: dep.number, date: input.date, reason: input.reason, reversalEntryId: rev.id } });
      return this.depositById(tx, org, id);
    });
  }

  // ------------------------------------------------------------------ helpers

  private async depositById(tx: Tx, org: WithholdingOrg, id: string) {
    const r = await tx.withholdingDeposit.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { document: { select: { id: true, number: true, issueDate: true, contact: { select: { name: true } } } } } } },
    });
    const banks = await tx.account.findMany({ where: { orgId: org.id, id: r.bankAccountId }, select: { id: true, code: true, name: true } });
    return this.serializeDeposit(org, r, banks);
  }

  private serializeDeposit(
    org: WithholdingOrg,
    r: Prisma.WithholdingDepositGetPayload<{ include: { items: { include: { document: { select: { id: true; number: true; issueDate: true; contact: { select: { name: true } } } } } } } }>,
    banks: { id: string; code: string; name: string }[],
  ) {
    const scale = minorUnits(org.functionalCurrency);
    return {
      id: r.id,
      kind: r.kind,
      number: r.number,
      status: r.status,
      depositDate: fromDbDate(r.depositDate),
      challanReference: r.challanReference,
      bankAccount: banks.find((b) => b.id === r.bankAccountId) ?? { id: r.bankAccountId, code: '', name: '' },
      taxAmount: r.taxAmount.toFixed(scale),
      interestAmount: r.interestAmount.toFixed(scale),
      memo: r.memo,
      journalEntryId: r.journalEntryId,
      voidJournalEntryId: r.voidJournalEntryId,
      voidDate: r.voidDate ? fromDbDate(r.voidDate) : null,
      voidReason: r.voidReason,
      items: r.items.map((i) => ({ documentId: i.document.id, number: i.document.number, date: fromDbDate(i.document.issueDate), contactName: i.document.contact.name, amount: i.amount.toFixed(scale) })),
    };
  }

  private async requireSettings(orgId: string) {
    const s = await this.settings(this.prisma, orgId);
    if (!s) throw new DomainError('WITHHOLDING_NOT_CONFIGURED', 'Set up TDS and TCS first (Settings → TDS and TCS)', HttpStatus.CONFLICT);
    return s;
  }

  private async serializeSettings(db: Tx | PrismaService, s: WithholdingSettings) {
    const accs = await db.account.findMany({ where: { orgId: s.orgId, id: { in: [s.tdsPayableAccountId, s.tcsPayableAccountId] } }, select: { id: true, code: true, name: true } });
    const acc = (id: string) => accs.find((a) => a.id === id) ?? { id, code: '', name: '' };
    return { tan: s.tan, accounts: { tdsPayable: acc(s.tdsPayableAccountId), tcsPayable: acc(s.tcsPayableAccountId) } };
  }

  private async defaultAccounts(tx: Tx, orgId: string, actor: { id: string }) {
    const spec = (k: keyof typeof DEFAULT_ACCOUNTS) => ({ ...DEFAULT_ACCOUNTS[k], type: 'LIABILITY' as const, parentCode: '2000' });
    return this.chart.ensure(tx, orgId, actor.id, { tdsPayableAccountId: spec('tdsPayableAccountId'), tcsPayableAccountId: spec('tcsPayableAccountId') }, 'TDS and TCS setup');
  }

  private async checkAccounts(tx: Tx, orgId: string, accounts: { tdsPayableAccountId: string; tcsPayableAccountId: string }) {
    if (accounts.tdsPayableAccountId === accounts.tcsPayableAccountId) throw new DomainError('INVALID_ACCOUNT', 'TDS and TCS each need their own account');
    const found = await tx.account.findMany({ where: { orgId, id: { in: [accounts.tdsPayableAccountId, accounts.tcsPayableAccountId] } } });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    const issues: string[] = [];
    for (const [key, label] of [['tdsPayableAccountId', 'TDS payable'], ['tcsPayableAccountId', 'TCS payable']] as const) {
      const a = found.find((x) => x.id === accounts[key]);
      if (!a) issues.push(`${label}: account not found`);
      else if (!a.isPostable || !a.isActive) issues.push(`${label}: ${a.code} is a header or inactive account`);
      else if ([org.arAccountId, org.apAccountId, org.claimsAccountId].includes(a.id)) issues.push(`${label}: ${a.code} is a control account`);
      else if (a.type !== 'LIABILITY') issues.push(`${label}: must be a liability account`);
    }
    if (issues.length) throw new DomainError('INVALID_ACCOUNT', 'TDS/TCS accounts are invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }
}

export function ruleOf(s: WithholdingSection): WithholdingRule {
  return {
    kind: s.kind,
    code: s.code,
    name: s.name,
    rate: s.rate.toFixed(),
    rateIndividualHuf: s.rateIndividualHuf?.toFixed() ?? null,
    rateNoPan: s.rateNoPan.toFixed(),
    singleThreshold: s.singleThreshold?.toFixed() ?? null,
    aggregateThreshold: s.aggregateThreshold?.toFixed() ?? null,
    window: s.thresholdWindow,
    basis: s.thresholdBasis,
  };
}

function fromTemplate(code: string): SectionInput {
  const t = TDS_TEMPLATES.find((x) => x.code === code);
  if (!t) throw new DomainError('TEMPLATE_NOT_FOUND', `No template ${code}`);
  return { kind: t.kind, code: t.code, name: t.name, rate: t.rate, rateIndividualHuf: t.rateIndividualHuf ?? null, rateNoPan: t.rateNoPan, singleThreshold: t.singleThreshold ?? null, aggregateThreshold: t.aggregateThreshold ?? null, thresholdWindow: t.window, thresholdBasis: t.basis, validFrom: t.validFrom, source: t.source };
}

function sectionIssues(s: SectionInput): string[] {
  const issues: string[] = [];
  const pct = (v: string | null | undefined, label: string, allowZero = false) => {
    if (v === null || v === undefined || v === '') return;
    const d = dec(v);
    if ((allowZero ? d.lt(0) : d.lte(0)) || d.gt(100)) issues.push(`${label} must be ${allowZero ? '0' : 'above 0'} to 100%`);
  };
  pct(s.rate, 'Rate');
  pct(s.rateIndividualHuf, 'Individual/HUF rate');
  pct(s.rateNoPan, 'No-PAN rate', true);
  for (const [v, label] of [[s.singleThreshold, 'Single-document threshold'], [s.aggregateThreshold, 'Aggregate threshold']] as const) {
    if (v && !dec(v).gt(0)) issues.push(`${label} must be above zero`);
    if (v && dec(v).decimalPlaces() > 2) issues.push(`${label} has too many decimal places`);
  }
  if (s.thresholdBasis === 'EXCESS' && (!s.aggregateThreshold || s.singleThreshold)) issues.push('Tax on the excess needs an aggregate threshold and no single-document threshold');
  if (!s.code.trim()) issues.push('Enter the section code');
  return issues;
}

export function serializeSection(s: WithholdingSection) {
  return {
    id: s.id,
    kind: s.kind,
    code: s.code,
    name: s.name,
    rate: s.rate.toFixed(),
    rateIndividualHuf: s.rateIndividualHuf?.toFixed() ?? null,
    rateNoPan: s.rateNoPan.toFixed(),
    singleThreshold: s.singleThreshold?.toFixed(2) ?? null,
    aggregateThreshold: s.aggregateThreshold?.toFixed(2) ?? null,
    thresholdWindow: s.thresholdWindow,
    thresholdBasis: s.thresholdBasis,
    validFrom: fromDbDate(s.validFrom),
    source: s.source,
    isActive: s.isActive,
  };
}

/** PAN as the contact service stores it: upper case, shape-checked, and the GSTIN's PAN when there is one. */
export function normalizePan(pan: string | null | undefined, gstin: string | null | undefined): string | null | undefined {
  if (pan === undefined && !gstin) return undefined;
  const fromGstin = gstin ? gstin.slice(2, 12) : null;
  if (!pan) return fromGstin;
  const p = checkPan(pan);
  if (!p.valid) throw new DomainError('INVALID_PAN', p.issues.join('; '));
  if (fromGstin && fromGstin !== p.pan) throw new DomainError('INVALID_PAN', `The GSTIN carries PAN ${fromGstin}, not ${p.pan}`);
  return p.pan;
}
