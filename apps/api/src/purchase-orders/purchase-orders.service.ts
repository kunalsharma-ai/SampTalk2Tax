import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  Dec,
  goodsReceiptRef,
  minorUnits,
  PurchaseOrderError,
  purchaseOrderAllows,
  purchaseOrderRef,
  purchaseOrderState,
  quantityToBill,
  quantityToReceive,
  receiptIssues,
  toleranceIssues,
  type MatchMode,
  type PurchaseOrderAction,
  type PurchaseOrderState,
} from '@talk2tax/accounting-engine';
import { GoodsReceipt, GoodsReceiptLine, PurchaseOrder, PurchaseOrderLine } from '@talk2tax/database';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { LineInput, SalesOrg, SalesOrdersService } from '../sales-orders/sales-orders.service';
import { todayIst } from '../tasks/tasks.service';
import { lineProgress, matchDocument } from './matching';
import { lockRow } from '../db/locks';

type Actor = { id: string };
type WithLines = PurchaseOrder & { lines: PurchaseOrderLine[] };

export interface PurchaseOrderInput {
  contactId: string;
  orderDate: string;
  expectedDate?: string | null;
  placeOfSupply?: string | null;
  reference?: string | null;
  terms?: string | null;
  memo?: string | null;
  matchMode?: MatchMode;
  priceTolerancePercent?: string;
  quantityTolerancePercent?: string;
  lines: LineInput[];
}

export interface ReceiptInput {
  receiptDate: string;
  reference?: string | null;
  memo?: string | null;
  lines: { orderLineId: string; quantity: string; rejected?: string | null; note?: string | null }[];
}

export type OrderView = 'open' | 'to_receive' | 'to_bill' | 'done' | 'all';

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

/**
 * Purchase orders and goods receipts (AP-015, AP-016), and the matching of bills against them
 * (AP-017, see matching.ts). Lines and totals are worked out by the bill rules (tax rates, India
 * GST place of supply), so a bill made from an order has the same figures. Issuing fixes an order
 * (a database trigger keeps it so); goods receipts are never edited, only cancelled.
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesOrdersService,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  private invalid(message: string, code = 'PURCHASE_ORDER_INVALID', details?: unknown): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  private allow(state: PurchaseOrderState, action: PurchaseOrderAction) {
    try {
      purchaseOrderAllows(state, action);
    } catch (e) {
      if (e instanceof PurchaseOrderError) throw new DomainError(e.code, e.message, HttpStatus.CONFLICT);
      throw e;
    }
  }

  private can(org: SalesOrg) {
    return { manage: hasPermission(org.role, 'purchases.manage'), acceptDifferences: hasPermission(org.role, 'approvals.decide') };
  }

  private async compute(tx: Tx, org: SalesOrg, input: PurchaseOrderInput) {
    const issues = toleranceIssues({ priceTolerancePercent: input.priceTolerancePercent ?? '0', quantityTolerancePercent: input.quantityTolerancePercent ?? '0' });
    if (input.expectedDate && input.expectedDate < input.orderDate) issues.push('The expected delivery date cannot be before the order date');
    if (issues.length) this.invalid(issues[0]!, 'PURCHASE_ORDER_INVALID', { issues });
    const { computed, gst } = await this.documents.computePurchase(tx, org, {
      contactId: input.contactId,
      issueDate: input.orderDate,
      placeOfSupply: input.placeOfSupply ?? null,
      lines: input.lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId ?? null, hsnCode: l.hsnCode ?? null })),
    });
    return {
      placeOfSupply: gst?.placeOfSupply ?? null,
      subtotal: computed.subtotal.toFixed(),
      taxTotal: computed.taxTotal.toFixed(),
      total: computed.total.toFixed(),
      lines: computed.lines.map((l) => ({
        lineNo: l.lineNo,
        description: l.description ?? null,
        accountId: l.accountId,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        taxRateId: l.taxRateId,
        hsnCode: l.hsnCode,
        netAmount: l.netAmount.toFixed(),
        taxAmount: l.taxAmount.toFixed(),
      })),
    };
  }

  private fields(input: PurchaseOrderInput, c: Awaited<ReturnType<PurchaseOrdersService['compute']>>) {
    return {
      contactId: input.contactId,
      orderDate: toDbDate(input.orderDate),
      expectedDate: input.expectedDate ? toDbDate(input.expectedDate) : null,
      placeOfSupply: c.placeOfSupply,
      reference: clean(input.reference),
      terms: clean(input.terms),
      memo: clean(input.memo),
      matchMode: input.matchMode ?? 'THREE_WAY',
      priceTolerancePercent: new D(input.priceTolerancePercent ?? '0').toFixed(2),
      quantityTolerancePercent: new D(input.quantityTolerancePercent ?? '0').toFixed(2),
      subtotal: c.subtotal,
      taxTotal: c.taxTotal,
      total: c.total,
    };
  }

  // ------------------------------------------------------------------ reads

  private async progressOf(orders: WithLines[]) {
    if (!orders.length) return { received: new Map<string, Dec>(), billed: new Map<string, Dec>(), posted: new Map<string, Dec>() };
    return lineProgress(this.prisma, orders[0]!.orgId, orders.flatMap((o) => o.lines.map((l) => l.id)));
  }

  private out(org: SalesOrg, o: WithLines, n: Awaited<ReturnType<SalesOrdersService['names']>>, p: Awaited<ReturnType<PurchaseOrdersService['progressOf']>>, today: string) {
    const scale = minorUnits(o.currency);
    const lines = o.lines
      .sort((a, b) => a.lineNo - b.lineNo)
      .map((l) => {
        const prog = { quantity: l.quantity.toString(), received: (p.received.get(l.id) ?? new D(0)).toFixed(), billed: (p.billed.get(l.id) ?? new D(0)).toFixed() };
        return {
          ...this.sales.lineOut(org, l, n),
          id: l.id,
          received: prog.received,
          /** On posted bills; drafts still count in toBill so the same quantity is not drafted twice. */
          billed: (p.posted.get(l.id) ?? new D(0)).toFixed(),
          inDraftBills: new D(prog.billed).minus(p.posted.get(l.id) ?? new D(0)).toFixed(),
          toReceive: quantityToReceive(prog),
          toBill: quantityToBill(o.matchMode, prog),
          progress: prog,
        };
      });
    // The status follows posted bills; drafts only reserve what is left to bill.
    const state = purchaseOrderState(o.status, o.matchMode, lines.map((l) => ({ ...l.progress, billed: l.billed })));
    const live = state !== 'DRAFT' && state !== 'CLOSED' && state !== 'CANCELLED';
    // Value still to bill at the order's prices, in proportion to the quantity left.
    const valueOf = (key: 'toBill' | 'toReceive') =>
      o.lines.reduce((t, l, i) => t.plus(new D(l.netAmount.toString()).plus(l.taxAmount.toString()).times(lines[i]![key]).div(l.quantity.toString())), new D(0)).toDecimalPlaces(scale).toFixed(scale);
    return {
      id: o.id,
      reference: purchaseOrderRef(o.number),
      status: o.status,
      state,
      contact: n.contact(o.contactId),
      orderDate: fromDbDate(o.orderDate),
      expectedDate: o.expectedDate ? fromDbDate(o.expectedDate) : null,
      late: live && !!o.expectedDate && fromDbDate(o.expectedDate) < today && lines.some((l) => new D(l.toReceive).gt(0)) && o.matchMode === 'THREE_WAY',
      placeOfSupply: o.placeOfSupply,
      vendorReference: o.reference,
      terms: o.terms,
      memo: o.memo,
      currency: o.currency,
      subtotal: this.sales.money(org, o.subtotal),
      taxTotal: this.sales.money(org, o.taxTotal),
      total: this.sales.money(org, o.total),
      matchMode: o.matchMode,
      priceTolerancePercent: o.priceTolerancePercent.toFixed(2),
      quantityTolerancePercent: o.quantityTolerancePercent.toFixed(2),
      toBill: live ? valueOf('toBill') : new D(0).toFixed(scale),
      toReceive: live && o.matchMode === 'THREE_WAY' ? valueOf('toReceive') : new D(0).toFixed(scale),
      issuedAt: o.issuedAt?.toISOString() ?? null,
      closedAt: o.closedAt?.toISOString() ?? null,
      closeReason: o.closeReason,
      cancelledAt: o.cancelledAt?.toISOString() ?? null,
      cancelReason: o.cancelReason,
      createdAt: o.createdAt.toISOString(),
      lines: lines.map(({ progress: _p, ...l }) => l),
    };
  }

  async list(org: SalesOrg, f: { view?: OrderView; contactId?: string }) {
    const today = todayIst();
    const orders = (await this.prisma.purchaseOrder.findMany({
      where: { orgId: org.id, ...(f.contactId ? { contactId: f.contactId } : {}) },
      include: { lines: true },
      orderBy: { number: 'desc' },
      take: 500,
    })) as WithLines[];
    const [p, n] = await Promise.all([this.progressOf(orders), this.sales.names(org.id, orders.map((o) => ({ contactId: o.contactId, dealId: null })), orders.flatMap((o) => o.lines))]);
    const all = orders.map((o) => this.out(org, o, n, p, today));
    const open = (s: PurchaseOrderState) => s === 'DRAFT' || s === 'ISSUED' || s === 'PARTLY_RECEIVED' || s === 'RECEIVED';
    const view = f.view ?? 'open';
    const shown = all.filter((o) =>
      view === 'all' ? true : view === 'open' ? open(o.state) : view === 'to_receive' ? new D(o.toReceive).gt(0) : view === 'to_bill' ? new D(o.toBill).gt(0) : !open(o.state),
    );
    const scale = minorUnits(org.functionalCurrency);
    const sum = (k: 'toBill' | 'toReceive') => all.reduce((t, o) => t.plus(o[k]), new D(0)).toFixed(scale);
    return {
      orders: shown.map(({ lines: _l, ...o }) => o),
      totals: {
        open: all.filter((o) => open(o.state) && o.state !== 'DRAFT').length,
        drafts: all.filter((o) => o.state === 'DRAFT').length,
        late: all.filter((o) => o.late).length,
        toReceive: sum('toReceive'),
        toBill: sum('toBill'),
      },
      can: this.can(org),
    };
  }

  async get(org: SalesOrg, id: string) {
    const o = (await this.prisma.purchaseOrder.findFirst({ where: { id, orgId: org.id }, include: { lines: true } })) as WithLines | null;
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Purchase order not found' });
    const [p, n, receipts, bills] = await Promise.all([
      this.progressOf([o]),
      this.sales.names(org.id, [{ contactId: o.contactId, dealId: null }], o.lines),
      this.prisma.goodsReceipt.findMany({ where: { orgId: org.id, orderId: id }, include: { lines: true }, orderBy: { number: 'desc' } }),
      this.prisma.document.findMany({ where: { orgId: org.id, purchaseOrderId: id }, select: { id: true, number: true, status: true, issueDate: true, total: true, reference: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    const users = await this.userNames([...receipts.map((r) => r.createdById)]);
    const lineNo = new Map(o.lines.map((l) => [l.id, l.lineNo]));
    const matches = await Promise.all(bills.map((b) => (b.status === 'VOID' ? null : matchDocument(this.prisma, org.id, b.id))));
    return {
      ...this.out(org, o, n, p, todayIst()),
      receipts: receipts.map((r) => this.receiptOut(r, lineNo, users)),
      bills: bills.map((b, i) => ({
        id: b.id,
        number: b.number,
        status: b.status,
        issueDate: fromDbDate(b.issueDate),
        vendorInvoice: b.reference,
        total: this.sales.money(org, b.total),
        match: matches[i] ? (matches[i]!.status === 'MATCHED' ? 'MATCHED' : matches[i]!.accepted ? 'ACCEPTED' : 'EXCEPTION') : null,
      })),
      can: this.can(org),
    };
  }

  private async userNames(ids: string[]) {
    const list = [...new Set(ids)];
    const rows = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(rows.map((u) => [u.id, u.name || u.email]));
  }

  private receiptOut(r: GoodsReceipt & { lines: GoodsReceiptLine[] }, lineNo: Map<string, number>, users: Map<string, string>) {
    return {
      id: r.id,
      reference: goodsReceiptRef(r.number),
      receiptDate: fromDbDate(r.receiptDate),
      deliveryNote: r.reference,
      memo: r.memo,
      status: r.status,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      recordedBy: users.get(r.createdById) ?? null,
      createdAt: r.createdAt.toISOString(),
      lines: r.lines
        .map((l) => ({ orderLineId: l.orderLineId, lineNo: lineNo.get(l.orderLineId) ?? 0, quantity: new D(l.quantity.toString()).toFixed(), rejected: new D(l.rejected.toString()).toFixed(), note: l.note }))
        .sort((a, b) => a.lineNo - b.lineNo),
    };
  }

  // ------------------------------------------------------------------ orders

  private async lock(tx: Tx, orgId: string, id: string) {
    await lockRow(tx, 'purchase_orders', id, orgId);
    const o = (await tx.purchaseOrder.findFirst({ where: { id, orgId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })) as WithLines | null;
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Purchase order not found' });
    const p = await lineProgress(tx, orgId, o.lines.map((l) => l.id));
    const lines = o.lines.map((l) => ({ id: l.id, lineNo: l.lineNo, quantity: l.quantity.toString(), received: (p.received.get(l.id) ?? new D(0)).toFixed(), billed: (p.billed.get(l.id) ?? new D(0)).toFixed(), line: l }));
    return { o, lines, state: purchaseOrderState(o.status, o.matchMode, lines.map((l) => ({ ...l, billed: (p.posted.get(l.id) ?? new D(0)).toFixed() }))) };
  }

  async create(org: SalesOrg, actor: Actor, input: PurchaseOrderInput) {
    const id = await this.prisma.$transaction(async (tx) => {
      const c = await this.compute(tx, org, input);
      const number = await this.sales.nextNumber(tx, org.id, 'purchase_order');
      const o = await tx.purchaseOrder.create({ data: { orgId: org.id, number, currency: org.functionalCurrency, createdById: actor.id, ...this.fields(input, c), lines: { create: c.lines } } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.created', entityType: 'purchase_order', entityId: o.id, data: { reference: purchaseOrderRef(number), contactId: input.contactId, total: c.total } });
      return o.id;
    });
    return this.get(org, id);
  }

  async update(org: SalesOrg, actor: Actor, id: string, input: PurchaseOrderInput) {
    await this.prisma.$transaction(async (tx) => {
      const { o, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'EDIT');
      const c = await this.compute(tx, org, input);
      await tx.purchaseOrderLine.deleteMany({ where: { orgId: org.id, orderId: id } });
      await tx.purchaseOrder.update({ where: { id }, data: { ...this.fields(input, c), lines: { create: c.lines } } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.updated', entityType: 'purchase_order', entityId: id, data: { reference: purchaseOrderRef(o.number), total: c.total } });
    });
    return this.get(org, id);
  }

  async remove(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { o, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'DELETE');
      await tx.purchaseOrder.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.deleted', entityType: 'purchase_order', entityId: id, data: { reference: purchaseOrderRef(o.number) } });
    });
  }

  /** Sent to the vendor: the order is fixed from now on. */
  async issue(org: SalesOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const { o, state } = await this.lock(tx, org.id, id);
      this.allow(state, 'ISSUE');
      const vendor = await tx.contact.findFirst({ where: { id: o.contactId, orgId: org.id }, select: { isActive: true, name: true } });
      if (!vendor?.isActive) this.invalid(`${vendor?.name ?? 'The vendor'} is inactive`, 'CONTACT_INACTIVE');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'ISSUED', issuedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.issued', entityType: 'purchase_order', entityId: id, data: { reference: purchaseOrderRef(o.number), total: o.total.toFixed() } });
    });
    return this.get(org, id);
  }

  /** Nothing more is expected on this order (short-closed); what was received and billed stays. */
  async close(org: SalesOrg, actor: Actor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const { o, state, lines } = await this.lock(tx, org.id, id);
      this.allow(state, 'CLOSE');
      const drafts = await tx.document.count({ where: { orgId: org.id, purchaseOrderId: id, status: 'DRAFT' } });
      if (drafts) this.invalid('A draft bill for this order is waiting; post or delete it first', 'PURCHASE_ORDER_DRAFT_BILL');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closeReason: reason.trim() } });
      await this.audit.append(tx, {
        orgId: org.id, actorId: actor.id, action: 'purchase_order.closed', entityType: 'purchase_order', entityId: id,
        data: { reference: purchaseOrderRef(o.number), reason: reason.trim(), lines: lines.map((l) => ({ lineNo: l.lineNo, ordered: l.quantity, received: l.received, billed: l.billed })) },
      });
    });
    return this.get(org, id);
  }

  async cancel(org: SalesOrg, actor: Actor, id: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const { o, state, lines } = await this.lock(tx, org.id, id);
      this.allow(state, 'CANCEL');
      if (lines.some((l) => new D(l.received).gt(0))) this.invalid('Goods are received against this order; close it instead of cancelling', 'PURCHASE_ORDER_RECEIVED');
      const bills = await tx.document.count({ where: { orgId: org.id, purchaseOrderId: id, status: { not: 'VOID' } } });
      if (bills) this.invalid('A bill is matched to this order; void or delete it first, or close the order instead', 'PURCHASE_ORDER_BILLED');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.cancelled', entityType: 'purchase_order', entityId: id, data: { reference: purchaseOrderRef(o.number), reason: reason.trim() } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ goods receipts

  async receive(org: SalesOrg, actor: Actor, id: string, input: ReceiptInput) {
    const receiptId = await this.prisma.$transaction(async (tx) => {
      const { o, state, lines } = await this.lock(tx, org.id, id);
      this.allow(state, 'RECEIVE');
      if (input.receiptDate < fromDbDate(o.orderDate)) this.invalid('Goods cannot be received before the order date', 'RECEIPT_DATE');
      if (input.receiptDate > todayIst()) this.invalid('A goods receipt cannot be dated in the future', 'RECEIPT_DATE');
      const request = input.lines.filter((l) => new D(l.quantity || '0').gt(0) || new D(l.rejected || '0').gt(0));
      const issues = receiptIssues(lines, request, o.quantityTolerancePercent.toString());
      if (issues.length) this.invalid(issues[0]!, 'RECEIPT_INVALID', { issues });
      const number = await this.sales.nextNumber(tx, org.id, 'goods_receipt');
      const r = await tx.goodsReceipt.create({
        data: {
          orgId: org.id, number, orderId: id, receiptDate: toDbDate(input.receiptDate), reference: clean(input.reference), memo: clean(input.memo), createdById: actor.id,
          lines: { create: request.map((l) => ({ orderLineId: l.orderLineId, quantity: new D(l.quantity || '0').toFixed(), rejected: new D(l.rejected || '0').toFixed(), note: clean(l.note) })) },
        },
      });
      await this.audit.append(tx, {
        orgId: org.id, actorId: actor.id, action: 'goods_receipt.recorded', entityType: 'goods_receipt', entityId: r.id,
        data: { reference: goodsReceiptRef(number), order: purchaseOrderRef(o.number), lines: request.map((l) => ({ lineNo: lines.find((x) => x.id === l.orderLineId)!.lineNo, quantity: l.quantity, rejected: l.rejected ?? '0' })) },
      });
      return r.id;
    });
    return { receiptId, order: await this.get(org, id) };
  }

  /** A receipt entered by mistake. Refused when bills already rely on the quantity (three-way). */
  async cancelReceipt(org: SalesOrg, actor: Actor, id: string, receiptId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      const { o, lines } = await this.lock(tx, org.id, id);
      const r = await tx.goodsReceipt.findFirst({ where: { id: receiptId, orgId: org.id, orderId: id }, include: { lines: true } });
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Goods receipt not found' });
      if (r.status === 'CANCELLED') this.invalid('This goods receipt is already cancelled', 'RECEIPT_CANCELLED');
      if (o.status === 'CLOSED' || o.status === 'CANCELLED') this.invalid('The order is closed; its receipts stay as they are', 'PURCHASE_ORDER_STATE');
      if (o.matchMode === 'THREE_WAY') {
        for (const rl of r.lines) {
          const l = lines.find((x) => x.id === rl.orderLineId)!;
          const after = new D(l.received).minus(rl.quantity.toString());
          if (new D(l.billed).gt(after)) this.invalid(`Line ${l.lineNo}: ${l.billed} is billed against what was received; void or change those bills first`, 'RECEIPT_BILLED');
        }
      }
      await tx.goodsReceipt.update({ where: { id: receiptId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'goods_receipt.cancelled', entityType: 'goods_receipt', entityId: receiptId, data: { reference: goodsReceiptRef(r.number), order: purchaseOrderRef(o.number), reason: reason.trim() } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ bills

  /**
   * A draft bill for what is left to bill: what was received (three-way) or ordered (two-way),
   * less what other bills already bill, at the order's prices and tax rates. It is then checked
   * against the vendor's invoice, matched and posted like any bill.
   */
  async bill(org: SalesOrg, actor: Actor, id: string, input: { issueDate: string; dueDate?: string | null; reference?: string | null }) {
    const docId = await this.prisma.$transaction(async (tx) => {
      const { o, state, lines } = await this.lock(tx, org.id, id);
      this.allow(state, 'BILL');
      if (input.issueDate < fromDbDate(o.orderDate)) this.invalid('The bill cannot be dated before the order', 'ORDER_DATE');
      const chosen = lines.map((l) => ({ l, q: quantityToBill(o.matchMode, l) })).filter((x) => new D(x.q).gt(0));
      if (!chosen.length) this.invalid(o.matchMode === 'THREE_WAY' ? 'Nothing received on this order is left to bill; record the goods received first' : 'Everything on this order is billed', 'NOTHING_TO_BILL');
      const doc = await this.documents.createDraftInTx(tx, org, actor, 'PURCHASES', {
        kind: 'BILL',
        contactId: o.contactId,
        issueDate: input.issueDate,
        dueDate: input.dueDate ?? undefined,
        reference: clean(input.reference),
        memo: o.memo ? `${purchaseOrderRef(o.number)} · ${o.memo}` : purchaseOrderRef(o.number),
        placeOfSupply: o.placeOfSupply,
        purchaseOrderId: o.id,
        lines: chosen.map(({ l, q }) => ({ accountId: l.line.accountId, description: l.line.description ?? undefined, quantity: q, unitPrice: l.line.unitPrice.toFixed(), taxRateId: l.line.taxRateId, hsnCode: l.line.hsnCode, purchaseOrderLineId: l.id })),
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'purchase_order.billed', entityType: 'purchase_order', entityId: o.id, data: { reference: purchaseOrderRef(o.number), documentId: doc.id, lines: chosen.map(({ l, q }) => ({ lineNo: l.lineNo, quantity: q })) } });
      return doc.id;
    });
    return { documentId: docId, order: await this.get(org, id) };
  }

  /** How a bill matches its purchase order, with who accepted any differences. */
  async match(org: SalesOrg, documentId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id, kind: { in: ['BILL', 'VENDOR_CREDIT'] } }, select: { id: true, status: true, createdById: true } });
    if (!doc) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
    const m = await matchDocument(this.prisma, org.id, documentId);
    if (!m) return { match: null, can: this.can(org) };
    const users = await this.userNames(m.acceptances.map((a) => a.acceptedById));
    const named = <T extends { acceptedById: string }>(a: T) => ({ ...a, acceptedBy: users.get(a.acceptedById) ?? null });
    return {
      match: { ...m, accepted: m.accepted ? named(m.accepted) : null, acceptances: m.acceptances.map(({ fingerprint: _f, ...a }) => named(a)) },
      documentStatus: doc.status,
      can: { ...this.can(org), acceptDifferences: this.can(org).acceptDifferences && doc.status === 'DRAFT' },
    };
  }

  /**
   * Accept a draft bill's differences from its order, with a reason. The acceptance covers exactly
   * the differences shown; if the bill or the receipts change and the differences with them, it no
   * longer applies.
   */
  async acceptDifferences(org: SalesOrg, actor: Actor, documentId: string, reason: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'documents', documentId, org.id);
      const doc = await tx.document.findFirst({ where: { id: documentId, orgId: org.id, kind: 'BILL' }, select: { id: true, status: true } });
      if (!doc) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
      if (doc.status !== 'DRAFT') this.invalid('Only a draft bill’s differences can be accepted', 'BILL_NOT_DRAFT');
      const m = await matchDocument(tx, org.id, documentId);
      if (!m) this.invalid('This bill is not matched to a purchase order', 'BILL_NOT_MATCHED');
      if (m.status === 'MATCHED') this.invalid('This bill matches its order; there is nothing to accept', 'BILL_MATCHES');
      if (m.accepted) this.invalid('These differences are already accepted', 'BILL_ACCEPTED');
      await tx.billMatchAcceptance.create({ data: { orgId: org.id, documentId, fingerprint: m.fingerprint, reason: reason.trim(), acceptedById: actor.id } });
      await this.audit.append(tx, {
        orgId: org.id, actorId: actor.id, action: 'bill.match_differences_accepted', entityType: 'document', entityId: documentId,
        data: { order: m.order.reference, reason: reason.trim(), exceptions: m.lines.flatMap((l) => l.exceptions.map((e) => e.message)) },
      });
    });
    return this.match(org, documentId);
  }
}
