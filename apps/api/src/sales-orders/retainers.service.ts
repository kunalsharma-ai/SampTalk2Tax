import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, type Dec, drawdownIssues, minorUnits, planDrawdown, retainerIssues, retainerRef, retainerState, topUpDue, type RetainerStatus } from '@talk2tax/accounting-engine';
import { Prisma, Retainer } from '@talk2tax/database';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { SalesOrg, SalesOrdersService } from './sales-orders.service';

type Actor = { id: string };
type Db = Tx | PrismaService;
export interface RetainerInput {
  contactId: string;
  name: string;
  amount: string;
  minimumBalance: string;
  startDate: string;
  terms?: string | null;
}
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

/**
 * Retainers (AR-015). A retainer is held as ordinary customer receipts that are not yet applied,
 * linked to it, so the books need nothing new: the receipts post Dr bank, Cr receivables, and the
 * customer is in credit until the retainer is drawn down onto invoices with ordinary allocations.
 */
@Injectable()
export class RetainersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly subledger: SubledgerService,
    private readonly sales: SalesOrdersService,
    private readonly audit: AuditService,
  ) {}

  private invalid(message: string, code = 'RETAINER_INVALID', details?: unknown): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  private money(org: SalesOrg, v: Prisma.Decimal | Dec | string) {
    return new D(v.toString()).toFixed(minorUnits(org.functionalCurrency));
  }

  private can(org: SalesOrg) {
    return { manage: hasPermission(org.role, 'sales.manage') };
  }

  /** The retainer's receipts with what is left of each (void receipts hold nothing). */
  private async receipts(db: Db, orgId: string, retainerIds: string[]) {
    const links = retainerIds.length ? await db.retainerReceipt.findMany({ where: { orgId, retainerId: { in: retainerIds } } }) : [];
    const pays = links.length
      ? await db.payment.findMany({ where: { orgId, id: { in: links.map((l) => l.paymentId) } }, include: { allocations: { where: { removedOn: null }, include: { target: { select: { id: true, number: true } } } }, bankAccount: { select: { id: true, code: true, name: true } } } })
      : [];
    return links.map((l) => {
      const p = pays.find((x) => x.id === l.paymentId)!;
      const used = p.allocations.reduce((t, a) => t.plus(a.amount.toString()), new D(0));
      const left = p.status === 'POSTED' ? new D(p.amount.toString()).minus(used) : new D(0);
      return { retainerId: l.retainerId, linkedAt: l.createdAt, p, used, left };
    });
  }

  private out(org: SalesOrg, r: Retainer, contact: { id: string; name: string } | undefined, held: Dec) {
    const terms = { status: r.status as RetainerStatus, amount: r.amount.toString(), minimumBalance: r.minimumBalance.toString() };
    return {
      id: r.id,
      reference: retainerRef(r.number),
      contact: contact ?? null,
      name: r.name,
      amount: this.money(org, r.amount),
      minimumBalance: this.money(org, r.minimumBalance),
      startDate: fromDbDate(r.startDate),
      terms: r.terms,
      status: r.status,
      state: retainerState(terms, held.toFixed()),
      held: this.money(org, held),
      topUpDue: this.money(org, topUpDue(terms, held.toFixed())),
      currency: org.functionalCurrency,
      closedAt: r.closedAt?.toISOString() ?? null,
      closeReason: r.closeReason,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async list(org: SalesOrg, f: { view?: 'active' | 'closed' | 'all'; contactId?: string }) {
    const rs = await this.prisma.retainer.findMany({
      where: { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}), ...(f.view === 'all' ? {} : { status: f.view === 'closed' ? 'CLOSED' : 'ACTIVE' }) },
      orderBy: { number: 'desc' },
      take: 500,
    });
    const [rec, contacts] = await Promise.all([this.receipts(this.prisma, org.id, rs.map((r) => r.id)), this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(rs.map((r) => r.contactId))] } }, select: { id: true, name: true } })]);
    const retainers = rs.map((r) => this.out(org, r, contacts.find((c) => c.id === r.contactId), rec.filter((x) => x.retainerId === r.id).reduce((t, x) => t.plus(x.left), new D(0))));
    const active = retainers.filter((r) => r.status === 'ACTIVE');
    return {
      retainers,
      totals: {
        held: this.money(org, active.reduce((t, r) => t.plus(r.held), new D(0))),
        topUpDue: this.money(org, active.reduce((t, r) => t.plus(r.topUpDue), new D(0))),
        due: active.filter((r) => new D(r.topUpDue).gt(0)).length,
      },
      can: this.can(org),
    };
  }

  private async load(db: Db, orgId: string, id: string) {
    const r = await db.retainer.findFirst({ where: { id, orgId } });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Retainer not found' });
    return r;
  }

  private async lock(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM retainers WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    return this.load(tx, orgId, id);
  }

  async get(org: SalesOrg, id: string) {
    const r = await this.load(this.prisma, org.id, id);
    const [rec, contact, items, linked] = await Promise.all([
      this.receipts(this.prisma, org.id, [r.id]),
      this.prisma.contact.findFirst({ where: { orgId: org.id, id: r.contactId }, select: { id: true, name: true } }),
      this.subledger.openItems(this.prisma, org.id, 'SALES', todayIso(), r.contactId),
      this.prisma.retainerReceipt.findMany({ where: { orgId: org.id }, select: { paymentId: true } }),
    ]);
    const held = rec.reduce((t, x) => t.plus(x.left), new D(0));
    const taken = new Set(linked.map((l) => l.paymentId));
    const fc = org.functionalCurrency;
    return {
      ...this.out(org, r, contact ?? undefined, held),
      receipts: rec
        .sort((a, b) => a.p.date.getTime() - b.p.date.getTime() || a.p.createdAt.getTime() - b.p.createdAt.getTime())
        .map((x) => ({ id: x.p.id, number: x.p.number, date: fromDbDate(x.p.date), status: x.p.status, amount: this.money(org, x.p.amount), applied: this.money(org, x.used), left: this.money(org, x.left), reference: x.p.reference, bankAccount: x.p.bankAccount })),
      drawdowns: rec
        .flatMap((x) => x.p.allocations.map((a) => ({ id: a.id, receipt: x.p.number, date: fromDbDate(a.date), amount: this.money(org, a.amount), invoice: { id: a.target.id, number: a.target.number } })))
        .sort((a, b) => a.date.localeCompare(b.date)),
      openInvoices: items
        .filter((i) => i.type === 'charge' && i.currency === fc)
        .sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date))
        .map((i) => ({ id: i.id, number: i.number, issueDate: i.date, dueDate: i.dueDate, total: this.money(org, i.foreignTotal), open: this.money(org, i.foreignOpen) })),
      // Receipts from this customer not yet applied and not part of any retainer, which can be added to it.
      otherReceipts: items
        .filter((i) => i.type === 'payment' && i.currency === fc && !taken.has(i.id))
        .map((i) => ({ id: i.id, number: i.number, date: i.date, unapplied: this.money(org, i.foreignOpen) })),
      can: this.can(org),
    };
  }

  private async checkCustomer(db: Db, orgId: string, contactId: string) {
    const c = await db.contact.findFirst({ where: { id: contactId, orgId }, select: { isCustomer: true } });
    if (!c) this.invalid('Choose a customer of this organisation', 'RETAINER_CUSTOMER');
    if (!c.isCustomer) this.invalid('This contact is not a customer', 'RETAINER_CUSTOMER');
  }

  private terms(org: SalesOrg, input: { name: string; amount: string; minimumBalance: string }) {
    const issues = retainerIssues(input, minorUnits(org.functionalCurrency));
    if (issues.length) this.invalid(issues[0]!, 'RETAINER_INVALID', { issues });
  }

  async create(org: SalesOrg, actor: Actor, input: RetainerInput) {
    this.terms(org, input);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkCustomer(tx, org.id, input.contactId);
      const number = await this.sales.nextNumber(tx, org.id, 'retainer');
      const r = await tx.retainer.create({
        data: { orgId: org.id, number, contactId: input.contactId, name: input.name.trim(), amount: new D(input.amount).toFixed(), minimumBalance: new D(input.minimumBalance || '0').toFixed(), startDate: toDbDate(input.startDate), terms: clean(input.terms), createdById: actor.id },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'retainer.created', entityType: 'retainer', entityId: r.id, data: { reference: retainerRef(number), contactId: input.contactId, amount: input.amount, minimumBalance: input.minimumBalance } });
      return r.id;
    });
    return this.get(org, id);
  }

  async update(org: SalesOrg, actor: Actor, id: string, input: Omit<RetainerInput, 'contactId'>) {
    this.terms(org, input);
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'ACTIVE') this.invalid('This retainer is closed', 'RETAINER_CLOSED');
      await tx.retainer.update({ where: { id }, data: { name: input.name.trim(), amount: new D(input.amount).toFixed(), minimumBalance: new D(input.minimumBalance || '0').toFixed(), startDate: toDbDate(input.startDate), terms: clean(input.terms) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'retainer.updated', entityType: 'retainer', entityId: id, data: { reference: retainerRef(r.number), from: { amount: r.amount.toFixed(), minimumBalance: r.minimumBalance.toFixed() }, to: { amount: input.amount, minimumBalance: input.minimumBalance } } });
    });
    return this.get(org, id);
  }

  /** Record a new receipt into the retainer, or add an unapplied receipt already recorded. */
  async addReceipt(org: SalesOrg, actor: Actor, id: string, input: { paymentId?: string | null; date?: string | null; bankAccountId?: string | null; amount?: string | null; reference?: string | null; memo?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'ACTIVE') this.invalid('This retainer is closed', 'RETAINER_CLOSED');
      let paymentId = input.paymentId ?? null;
      if (paymentId) {
        const p = await tx.payment.findFirst({ where: { id: paymentId, orgId: org.id }, include: { allocations: { where: { removedOn: null } } } });
        if (!p || p.kind !== 'RECEIPT') this.invalid('Choose a customer receipt', 'RETAINER_RECEIPT');
        if (p.contactId !== r.contactId) this.invalid('This receipt is from another customer', 'RETAINER_RECEIPT');
        if (p.status !== 'POSTED') this.invalid('This receipt is void', 'RETAINER_RECEIPT');
        if (p.currency !== org.functionalCurrency) this.invalid(`Retainers are held in ${org.functionalCurrency}`, 'RETAINER_RECEIPT');
        if (await tx.retainerReceipt.findUnique({ where: { paymentId } })) this.invalid('This receipt is already part of a retainer', 'RETAINER_RECEIPT');
        const used = p.allocations.reduce((t, a) => t.plus(a.amount.toString()), new D(0));
        if (used.gte(p.amount.toString())) this.invalid(`${p.number} is fully applied to invoices; there is nothing to hold`, 'RETAINER_RECEIPT');
      } else {
        if (!input.date || !input.bankAccountId || !input.amount) this.invalid('Enter the date, bank account and amount received', 'RETAINER_RECEIPT');
        if (new D(input.amount).lte(0)) this.invalid('The amount received must be above zero', 'RETAINER_RECEIPT');
        const p = await this.documents.recordPaymentInTx(tx, org, actor, 'SALES', {
          contactId: r.contactId,
          date: input.date,
          bankAccountId: input.bankAccountId,
          amount: input.amount,
          reference: clean(input.reference) ?? retainerRef(r.number),
          memo: clean(input.memo) ?? `Retainer ${retainerRef(r.number)}: ${r.name}`,
          allocations: [],
        });
        paymentId = p.id;
      }
      await tx.retainerReceipt.create({ data: { orgId: org.id, retainerId: id, paymentId, createdById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'retainer.receipt_added', entityType: 'retainer', entityId: id, data: { reference: retainerRef(r.number), paymentId, recorded: !input.paymentId } });
    });
    return this.get(org, id);
  }

  /**
   * Pay invoices from the retainer: chosen invoices and amounts, or every open invoice of the
   * customer oldest due first up to what is held. Each part is an ordinary allocation of one of the
   * retainer's receipts, oldest receipt first.
   */
  async drawdown(org: SalesOrg, actor: Actor, id: string, input: { invoices?: { documentId: string; amount: string }[] | null; oldestFirst?: boolean | null }) {
    const made = await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'ACTIVE') this.invalid('This retainer is closed', 'RETAINER_CLOSED');
      const rec = (await this.receipts(tx, org.id, [id])).filter((x) => x.left.gt(0));
      const held = rec.reduce((t, x) => t.plus(x.left), new D(0));
      if (held.lte(0)) this.invalid('The retainer holds nothing; record a receipt into it first', 'RETAINER_EMPTY');
      const open = (await this.subledger.openItems(tx, org.id, 'SALES', todayIso(), r.contactId)).filter((i) => i.type === 'charge' && i.currency === org.functionalCurrency);
      let wanted: { documentId: string; amount: string; number: string | null; open: string; dueDate: string; issueDate: string }[];
      if (input.oldestFirst) {
        let left = held;
        wanted = [];
        for (const i of [...open].sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date))) {
          if (left.lte(0)) break;
          const amt = D.min(left, i.foreignOpen);
          wanted.push({ documentId: i.id, amount: amt.toFixed(), number: i.number, open: i.foreignOpen.toFixed(), dueDate: i.dueDate ?? i.date, issueDate: i.date });
          left = left.minus(amt);
        }
        if (!wanted.length) this.invalid('This customer has no open invoices to pay', 'RETAINER_NOTHING_OPEN');
      } else {
        const ids = (input.invoices ?? []).map((x) => x.documentId);
        if (new Set(ids).size !== ids.length) this.invalid('Each invoice can appear only once', 'RETAINER_DRAWDOWN_INVALID');
        wanted = (input.invoices ?? []).map((x) => {
          const i = open.find((o) => o.id === x.documentId);
          if (!i) this.invalid('An invoice is not open for this customer', 'RETAINER_DRAWDOWN_INVALID');
          return { documentId: i.id, amount: x.amount, number: i.number, open: i.foreignOpen.toFixed(), dueDate: i.dueDate ?? i.date, issueDate: i.date };
        });
      }
      const issues = drawdownIssues(held.toFixed(), wanted);
      if (issues.length) this.invalid(issues[0]!, 'RETAINER_DRAWDOWN_INVALID', { issues });
      const plan = planDrawdown(
        [...rec].sort((a, b) => a.p.createdAt.getTime() - b.p.createdAt.getTime()).map((x) => ({ id: x.p.id, date: fromDbDate(x.p.date), unallocated: x.left.toFixed() })),
        wanted.map((w) => ({ id: w.documentId, dueDate: w.dueDate, issueDate: w.issueDate, open: w.open, amount: w.amount })),
      );
      const byReceipt = new Map<string, { documentId: string; amount: string }[]>();
      for (const a of plan) byReceipt.set(a.paymentId, [...(byReceipt.get(a.paymentId) ?? []), { documentId: a.documentId, amount: a.amount }]);
      for (const [paymentId, allocations] of byReceipt) await this.documents.allocateInTx(tx, org, actor, 'SALES', paymentId, allocations);
      const total = wanted.reduce((t, w) => t.plus(w.amount), new D(0));
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'retainer.drawn_down', entityType: 'retainer', entityId: id, data: { reference: retainerRef(r.number), total: total.toFixed(), invoices: wanted.map((w) => ({ documentId: w.documentId, number: w.number, amount: w.amount })) } });
      return { total: this.money(org, total), invoices: wanted.length };
    });
    return { ...made, retainer: await this.get(org, id) };
  }

  /** Close a retainer once it holds nothing (draw it down, or refund and void its receipts first). */
  async close(org: SalesOrg, actor: Actor, id: string, reason: string) {
    if (!reason.trim()) this.invalid('Say why the retainer is closed', 'RETAINER_REASON_REQUIRED');
    await this.prisma.$transaction(async (tx) => {
      const r = await this.lock(tx, org.id, id);
      if (r.status !== 'ACTIVE') this.invalid('This retainer is already closed', 'RETAINER_CLOSED');
      const held = (await this.receipts(tx, org.id, [id])).reduce((t, x) => t.plus(x.left), new D(0));
      if (held.gt(0)) this.invalid(`The retainer still holds ${this.money(org, held)}; apply it to invoices or refund it before closing`, 'RETAINER_NOT_EMPTY');
      await tx.retainer.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closeReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'retainer.closed', entityType: 'retainer', entityId: id, data: { reference: retainerRef(r.number), reason: reason.trim() } });
    });
    return this.get(org, id);
  }
}
