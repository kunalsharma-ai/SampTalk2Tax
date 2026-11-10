import { ChartService } from '../accounts/chart.service';
import { DocumentStoreService } from '../common/document-store.service';
import { organizations } from '../db/collections/tenancy';
import { PostgresMirrorService } from '../db/postgres-mirror.service';
import { EXPENSE_CLAIMS } from '../db/collections/expenses';
import { MovedTables } from '../db/moved-table';
import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  ExpenseLineInput,
  TaxRateInfo,
  buildExpenseClaimJournal,
  buildReimbursementJournal,
  computeExpenseClaim,
  minorUnits,
  possibleDuplicateLines,
} from '@talk2tax/accounting-engine';
import { ExpenseClaimStatus, Prisma } from '@talk2tax/database';
import { hasPermission, Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { nextCounter } from '../db/counters';
import { lockRow } from '../db/locks';

interface Actor {
  id: string;
}

export interface ClaimInput {
  title: string;
  lines: ExpenseLineInput[];
}

const CLAIM_INCLUDE = {
  lines: { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } }, tax: { select: { name: true } } } },
} as const;
const CLAIM_DEFAULTS = {
  status: 'DRAFT',
  submittedAt: null,
  decidedById: null,
  decidedAt: null,
  decisionNote: null,
  journalEntryId: null,
  postingDate: null,
  reimbursementJournalEntryId: null,
  reimbursedOn: null,
  reimbursedById: null,
  bankAccountId: null,
  reimbursementReference: null,
  voidJournalEntryId: null,
  voidDate: null,
  voidReason: null,
};
type ClaimRow = Prisma.ExpenseClaimGetPayload<{ include: typeof CLAIM_INCLUDE }>;

const EDITABLE: ExpenseClaimStatus[] = ['DRAFT', 'REJECTED'];
/** How far back to look for the same receipt claimed twice. */
const DUPLICATE_WINDOW = 200;

/**
 * Employee expense claims (Directive Part 13). Anyone with expenses.submit claims their
 * own spending; someone else with approvals.decide approves it, which posts
 * Dr expenses / Cr employee reimbursements payable; someone with expenses.reimburse
 * pays it back from a bank account. The database enforces the lifecycle (see the
 * 20261031200000_expense_claims migration).
 */
@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
    private readonly chart: ChartService,
    private readonly moved: MovedTables,
  ) {}

  /** What a claimant may choose from without reading the whole chart of accounts. */
  async options(org: OrgContext) {
    this.require(org, 'expenses.submit', 'claim expenses');
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    const control = [o.arAccountId, o.apAccountId, o.claimsAccountId].filter((x): x is string => !!x);
    const [accounts, taxRates] = await Promise.all([
      this.prisma.account.findMany({ where: { orgId: org.id, type: 'EXPENSE', isPostable: true, isActive: true, id: { notIn: control } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      this.prisma.taxRate.findMany({ where: { orgId: org.id, isActive: true, kind: 'SIMPLE', purchaseAccountId: { not: null } }, select: { id: true, name: true, rate: true }, orderBy: [{ rate: 'asc' }, { name: 'asc' }] }),
    ]);
    return { currency: org.functionalCurrency, accounts, taxRates: taxRates.map((t) => ({ ...t, rate: t.rate.toFixed() })) };
  }

  async list(org: OrgContext, actor: Actor, q: { status?: ExpenseClaimStatus; mine: boolean; limit: number; offset: number }) {
    const all = hasPermission(org.role, 'expenses.read');
    if (!all && !hasPermission(org.role, 'expenses.submit')) this.require(org, 'expenses.read', 'see expense claims');
    const where: Prisma.ExpenseClaimWhereInput = { orgId: org.id, ...(q.status ? { status: q.status } : {}), ...(!all || q.mine ? { claimantId: actor.id } : {}) };
    const [total, rows, sums] = await Promise.all([
      this.prisma.expenseClaim.count({ where }),
      this.prisma.expenseClaim.findMany({ where, include: { _count: { select: { lines: true } } }, orderBy: [{ createdAt: 'desc' }], take: q.limit, skip: q.offset }),
      this.prisma.expenseClaim.groupBy({ by: ['status'], where: { orgId: org.id, ...(!all || q.mine ? { claimantId: actor.id } : {}) }, _sum: { total: true }, _count: true }),
    ]);
    const names = await this.names(rows.flatMap((r) => [r.claimantId]));
    const scale = minorUnits(org.functionalCurrency);
    return {
      total,
      summary: Object.fromEntries(sums.map((s) => [s.status, { count: s._count, total: (s._sum.total ?? new Prisma.Decimal(0)).toFixed(scale) }])),
      items: rows.map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        status: r.status,
        claimant: names.get(r.claimantId) ?? null,
        claimantId: r.claimantId,
        total: r.total.toFixed(scale),
        lineCount: r._count.lines,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        reimbursedOn: r.reimbursedOn ? fromDbDate(r.reimbursedOn) : null,
        canApprove: r.status === 'SUBMITTED' && r.claimantId !== actor.id && hasPermission(org.role, 'approvals.decide') && hasPermission(org.role, 'journals.post'),
      })),
    };
  }

  async get(org: OrgContext, actor: Actor, id: string) {
    const c = await this.prisma.expenseClaim.findFirst({ where: { id, orgId: org.id }, include: CLAIM_INCLUDE });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
    this.assertCanSee(org, actor, c.claimantId);
    return this.serialize(org, actor, c, this.prisma);
  }

  async create(org: OrgContext, actor: Actor, input: ClaimInput) {
    this.require(org, 'expenses.submit', 'claim expenses');
    return this.prisma.$transaction(async (tx) => {
      const computed = await this.prepare(tx, org, input.lines);
      const n = await this.nextNumber(tx, org.id);
      const now = new Date();
      const created = await this.moved.create<{ id: string }>(tx, EXPENSE_CLAIMS, org.id, {
        ...CLAIM_DEFAULTS,
        number: `EXP-${String(n).padStart(6, '0')}`,
        claimantId: actor.id,
        title: input.title.trim(),
        currency: org.functionalCurrency,
        netTotal: computed.netTotal.toFixed(),
        taxTotal: computed.taxTotal.toFixed(),
        total: computed.total.toFixed(),
        lines: lineRows(computed),
        createdAt: now,
        updatedAt: now,
      });
      const c = await tx.expenseClaim.findUniqueOrThrow({ where: { id: created.id }, include: CLAIM_INCLUDE });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'expense_claim.created', entityType: 'expense_claim', entityId: c.id, data: { number: c.number, total: c.total.toFixed() } });
      return this.serialize(org, actor, c, tx);
    });
  }

  /** The claimant edits a draft or a rejected claim; a rejected claim becomes a draft again. */
  async update(org: OrgContext, actor: Actor, id: string, input: ClaimInput) {
    return this.prisma.$transaction(async (tx) => {
      const c = await this.lockOwn(tx, org, actor, id);
      if (!EDITABLE.includes(c.status)) throw new DomainError('NOT_EDITABLE', `A ${c.status.toLowerCase()} claim cannot be edited${c.status === 'SUBMITTED' ? '; withdraw it first' : ''}`, HttpStatus.CONFLICT);
      const computed = await this.prepare(tx, org, input.lines);
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, {
        title: input.title.trim(),
        status: 'DRAFT',
        netTotal: computed.netTotal.toFixed(),
        taxTotal: computed.taxTotal.toFixed(),
        total: computed.total.toFixed(),
        lines: lineRows(computed),
        updatedAt: new Date(),
      });
      const out = await tx.expenseClaim.findUniqueOrThrow({ where: { id }, include: CLAIM_INCLUDE });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'expense_claim.updated', entityType: 'expense_claim', entityId: id, data: { total: out.total.toFixed() } });
      return this.serialize(org, actor, out, tx);
    });
  }

  async remove(org: OrgContext, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lockOwn(tx, org, actor, id);
      if (c.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', 'Only drafts can be deleted', HttpStatus.CONFLICT);
      await this.moved.remove(tx, EXPENSE_CLAIMS, org.id, id);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'expense_claim.deleted', entityType: 'expense_claim', entityId: id, data: { number: c.number } });
    });
  }

  async submit(org: OrgContext, actor: Actor, id: string) {
    return this.transition(org, actor, id, 'own', async (tx, c) => {
      if (!EDITABLE.includes(c.status)) throw new DomainError('NOT_EDITABLE', `This claim is already ${c.status.toLowerCase()}`, HttpStatus.CONFLICT);
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { ...{ status: 'SUBMITTED', submittedAt: new Date(), decidedById: null, decidedAt: null, decisionNote: null }, updatedAt: new Date() });
      return { action: 'expense_claim.submitted', data: { total: c.total.toFixed() } };
    });
  }

  async withdraw(org: OrgContext, actor: Actor, id: string) {
    return this.transition(org, actor, id, 'own', async (tx, c) => {
      if (c.status !== 'SUBMITTED') throw new DomainError('NOT_SUBMITTED', 'Only a submitted claim can be withdrawn', HttpStatus.CONFLICT);
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { ...{ status: 'DRAFT' }, updatedAt: new Date() });
      return { action: 'expense_claim.withdrawn', data: {} };
    });
  }

  async approve(org: OrgContext, actor: Actor, id: string, input: { note?: string | null; date?: string }) {
    this.require(org, 'approvals.decide', 'approve expense claims');
    this.require(org, 'journals.post', 'post expense claims');
    return this.transition(org, actor, id, 'decide', async (tx, c) => {
      if (c.status !== 'SUBMITTED') throw new DomainError('NOT_SUBMITTED', `This claim is ${c.status.toLowerCase()}, not waiting for approval`, HttpStatus.CONFLICT);
      if (c.claimantId === actor.id) throw new DomainError('SAME_PERSON', 'You cannot approve your own expense claim', HttpStatus.FORBIDDEN);
      const date = input.date ?? todayIso();
      // Recompute with the current tax rates and accounts: what posts is what is valid now.
      const computed = await this.prepare(
        tx,
        org,
        c.lines.map((l) => ({ date: fromDbDate(l.date), accountId: l.accountId, merchant: l.merchant, description: l.description, amount: l.amount.toFixed(), taxRateId: l.taxRateId })),
      );
      if (!computed.total.eq(c.total.toFixed()) || !computed.taxTotal.eq(c.taxTotal.toFixed())) {
        throw new DomainError('TOTAL_CHANGED', 'A tax rate used on this claim changed since it was submitted. Reject it so the claimant can save it again.', HttpStatus.CONFLICT);
      }
      const payable = await this.claimsAccount(tx, org.id, actor.id);
      const claimant = (await this.names([c.claimantId])).get(c.claimantId) ?? 'employee';
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date,
        source: 'EXPENSE',
        memo: `${c.number} · ${claimant} · ${c.title}`,
        reference: c.number,
        lines: buildExpenseClaimJournal(computed, payable, org.functionalCurrency),
      });
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { ...{ status: 'APPROVED', decidedById: actor.id, decidedAt: new Date(), decisionNote: input.note || null, journalEntryId: je.id, postingDate: toDbDate(date) }, updatedAt: new Date() });
      return { action: 'expense_claim.approved', data: { journalEntryId: je.id, date, total: c.total.toFixed(), note: input.note ?? null } };
    });
  }

  async reject(org: OrgContext, actor: Actor, id: string, note: string) {
    this.require(org, 'approvals.decide', 'reject expense claims');
    return this.transition(org, actor, id, 'decide', async (tx, c) => {
      if (c.status !== 'SUBMITTED') throw new DomainError('NOT_SUBMITTED', `This claim is ${c.status.toLowerCase()}, not waiting for approval`, HttpStatus.CONFLICT);
      if (c.claimantId === actor.id) throw new DomainError('SAME_PERSON', 'You cannot decide on your own expense claim', HttpStatus.FORBIDDEN);
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { ...{ status: 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: note }, updatedAt: new Date() });
      return { action: 'expense_claim.rejected', data: { note } };
    });
  }

  async reimburse(org: OrgContext, actor: Actor, id: string, input: { bankAccountId: string; date: string; reference?: string | null }) {
    this.require(org, 'expenses.reimburse', 'reimburse expense claims');
    return this.transition(org, actor, id, 'any', async (tx, c) => {
      if (c.status !== 'APPROVED') throw new DomainError('NOT_APPROVED', c.status === 'REIMBURSED' ? 'This claim was already reimbursed' : 'Only approved claims can be reimbursed', HttpStatus.CONFLICT);
      if (input.date < fromDbDate(c.postingDate!)) throw new DomainError('INVALID_DATE', 'The reimbursement cannot be dated before the claim was approved');
      const bank = await tx.account.findFirst({ where: { id: input.bankAccountId, orgId: org.id } });
      if (!bank || !bank.isActive || !bank.isPostable || (bank.subtype !== 'BANK' && bank.subtype !== 'CASH')) {
        throw new DomainError('INVALID_BANK_ACCOUNT', 'Choose an active bank or cash account');
      }
      const payable = await this.claimsAccount(tx, org.id, actor.id);
      const claimant = (await this.names([c.claimantId])).get(c.claimantId) ?? 'employee';
      const je = await this.journals.postSystemEntry(tx, org, actor, {
        date: input.date,
        source: 'EXPENSE',
        memo: `Reimbursement ${c.number} · ${claimant}${input.reference ? ` · ${input.reference}` : ''}`,
        reference: c.number,
        lines: buildReimbursementJournal(new D(c.total.toFixed()), bank.id, payable, org.functionalCurrency),
      });
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { status: 'REIMBURSED', reimbursementJournalEntryId: je.id, reimbursedOn: toDbDate(input.date), reimbursedById: actor.id, bankAccountId: bank.id, reimbursementReference: input.reference || null, updatedAt: new Date() });
      return { action: 'expense_claim.reimbursed', data: { journalEntryId: je.id, bankAccountId: bank.id, date: input.date } };
    });
  }

  /** Reverses the posting of an approved, unpaid claim. The claim stays on record, marked void. */
  async void(org: OrgContext, actor: Actor, id: string, input: { date: string; reason: string }) {
    this.require(org, 'journals.reverse', 'void expense claims');
    return this.transition(org, actor, id, 'any', async (tx, c) => {
      if (c.status !== 'APPROVED') throw new DomainError('NOT_APPROVED', c.status === 'REIMBURSED' ? 'A reimbursed claim cannot be voided' : 'Only approved claims can be voided', HttpStatus.CONFLICT);
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, c.journalEntryId!, { date: input.date, memo: `Void ${c.number}: ${input.reason}` });
      await this.moved.update(tx, EXPENSE_CLAIMS, org.id, id, { ...{ status: 'VOID', voidJournalEntryId: rev.id, voidDate: toDbDate(input.date), voidReason: input.reason }, updatedAt: new Date() });
      return { action: 'expense_claim.voided', data: { reason: input.reason, reversalEntryId: rev.id } };
    });
  }

  /** Visibility for attachments: the claimant, or anyone who can read all claims. */
  async attachmentAccess(org: OrgContext, actorId: string, id: string, access: 'read' | 'manage') {
    const c = await this.prisma.expenseClaim.findFirst({ where: { id, orgId: org.id }, select: { claimantId: true, status: true } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
    const own = c.claimantId === actorId;
    if (!own && !hasPermission(org.role, 'expenses.read')) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
    if (access === 'read') return;
    // Claimants add receipts until the claim is approved; finance can add evidence at any time.
    if (own && ['DRAFT', 'REJECTED', 'SUBMITTED'].includes(c.status) && hasPermission(org.role, 'expenses.submit')) return;
    if (hasPermission(org.role, 'expenses.reimburse')) return;
    throw new DomainError('FORBIDDEN', own ? `Receipts can no longer be changed on a ${c.status.toLowerCase()} claim` : 'Only the claimant or finance can change files on this claim', HttpStatus.FORBIDDEN);
  }

  // ------------------------------------------------------------------ internals

  private async transition(
    org: OrgContext,
    actor: Actor,
    id: string,
    who: 'own' | 'decide' | 'any',
    step: (tx: Tx, c: ClaimRow) => Promise<{ action: string; data: Record<string, unknown> }>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const c = who === 'own' ? await this.lockOwn(tx, org, actor, id) : await this.lock(tx, org, actor, id);
      const { action, data } = await step(tx, c);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action, entityType: 'expense_claim', entityId: id, data: { number: c.number, ...data } });
      return this.serialize(org, actor, await tx.expenseClaim.findUniqueOrThrow({ where: { id }, include: CLAIM_INCLUDE }), tx);
    });
  }

  private async lock(tx: Tx, org: OrgContext, actor: Actor, id: string) {
    await lockRow(tx, 'expense_claims', id, org.id);
    const c = await tx.expenseClaim.findFirst({ where: { id, orgId: org.id }, include: CLAIM_INCLUDE });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
    this.assertCanSee(org, actor, c.claimantId);
    return c;
  }

  private async lockOwn(tx: Tx, org: OrgContext, actor: Actor, id: string) {
    const c = await this.lock(tx, org, actor, id);
    if (c.claimantId !== actor.id) throw new DomainError('NOT_CLAIMANT', 'Only the person who made this claim can change it', HttpStatus.FORBIDDEN);
    this.require(org, 'expenses.submit', 'claim expenses');
    return c;
  }

  private assertCanSee(org: OrgContext, actor: Actor, claimantId: string) {
    if (claimantId !== actor.id && !hasPermission(org.role, 'expenses.read')) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Expense claim not found' });
  }

  private async prepare(tx: Tx, org: OrgContext, lines: ExpenseLineInput[]) {
    const o = await tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    const control = new Set([o.arAccountId, o.apAccountId, o.claimsAccountId].filter(Boolean));
    const accounts = await tx.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(lines.map((l) => l.accountId))] } } });
    const taxIds = [...new Set(lines.map((l) => l.taxRateId).filter((x): x is string => !!x))];
    const taxes = await tx.taxRate.findMany({ where: { orgId: org.id, id: { in: taxIds } } });
    const issues: string[] = [];
    const today = todayIso();
    lines.forEach((l, i) => {
      const a = accounts.find((x) => x.id === l.accountId);
      if (!a) issues.push(`Line ${i + 1}: account not found`);
      else if (control.has(a.id)) issues.push(`Line ${i + 1}: ${a.code} is a control account`);
      else if (a.type !== 'EXPENSE') issues.push(`Line ${i + 1}: ${a.code} ${a.name} is not an expense account`);
      else if (!a.isPostable || !a.isActive) issues.push(`Line ${i + 1}: ${a.code} ${a.name} cannot be posted to`);
      const t = l.taxRateId ? taxes.find((x) => x.id === l.taxRateId) : null;
      if (l.taxRateId && t && !t.isActive) issues.push(`Line ${i + 1}: tax rate ${t.name} is inactive`);
      // A claim has no supplier GSTIN, so GST input credit cannot be claimed through it; enter a bill instead.
      if (t && t.kind === 'GST') issues.push(`Line ${i + 1}: GST rates cannot be used on expense claims; enter the supplier's tax invoice as a bill to claim input tax credit`);
      if (l.date > today) issues.push(`Line ${i + 1}: the date is in the future`);
    });
    if (issues.length) throw new DomainError('CLAIM_INVALID', 'The claim is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const rates = new Map<string, TaxRateInfo>(taxes.map((t) => [t.id, { id: t.id, name: t.name, rate: t.rate.toFixed(), accountId: t.purchaseAccountId }]));
    return computeExpenseClaim(lines, org.functionalCurrency, rates);
  }

  /**
   * The employee reimbursements account; organisations created before it existed get one on
   * first use, inside the caller's transaction (MongoDB changes commit with it). The row lock on
   * the organisation's copy makes two first uses take turns; if MongoDB still sees them collide,
   * the whole transaction runs again.
   */
  private async claimsAccount(tx: Tx, orgId: string, actorId: string): Promise<string> {
    const known = (await this.store.collection(organizations).findById(orgId))?.claimsAccountId;
    if (known) return known;
    await lockRow(tx, 'organizations', orgId);
    const candidates = ['2250', '2251', '2252', '2253', '2254', '2255', '2256', '2257', '2258', '2259'];
    const taken = new Set((await this.chart.find(orgId, { code: { $in: candidates } })).map((a) => a.code));
    const code = candidates.find((x) => !taken.has(x));
    if (!code) throw new DomainError('NO_CLAIMS_ACCOUNT', 'Could not find a free account code (2250–2259) for employee reimbursements', HttpStatus.CONFLICT);
    const id = await this.chart.create(tx, orgId, actorId, { code, name: 'Employee Reimbursements Payable', type: 'LIABILITY', subtype: 'EMPLOYEE_REIMBURSEMENTS', parentCode: '2000' }, 'Employee expense claims');
    await this.store.collection(organizations).updateOne({ id: orgId, claimsAccountId: null }, { $set: { claimsAccountId: id, updatedAt: new Date() } });
    await this.mirror.organizations([orgId], tx);
    return id;
  }

  private async nextNumber(tx: Tx, orgId: string) {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, 'doc:EXPENSE_CLAIM') }];
    return value;
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private require(org: OrgContext, permission: Permission, what: string) {
    if (!hasPermission(org.role, permission)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
  }

  private async serialize(org: OrgContext, actor: Actor, c: ClaimRow, db: Pick<Tx, 'expenseClaimLine' | 'attachment' | 'account'>) {
    const scale = minorUnits(c.currency);
    const names = await this.names([c.claimantId, c.decidedById, c.reimbursedById]);
    // Same date and amount in another live claim by the same person: possibly the same receipt twice.
    const others = await db.expenseClaimLine.findMany({
      where: { orgId: org.id, claimId: { not: c.id }, claim: { claimantId: c.claimantId, status: { not: 'VOID' } }, date: { in: [...new Set(c.lines.map((l) => l.date))] } },
      select: { date: true, amount: true, claim: { select: { number: true } } },
      take: DUPLICATE_WINDOW,
    });
    const dupes = possibleDuplicateLines(
      c.lines.map((l) => ({ lineNo: l.lineNo, date: fromDbDate(l.date), amount: new D(l.amount.toFixed()) })),
      others.map((o) => ({ claimLabel: o.claim.number, date: fromDbDate(o.date), amount: new D(o.amount.toFixed()) })),
    );
    const receipts = await db.attachment.count({ where: { orgId: org.id, entityType: 'EXPENSE_CLAIM', entityId: c.id, removedAt: null } });
    const bank = c.bankAccountId ? await db.account.findUnique({ where: { id: c.bankAccountId }, select: { code: true, name: true } }) : null;
    const own = c.claimantId === actor.id;
    const decide = hasPermission(org.role, 'approvals.decide') && hasPermission(org.role, 'journals.post');
    return {
      id: c.id,
      number: c.number,
      title: c.title,
      status: c.status,
      currency: c.currency,
      claimantId: c.claimantId,
      claimant: names.get(c.claimantId) ?? null,
      netTotal: c.netTotal.toFixed(scale),
      taxTotal: c.taxTotal.toFixed(scale),
      total: c.total.toFixed(scale),
      submittedAt: c.submittedAt?.toISOString() ?? null,
      decidedBy: c.decidedById ? (names.get(c.decidedById) ?? null) : null,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      decisionNote: c.decisionNote,
      journalEntryId: c.journalEntryId,
      postingDate: c.postingDate ? fromDbDate(c.postingDate) : null,
      reimbursementJournalEntryId: c.reimbursementJournalEntryId,
      reimbursedOn: c.reimbursedOn ? fromDbDate(c.reimbursedOn) : null,
      reimbursedBy: c.reimbursedById ? (names.get(c.reimbursedById) ?? null) : null,
      reimbursementReference: c.reimbursementReference,
      bankAccount: bank ? `${bank.code} · ${bank.name}` : null,
      voidJournalEntryId: c.voidJournalEntryId,
      voidDate: c.voidDate ? fromDbDate(c.voidDate) : null,
      voidReason: c.voidReason,
      createdAt: c.createdAt.toISOString(),
      receiptCount: receipts,
      lines: c.lines.map((l) => ({
        lineNo: l.lineNo,
        date: fromDbDate(l.date),
        accountId: l.accountId,
        accountCode: l.account.code,
        accountName: l.account.name,
        merchant: l.merchant,
        description: l.description,
        amount: l.amount.toFixed(scale),
        taxRateId: l.taxRateId,
        taxName: l.tax?.name ?? null,
        taxRate: l.taxRate.toFixed(),
        netAmount: l.netAmount.toFixed(scale),
        taxAmount: l.taxAmount.toFixed(scale),
        possibleDuplicateOf: dupes.get(l.lineNo) ?? [],
      })),
      /** UI hints only; every action is checked again on the server. */
      actions: {
        edit: own && EDITABLE.includes(c.status) && hasPermission(org.role, 'expenses.submit'),
        submit: own && EDITABLE.includes(c.status) && hasPermission(org.role, 'expenses.submit'),
        withdraw: own && c.status === 'SUBMITTED',
        delete: own && c.status === 'DRAFT',
        decide: !own && c.status === 'SUBMITTED' && decide,
        reimburse: c.status === 'APPROVED' && hasPermission(org.role, 'expenses.reimburse'),
        void: c.status === 'APPROVED' && hasPermission(org.role, 'journals.reverse'),
        attach: (own && ['DRAFT', 'REJECTED', 'SUBMITTED'].includes(c.status) && hasPermission(org.role, 'expenses.submit')) || hasPermission(org.role, 'expenses.reimburse'),
      },
    };
  }
}

function lineRows(computed: ReturnType<typeof computeExpenseClaim>) {
  return computed.lines.map((l) => ({
    id: randomUUID(),
    lineNo: l.lineNo,
    date: toDbDate(l.date),
    accountId: l.accountId,
    merchant: l.merchant,
    description: l.description,
    amount: l.amount.toFixed(),
    taxRateId: l.taxRateId,
    taxRate: l.taxRate.toFixed(),
    netAmount: l.netAmount.toFixed(),
    taxAmount: l.taxAmount.toFixed(),
  }));
}
