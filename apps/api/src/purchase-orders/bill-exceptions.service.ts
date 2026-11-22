import { Injectable } from '@nestjs/common';
import { addDays, D, EXCEPTION_ACTIONS, investigateBillExceptions, minorUnits, purchaseOrderRef, type ExceptionAction, type RelatedBill } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { contacts, documents } from '../db/collections/sales';
import { lineProgress, matchDocument } from './matching';

/** How far back a vendor's other bills are compared. */
const RELATED_DAYS = 365;

/**
 * Automated exception investigation (AP-035): draft bills held because they do not match their
 * purchase order, each with the likely cause of every difference, the next step and the amount at
 * stake. Read-only; differences are still settled by correcting the bill, recording the goods
 * received or accepting them on the bill (AP-017).
 */
@Injectable()
export class BillExceptionsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async list(org: OrgContext) {
    const today = todayIso();
    const scale = minorUnits(org.functionalCurrency);
    const drafts = await this.store.collection(documents).find({ kind: 'BILL', status: 'DRAFT', purchaseOrderId: { $ne: null } }, { sort: { issueDate: 1 } });
    const matches = await Promise.all(drafts.map((d) => matchDocument(this.prisma, org.id, d.id)));
    const held = drafts.map((d, i) => ({ d, m: matches[i]! })).filter((x) => x.m && x.m.status === 'EXCEPTION' && !x.m.accepted);
    const orderIds = [...new Set(held.map((x) => x.d.purchaseOrderId!))];
    const vendorIds = [...new Set(held.map((x) => x.d.contactId))];
    const [orders, vendors, others] = await Promise.all([
      orderIds.length ? this.prisma.purchaseOrder.findMany({ where: { orgId: org.id, id: { in: orderIds } }, include: { lines: true } }) : [],
      this.store.collection(contacts).find({ id: { $in: vendorIds } }, { projection: { id: 1, name: 1 } }),
      vendorIds.length ? this.store.collection(documents).find({ kind: 'BILL', status: { $ne: 'VOID' }, contactId: { $in: vendorIds }, issueDate: { $gte: toDbDate(addDays(today, -RELATED_DAYS)) } }) : [],
    ]);
    const { received } = await lineProgress(this.prisma, org.id, orders.flatMap((o) => o.lines.map((l) => l.id)));
    const lineNo = new Map(orders.flatMap((o) => o.lines.map((l) => [l.id, l.lineNo] as const)));
    const vendorName = new Map(vendors.map((v) => [v.id, v.name]));

    const items = held.map(({ d, m }) => {
      const o = orders.find((x) => x.id === d.purchaseOrderId)!;
      const related: RelatedBill[] = others
        .filter((x) => x.contactId === d.contactId && x.id !== d.id)
        .map((x) => ({
          id: x.id,
          number: x.number ?? `draft bill ${x.reference ?? ''}`.trim(),
          reference: x.reference,
          issueDate: fromDbDate(x.issueDate),
          status: x.status,
          sameOrder: x.purchaseOrderId === d.purchaseOrderId,
          lines: x.lines.map((l) => ({ orderLineNo: x.purchaseOrderId === d.purchaseOrderId && l.purchaseOrderLineId ? (lineNo.get(l.purchaseOrderLineId) ?? null) : null, description: l.description, quantity: new D(l.quantity).toFixed(), unitPrice: new D(l.unitPrice).toFixed() })),
        }));
      const inv = investigateBillExceptions({
        bill: {
          id: d.id,
          number: d.number ?? 'Draft',
          reference: d.reference,
          issueDate: fromDbDate(d.issueDate),
          currency: d.currency,
          order: {
            reference: purchaseOrderRef(o.number),
            status: o.status,
            orderDate: fromDbDate(o.orderDate),
            lines: o.lines.sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), received: (received.get(l.id) ?? new D(0)).toFixed() })),
          },
          lines: m.lines.map((l) => ({ ...l, description: d.lines.find((x) => x.lineNo === l.lineNo)?.description ?? null })),
        },
        related,
        today,
        scale: minorUnits(d.currency),
      });
      return {
        id: d.id,
        /** Null for a draft, which has no number yet. */
        number: d.number,
        reference: d.reference,
        vendor: { id: d.contactId, name: vendorName.get(d.contactId) ?? '' },
        issueDate: fromDbDate(d.issueDate),
        currency: d.currency,
        total: new D(d.total).toFixed(minorUnits(d.currency)),
        order: { id: o.id, reference: purchaseOrderRef(o.number), status: o.status, matchMode: o.matchMode },
        ...inv,
        /** The amount at stake in the functional currency. */
        atStakeBase: new D(inv.atStake).times(new D(d.exchangeRate)).toFixed(scale),
        differences: m.lines.flatMap((l) => l.exceptions.map((e) => e.message)),
      };
    });
    const rank = (a: ExceptionAction) => EXCEPTION_ACTIONS.indexOf(a);
    items.sort((a, b) => rank(a.nextAction) - rank(b.nextAction) || new D(b.atStakeBase).comparedTo(new D(a.atStakeBase)) || a.issueDate.localeCompare(b.issueDate));
    const byAction = Object.fromEntries(EXCEPTION_ACTIONS.map((a) => [a, items.filter((i) => i.nextAction === a).length])) as Record<ExceptionAction, number>;
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: {
        bills: items.length,
        atStake: items.reduce((s, i) => s.plus(i.atStakeBase), new D(0)).toFixed(scale),
        acceptable: items.filter((i) => i.acceptable).length,
        withVendor: items.filter((i) => ['VOID_DUPLICATE', 'ASK_CREDIT_NOTE', 'ASK_CORRECTION'].includes(i.nextAction)).length,
        awaitingGoods: items.filter((i) => i.findings.some((f) => f.cause === 'AWAITING_DELIVERY')).length,
        oldestDays: items.reduce((x, i) => Math.max(x, i.daysHeld), 0), // not money: days
        byAction,
      },
      items,
      can: { acceptDifferences: hasPermission(org.role, 'approvals.decide'), manage: hasPermission(org.role, 'purchases.manage') },
    };
  }
}
