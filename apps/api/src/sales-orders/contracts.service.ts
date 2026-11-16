import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  addDays,
  contractPeriod,
  ContractError,
  D,
  duePeriods,
  FREQUENCY_LABEL,
  FREQUENCY_MONTHS,
  fullyBilled,
  minorUnits,
  monthlyValue,
  periodCount,
  periodLabel,
  renewalState,
  renewedEnd,
  upcomingPeriods,
  upliftPrice,
  type ContractFrequency,
  type ContractStatus,
} from '@talk2tax/accounting-engine';
import { Prisma, SalesContract, SalesContractLine } from '@talk2tax/database';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { DocumentsService } from '../ledgers/documents.service';
import { todayIst } from '../tasks/tasks.service';
import { LineInput, SalesOrg, SalesOrdersService } from './sales-orders.service';

type Actor = { id: string };
export interface ContractInput {
  contactId: string;
  dealId?: string | null;
  title: string;
  frequency: ContractFrequency;
  timing: 'ADVANCE' | 'ARREARS';
  startDate: string;
  endDate?: string | null;
  autoRenew: boolean;
  renewalMonths?: number | null;
  noticeDays: number;
  paymentTermsDays?: number | null;
  placeOfSupply?: string | null;
  reference?: string | null;
  memo?: string | null;
  lines: LineInput[];
}

const ref = (n: number) => `CT-${String(n).padStart(4, '0')}`;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
type Full = SalesContract & { lines: SalesContractLine[] };
type View = 'active' | 'renewals' | 'draft' | 'closed' | 'all';

/**
 * Customer contracts billed every period (CRM slice 3). Each period that falls due becomes a
 * draft invoice, made by the same code as any invoice, from the contract's lines as they stand
 * on that day. The billing runner does this in the background; *Bill now* does it on request.
 * Periods are recorded once (billed, or skipped while paused), so nothing is billed twice.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger('Contracts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesOrdersService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  private rule<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof ContractError) this.sales.invalid(e.message, e.code);
      throw e;
    }
  }

  private async event(tx: Tx, c: { id: string; orgId: string }, actor: Actor | null, kind: string, body: string, data?: Record<string, unknown>) {
    await tx.salesContractEvent.create({ data: { orgId: c.orgId, contractId: c.id, kind, body: body.slice(0, 1000), data: (data ?? undefined) as Prisma.InputJsonValue | undefined, actorId: actor?.id ?? null } });
  }

  private async lock(tx: Tx, orgId: string, id: string): Promise<Full> {
    await tx.$queryRaw`SELECT id FROM sales_contracts WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const c = await tx.salesContract.findFirst({ where: { id, orgId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contract not found' });
    return c;
  }

  private schedule(c: Pick<SalesContract, 'startDate' | 'endDate' | 'frequency' | 'timing' | 'nextPeriodNo'>) {
    return { start: fromDbDate(c.startDate), end: c.endDate ? fromDbDate(c.endDate) : null, frequency: c.frequency as ContractFrequency, timing: c.timing, nextNo: c.nextPeriodNo };
  }

  /** Checks the terms that do not depend on the database. */
  private checkTerms(input: ContractInput) {
    if (input.endDate) this.rule(() => periodCount(input.startDate, input.endDate!, input.frequency));
    if (input.autoRenew) {
      if (!input.endDate) this.sales.invalid('A rolling contract has no end date to renew; give an end date or turn off auto-renew', 'CONTRACT_RENEWAL');
      const m = input.renewalMonths ?? 0;
      if (m < FREQUENCY_MONTHS[input.frequency] || m % FREQUENCY_MONTHS[input.frequency]) this.sales.invalid(`Renew for a whole number of ${FREQUENCY_LABEL[input.frequency].toLowerCase()} periods (${FREQUENCY_MONTHS[input.frequency]} months each)`, 'CONTRACT_RENEWAL');
    }
  }

  private data(input: ContractInput, c: Awaited<ReturnType<SalesOrdersService['compute']>>) {
    return {
      contactId: input.contactId,
      dealId: input.dealId ?? null,
      title: input.title.trim(),
      frequency: input.frequency,
      timing: input.timing,
      startDate: toDbDate(input.startDate),
      endDate: input.endDate ? toDbDate(input.endDate) : null,
      autoRenew: input.autoRenew,
      renewalMonths: input.autoRenew ? (input.renewalMonths ?? null) : null,
      noticeDays: input.noticeDays,
      paymentTermsDays: input.paymentTermsDays ?? null,
      placeOfSupply: c.placeOfSupply,
      reference: clean(input.reference),
      memo: clean(input.memo),
      subtotal: c.subtotal,
      taxTotal: c.taxTotal,
      total: c.total,
    };
  }

  // ------------------------------------------------------------------ reading

  private out(org: SalesOrg, c: SalesContract, n: Awaited<ReturnType<SalesOrdersService['names']>>, today: string) {
    const s = this.schedule(c);
    const live = c.status === 'ACTIVE' || c.status === 'PAUSED';
    const next = live && !fullyBilled(s) ? upcomingPeriods(s, 1)[0] ?? null : null;
    return {
      id: c.id,
      reference: ref(c.number),
      title: c.title,
      status: c.status as ContractStatus,
      contact: n.contact(c.contactId),
      deal: n.deal(c.dealId),
      frequency: c.frequency as ContractFrequency,
      timing: c.timing,
      startDate: s.start,
      endDate: s.end,
      autoRenew: c.autoRenew,
      renewalMonths: c.renewalMonths,
      noticeDays: c.noticeDays,
      paymentTermsDays: c.paymentTermsDays,
      placeOfSupply: c.placeOfSupply,
      customerReference: c.reference,
      memo: c.memo,
      currency: c.currency,
      subtotal: this.sales.money(org, c.subtotal),
      taxTotal: this.sales.money(org, c.taxTotal),
      total: this.sales.money(org, c.total),
      monthlyValue: monthlyValue(c.subtotal.toString(), c.frequency as ContractFrequency, this.scale(org)),
      renewal: live ? renewalState(s.end, c.noticeDays, today) : null,
      nextBill: next ? { periodNo: next.no, date: next.billDate, start: next.start, end: next.end } : null,
      periodsBilled: c.nextPeriodNo - 1,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      activatedAt: c.activatedAt?.toISOString() ?? null,
      cancelReason: c.cancelReason,
      cancelledAt: c.cancelledAt?.toISOString() ?? null,
      endedAt: c.endedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
    };
  }

  private scale(org: SalesOrg) {
    return minorUnits(org.functionalCurrency);
  }

  async list(org: SalesOrg, f: { view?: View; contactId?: string; dealId?: string }) {
    const today = todayIst();
    const all = await this.prisma.salesContract.findMany({
      where: { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}), ...(f.dealId ? { dealId: f.dealId } : {}) },
      orderBy: { number: 'desc' },
      take: 1000,
    });
    const n = await this.sales.names(org.id, all);
    const rows = all.map((c) => this.out(org, c, n, today));
    const view = f.view ?? 'active';
    const shown = rows.filter((r) =>
      view === 'all' ? true : view === 'active' ? r.status === 'ACTIVE' || r.status === 'PAUSED' : view === 'renewals' ? r.renewal === 'RENEWAL_DUE' || r.renewal === 'PAST_END' : view === 'draft' ? r.status === 'DRAFT' : r.status === 'ENDED' || r.status === 'CANCELLED',
    );
    const active = rows.filter((r) => r.status === 'ACTIVE');
    const scale = this.scale(org);
    const mrr = active.reduce((t, r) => t.plus(r.monthlyValue), new D(0));
    const in30 = addDays(today, 30);
    return {
      today,
      contracts: shown,
      summary: {
        active: active.length,
        paused: rows.filter((r) => r.status === 'PAUSED').length,
        mrr: mrr.toFixed(scale),
        arr: mrr.times(12).toFixed(scale),
        renewalsDue: rows.filter((r) => r.renewal === 'RENEWAL_DUE').length,
        endingIn30Days: active.filter((r) => r.endDate && !r.autoRenew && r.endDate <= in30).length,
        billingProblems: rows.filter((r) => r.lastError && (r.status === 'ACTIVE' || r.status === 'PAUSED')).length,
      },
      can: this.sales.can(org),
    };
  }

  async get(org: SalesOrg, id: string) {
    const today = todayIst();
    const c = await this.prisma.salesContract.findFirst({ where: { id, orgId: org.id }, include: { lines: { orderBy: { lineNo: 'asc' } }, periods: { orderBy: { periodNo: 'desc' }, take: 120 }, events: { orderBy: { createdAt: 'desc' }, take: 200 } } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contract not found' });
    const docIds = c.periods.map((p) => p.documentId).filter((x): x is string => !!x);
    const actorIds = [...new Set(c.events.map((e) => e.actorId).filter((x): x is string => !!x))];
    const [n, docs, actors] = await Promise.all([
      this.sales.names(org.id, [c], c.lines),
      docIds.length ? this.prisma.document.findMany({ where: { orgId: org.id, id: { in: docIds } }, select: { id: true, number: true, status: true, total: true, issueDate: true } }) : [],
      actorIds.length ? this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [],
    ]);
    const s = this.schedule(c);
    const live = c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'DRAFT';
    return {
      ...this.out(org, c, n, today),
      lines: c.lines.map((l) => this.sales.lineOut(org, l, n)),
      periods: c.periods.map((p) => {
        const d = p.documentId ? docs.find((x) => x.id === p.documentId) : null;
        return {
          id: p.id,
          periodNo: p.periodNo,
          start: fromDbDate(p.periodStart),
          end: fromDbDate(p.periodEnd),
          status: p.status,
          invoice: d ? { id: d.id, number: d.number, status: d.status, total: this.sales.money(org, d.total), issueDate: fromDbDate(d.issueDate) } : null,
          canBillAgain: p.status === 'BILLED' && (!d || d.status === 'VOID') && c.status !== 'CANCELLED',
        };
      }),
      upcoming: live ? upcomingPeriods(s, 6).map((p) => ({ periodNo: p.no, start: p.start, end: p.end, billDate: p.billDate })) : [],
      events: c.events.map((e) => ({ id: e.id, kind: e.kind, body: e.body, actor: e.actorId ? { id: e.actorId, name: actors.find((a) => a.id === e.actorId)?.name ?? 'A member' } : null, createdAt: e.createdAt.toISOString() })),
      can: this.sales.can(org),
    };
  }

  // ------------------------------------------------------------------ changing

  async create(org: SalesOrg, actor: Actor, input: ContractInput) {
    this.checkTerms(input);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.sales.checkDeal(tx, org.id, input.dealId, input.contactId);
      const c = await this.sales.compute(tx, org, { contactId: input.contactId, date: input.startDate, placeOfSupply: input.placeOfSupply, lines: input.lines });
      const number = await this.sales.nextNumber(tx, org.id, 'sales_contract');
      const row = await tx.salesContract.create({ data: { orgId: org.id, number, currency: org.functionalCurrency, createdById: actor.id, ...this.data(input, c), lines: { create: c.lines.map((l) => ({ ...l, orgId: org.id })) } } });
      await this.event(tx, row, actor, 'CREATED', `Draft contract ${ref(number)} created`);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.created', entityType: 'sales_contract', entityId: row.id, data: { reference: ref(number), total: c.total, frequency: input.frequency } });
      return row.id;
    });
    return this.get(org, id);
  }

  /**
   * A draft changes freely. Once active, the customer, start date and schedule stay; the lines,
   * end date and renewal terms can change and apply to the periods billed from then on.
   */
  async update(org: SalesOrg, actor: Actor, id: string, input: ContractInput) {
    this.checkTerms(input);
    await this.prisma.$transaction(async (tx) => {
      const old = await this.lock(tx, org.id, id);
      if (old.status === 'ENDED' || old.status === 'CANCELLED') this.sales.invalid(`An ${old.status === 'ENDED' ? 'ended' : 'cancelled'} contract does not change${old.status === 'ENDED' ? '; renew it first' : ''}`, 'CONTRACT_CLOSED');
      if (old.status !== 'DRAFT') {
        if (input.contactId !== old.contactId || input.startDate !== fromDbDate(old.startDate) || input.frequency !== old.frequency || input.timing !== old.timing) {
          this.sales.invalid('An active contract keeps its customer, start date and billing schedule; cancel it and start a new one to change them', 'CONTRACT_SCHEDULE_FIXED');
        }
        if (old.nextPeriodNo > 1 && input.endDate) {
          const last = contractPeriod(fromDbDate(old.startDate), old.frequency as ContractFrequency, old.nextPeriodNo - 1);
          if (input.endDate < last.end) this.sales.invalid(`Periods up to ${last.end} are already billed; the end date cannot be earlier`, 'CONTRACT_END');
        }
      }
      await this.sales.checkDeal(tx, org.id, input.dealId, input.contactId);
      const c = await this.sales.compute(tx, org, { contactId: input.contactId, date: old.status === 'DRAFT' ? input.startDate : todayIst(), placeOfSupply: input.placeOfSupply, lines: input.lines });
      await tx.salesContractLine.deleteMany({ where: { contractId: id, orgId: org.id } });
      await tx.salesContract.update({ where: { id }, data: { ...this.data(input, c), lines: { create: c.lines.map((l) => ({ ...l, orgId: org.id })) } } });
      const changes = [
        !new D(old.total.toString()).eq(c.total) ? `amount per period ${this.sales.money(org, old.total)} → ${new D(c.total).toFixed(2)}` : null,
        fromDbDate(old.endDate ?? new Date(0)) !== (input.endDate ?? fromDbDate(new Date(0))) ? `end date ${old.endDate ? fromDbDate(old.endDate) : 'none'} → ${input.endDate ?? 'none (rolling)'}` : null,
        old.autoRenew !== input.autoRenew ? `auto-renew ${input.autoRenew ? 'on' : 'off'}` : null,
      ].filter(Boolean);
      await this.event(tx, old, actor, 'UPDATED', changes.length ? `Changed: ${changes.join('; ')}` : 'Details changed');
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.updated', entityType: 'sales_contract', entityId: id, data: { reference: ref(old.number), totalFrom: old.total.toFixed(), total: c.total, endDate: input.endDate ?? null } });
    });
    return this.get(org, id);
  }

  async remove(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status !== 'DRAFT') this.sales.invalid('Only a draft contract can be deleted; cancel it instead', 'CONTRACT_NOT_DRAFT');
      await tx.salesContract.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.deleted', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number) } });
    });
  }

  /** Start billing: the deal (if open) is won, and periods already due are billed now. */
  async activate(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status !== 'DRAFT') this.sales.invalid('Only a draft contract can be activated', 'CONTRACT_NOT_DRAFT');
      if (!c.lines.length) this.sales.invalid('Add at least one line', 'CONTRACT_NO_LINES');
      if (c.endDate && fromDbDate(c.endDate) < todayIst() && !c.autoRenew) this.sales.invalid('This contract has already ended; change its end date first', 'CONTRACT_END');
      await tx.salesContract.update({ where: { id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      await this.event(tx, c, actor, 'ACTIVATED', `Activated: billed ${FREQUENCY_LABEL[c.frequency as ContractFrequency].toLowerCase()} ${c.timing === 'ADVANCE' ? 'in advance' : 'in arrears'} from ${fromDbDate(c.startDate)}`);
      if (c.dealId) await this.sales.winDeal(tx, org, actor, c.dealId, `Won: contract ${ref(c.number)} signed`, 'contract signed');
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.activated', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number) } });
    });
    await this.billDue(org, actor, id);
    return this.get(org, id);
  }

  async pause(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status !== 'ACTIVE') this.sales.invalid('Only an active contract can be paused', 'CONTRACT_NOT_ACTIVE');
      await tx.salesContract.update({ where: { id }, data: { status: 'PAUSED' } });
      await this.event(tx, c, actor, 'PAUSED', 'Paused: periods falling due while paused are skipped, not billed');
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.paused', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number) } });
    });
    return this.get(org, id);
  }

  /** Resume: periods whose invoice date passed while paused are recorded as skipped. */
  async resume(org: SalesOrg, actor: Actor, id: string, today = todayIst()) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status !== 'PAUSED') this.sales.invalid('Only a paused contract can be resumed', 'CONTRACT_NOT_PAUSED');
      // Periods that fell due before today were missed while paused; today's is billed.
      const skipped = duePeriods(this.schedule(c), addDays(today, -1), 1200);
      if (skipped.length) {
        await tx.salesContractPeriod.createMany({ data: skipped.map((p) => ({ orgId: org.id, contractId: id, periodNo: p.no, periodStart: toDbDate(p.start), periodEnd: toDbDate(p.end), status: 'SKIPPED' as const })) });
      }
      await tx.salesContract.update({ where: { id }, data: { status: 'ACTIVE', nextPeriodNo: c.nextPeriodNo + skipped.length } });
      await this.event(tx, c, actor, 'RESUMED', skipped.length ? `Resumed; ${skipped.length} ${skipped.length === 1 ? 'period' : 'periods'} skipped (${skipped[0]!.start} to ${skipped[skipped.length - 1]!.end})` : 'Resumed');
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.resumed', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number), skipped: skipped.map((p) => p.no) } });
    });
    await this.billDue(org, actor, id, today);
    return this.get(org, id);
  }

  async cancel(org: SalesOrg, actor: Actor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status === 'DRAFT') this.sales.invalid('Delete the draft instead', 'CONTRACT_NOT_ACTIVE');
      if (c.status === 'CANCELLED') this.sales.invalid('This contract is already cancelled', 'CONTRACT_CLOSED');
      await this.event(tx, c, actor, 'CANCELLED', `Cancelled: ${reason.trim()}`);
      await tx.salesContract.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason.trim(), cancelledAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.cancelled', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number), reason: reason.trim() } });
    });
    return this.get(org, id);
  }

  /** Extend the end date by whole periods, optionally raising (or lowering) every price by a percentage. */
  async renew(org: SalesOrg, actor: Actor, id: string, input: { months: number; upliftPercent?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status !== 'ACTIVE' && c.status !== 'PAUSED' && c.status !== 'ENDED') this.sales.invalid('Only an active, paused or ended contract can be renewed', 'CONTRACT_NOT_ACTIVE');
      if (!c.endDate) this.sales.invalid('A rolling contract has no end date to renew', 'CONTRACT_RENEWAL');
      await this.renewInTx(tx, org, actor, c, input.months, input.upliftPercent ?? null, false);
    });
    await this.billDue(org, actor, id);
    return this.get(org, id);
  }

  private async renewInTx(tx: Tx, org: SalesOrg, actor: Actor | null, c: Full, months: number, uplift: string | null, automatic: boolean) {
    const start = fromDbDate(c.startDate);
    const oldEnd = fromDbDate(c.endDate!);
    const end = this.rule(() => renewedEnd(start, oldEnd, c.frequency as ContractFrequency, months));
    const data: Prisma.SalesContractUpdateInput = { endDate: toDbDate(end), endedAt: null, ...(c.status === 'ENDED' ? { status: 'ACTIVE' } : {}) };
    let note = '';
    if (uplift && !new D(uplift).eq(0)) {
      const lines = c.lines.map((l) => ({ accountId: l.accountId, description: l.description, quantity: l.quantity.toFixed(), unitPrice: this.rule(() => upliftPrice(l.unitPrice.toFixed(), uplift)), taxRateId: l.taxRateId, hsnCode: l.hsnCode }));
      const k = await this.sales.compute(tx, org, { contactId: c.contactId, date: addDays(oldEnd, 1), placeOfSupply: c.placeOfSupply, lines });
      await tx.salesContractLine.deleteMany({ where: { contractId: c.id, orgId: c.orgId } });
      Object.assign(data, { subtotal: k.subtotal, taxTotal: k.taxTotal, total: k.total, lines: { create: k.lines.map((l) => ({ ...l, orgId: c.orgId })) } });
      note = `; prices ${new D(uplift).gt(0) ? '+' : ''}${new D(uplift).toFixed()}% (per period ${this.sales.money(org, c.total)} → ${new D(k.total).toFixed(2)})`;
    }
    await tx.salesContract.update({ where: { id: c.id }, data });
    await this.event(tx, c, actor, 'RENEWED', `${automatic ? 'Renewed automatically' : 'Renewed'} for ${months} months: ends ${end} (was ${oldEnd})${note}`, { from: oldEnd, to: end, months, uplift });
    await this.audit.append(tx, { orgId: c.orgId, actorId: actor?.id ?? null, action: 'sales_contract.renewed', entityType: 'sales_contract', entityId: c.id, data: { reference: ref(c.number), from: oldEnd, to: end, months, uplift, automatic } });
  }

  /** Bill a billed period again after its invoice was voided or deleted. */
  async billAgain(org: SalesOrg, actor: Actor, id: string, periodNo: number) {
    const docId = await this.prisma.$transaction(async (tx) => {
      const c = await this.lock(tx, org.id, id);
      if (c.status === 'CANCELLED' || c.status === 'DRAFT') this.sales.invalid('This contract is not billing', 'CONTRACT_NOT_ACTIVE');
      const p = await tx.salesContractPeriod.findFirst({ where: { contractId: id, orgId: org.id, periodNo } });
      if (!p || p.status !== 'BILLED') this.sales.invalid('That period was not billed', 'CONTRACT_PERIOD');
      if (p.documentId) {
        const d = await tx.document.findFirst({ where: { id: p.documentId, orgId: org.id }, select: { status: true } });
        if (d && d.status !== 'VOID') this.sales.invalid('That period already has an invoice; void or delete it first', 'CONTRACT_PERIOD_BILLED');
      }
      const period = contractPeriod(fromDbDate(c.startDate), c.frequency as ContractFrequency, periodNo, c.timing);
      const doc = await this.invoice(tx, org, actor, c, period);
      await tx.salesContractPeriod.update({ where: { id: p.id }, data: { documentId: doc.id } });
      await this.event(tx, c, actor, 'BILLED', `Period ${period.start} to ${period.end} billed again`, { periodNo, documentId: doc.id });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.billed', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number), periods: [periodNo], documentIds: [doc.id], again: true } });
      return doc.id;
    });
    return { documentId: docId, contract: await this.get(org, id) };
  }

  private invoice(tx: Tx, org: SalesOrg, actor: Actor, c: Full, p: { start: string; end: string; billDate: string }) {
    const r = `${ref(c.number)} ${periodLabel(p)}`;
    return this.documents.createDraftInTx(tx, org, actor, 'SALES', {
      kind: 'INVOICE',
      contactId: c.contactId,
      issueDate: p.billDate,
      dueDate: c.paymentTermsDays !== null ? addDays(p.billDate, c.paymentTermsDays) : undefined,
      reference: (c.reference ? `${r} / ${c.reference}` : r).slice(0, 100),
      memo: c.title,
      placeOfSupply: c.placeOfSupply,
      lines: c.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity.toFixed(), unitPrice: l.unitPrice.toFixed(), taxRateId: l.taxRateId, hsnCode: l.hsnCode })),
    });
  }

  // ------------------------------------------------------------------ billing

  /**
   * Bill every period of one contract that has fallen due by `today`: one draft invoice each.
   * An auto-renewing contract past its end date is renewed first; one with nothing left to bill
   * past its end date ends. `actor` null: the runner (invoices are made in the creator's name).
   * A failure is kept on the contract (and in its history once per new message) and billing stops
   * there, so it is retried on the next pass.
   */
  async billDue(org: SalesOrg, actor: Actor | null, id: string, today = todayIst()): Promise<{ billed: number; error: string | null }> {
    try {
      const billed = await this.prisma.$transaction(async (tx) => {
        let c = await this.lock(tx, org.id, id);
        if (c.status !== 'ACTIVE') return 0;
        let s = this.schedule(c);
        if (s.end && today > s.end && fullyBilled(s)) {
          if (c.autoRenew && c.renewalMonths) {
            await this.renewInTx(tx, org, null, c, c.renewalMonths, null, true);
            c = await this.lock(tx, org.id, id);
            s = this.schedule(c);
          } else {
            await tx.salesContract.update({ where: { id }, data: { status: 'ENDED', endedAt: new Date(), lastError: null, lastErrorAt: null } });
            await this.event(tx, c, null, 'ENDED', `Ended on ${s.end}: every period is billed`);
            await this.audit.append(tx, { orgId: org.id, actorId: null, action: 'sales_contract.ended', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number), endDate: s.end } });
            return 0;
          }
        }
        const due = duePeriods(s, today);
        if (!due.length) {
          if (c.lastError) await tx.salesContract.update({ where: { id }, data: { lastError: null, lastErrorAt: null } });
          return 0;
        }
        const by = actor ?? { id: c.createdById };
        const docs: string[] = [];
        for (const p of due) {
          const doc = await this.invoice(tx, org, by, c, p);
          await tx.salesContractPeriod.create({ data: { orgId: org.id, contractId: id, periodNo: p.no, periodStart: toDbDate(p.start), periodEnd: toDbDate(p.end), status: 'BILLED', documentId: doc.id } });
          docs.push(doc.id);
        }
        await tx.salesContract.update({ where: { id }, data: { nextPeriodNo: c.nextPeriodNo + due.length, lastError: null, lastErrorAt: null } });
        const span = due.length === 1 ? `period ${due[0]!.start} to ${due[0]!.end}` : `${due.length} periods, ${due[0]!.start} to ${due[due.length - 1]!.end}`;
        await this.event(tx, c, actor, 'BILLED', `Billed ${span}: ${due.length === 1 ? 'a draft invoice' : `${due.length} draft invoices`}`, { periods: due.map((p) => p.no), documentIds: docs });
        await this.audit.append(tx, { orgId: org.id, actorId: actor?.id ?? null, action: 'sales_contract.billed', entityType: 'sales_contract', entityId: id, data: { reference: ref(c.number), periods: due.map((p) => p.no), documentIds: docs } });
        return due.length;
      });
      return { billed, error: null };
    } catch (e) {
      const issues = e instanceof DomainError ? (e.details as { issues?: string[] } | undefined)?.issues : undefined;
      const message = issues?.length ? `${e instanceof Error ? e.message : 'Invalid'}: ${issues.join('; ')}` : e instanceof Error ? e.message : String(e);
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.salesContract.findFirst({ where: { id, orgId: org.id } });
        if (!c || c.status === 'CANCELLED') return;
        await tx.salesContract.update({ where: { id }, data: { lastError: message.slice(0, 1000), lastErrorAt: new Date() } });
        if (c.lastError !== message.slice(0, 1000)) await this.event(tx, c, actor, 'BILLING_FAILED', `Could not bill: ${message}`);
      });
      this.logger.warn(`Contract ${id} could not be billed: ${message}`);
      return { billed: 0, error: message };
    }
  }

  /** Bill one contract now, as a member (the *Bill now* button). */
  async billNow(org: SalesOrg, actor: Actor, id: string) {
    const r = await this.billDue(org, actor, id);
    return { ...r, contract: await this.get(org, id) };
  }

  /** Bill every active contract of the organisation now. */
  async billOrg(org: SalesOrg, actor: Actor) {
    const ids = await this.prisma.salesContract.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, select: { id: true }, orderBy: { number: 'asc' } });
    let billed = 0;
    const errors: { id: string; error: string }[] = [];
    for (const { id } of ids) {
      const r = await this.billDue(org, actor, id);
      billed += r.billed;
      if (r.error) errors.push({ id, error: r.error });
    }
    return { contracts: ids.length, billed, errors };
  }

  /** The runner's pass over every organisation (or `orgIds`), as of `today`. */
  async runAll(today = todayIst(), orgIds?: string[]) {
    const rows = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.salesContract.findMany({
        where: { status: 'ACTIVE', ...(orgIds ? { orgId: { in: orgIds } } : {}) },
        select: { id: true, org: { select: { id: true, functionalCurrency: true } } },
        orderBy: [{ orgId: 'asc' }, { number: 'asc' }],
        take: 5000,
      }),
    );
    let billed = 0;
    let failed = 0;
    for (const r of rows) {
      const res = await tenantStorage.run({ bypass: true }, async () => await this.billDue({ id: r.org.id, role: 'OWNER', functionalCurrency: r.org.functionalCurrency }, null, r.id, today));
      billed += res.billed;
      if (res.error) failed++;
    }
    return { contracts: rows.length, billed, failed };
  }
}

