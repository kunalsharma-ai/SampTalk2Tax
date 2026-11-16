import { HttpStatus } from '@nestjs/common';
import { D, Dec, matchBill, purchaseOrderRef, type MatchMode, type MatchResult } from '@talk2tax/accounting-engine';
import { DomainError } from '../common/errors';
import { Tx } from '../common/prisma.service';

type Db = Pick<Tx, 'purchaseOrder' | 'purchaseOrderLine' | 'goodsReceiptLine' | 'documentLine' | 'document' | 'billMatchAcceptance'>;

const invalid = (message: string, code = 'BILL_ORDER_INVALID'): never => {
  throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
};

/**
 * Received (on goods receipts that are not cancelled) and billed (on bills that are not void,
 * drafts included) by order line. `excludeDocumentId` leaves one bill out of the billed figure.
 */
export async function lineProgress(db: Db, orgId: string, orderLineIds: string[], excludeDocumentId?: string) {
  const received = new Map<string, Dec>();
  const billed = new Map<string, Dec>();
  /** On posted bills only. */
  const posted = new Map<string, Dec>();
  if (!orderLineIds.length) return { received, billed, posted };
  const [rl, bl] = await Promise.all([
    db.goodsReceiptLine.findMany({ where: { orgId, orderLineId: { in: orderLineIds }, receipt: { status: 'RECORDED' } }, select: { orderLineId: true, quantity: true } }),
    db.documentLine.findMany({
      where: { orgId, purchaseOrderLineId: { in: orderLineIds }, document: { status: { not: 'VOID' }, ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}) } },
      select: { purchaseOrderLineId: true, quantity: true, document: { select: { status: true } } },
    }),
  ]);
  for (const r of rl) received.set(r.orderLineId, (received.get(r.orderLineId) ?? new D(0)).plus(r.quantity.toString()));
  for (const b of bl) {
    billed.set(b.purchaseOrderLineId!, (billed.get(b.purchaseOrderLineId!) ?? new D(0)).plus(b.quantity.toString()));
    if (b.document.status === 'POSTED') posted.set(b.purchaseOrderLineId!, (posted.get(b.purchaseOrderLineId!) ?? new D(0)).plus(b.quantity.toString()));
  }
  return { received, billed, posted };
}

/**
 * Billed by order line on the bills a bill is matched after: other posted bills, and for a posted
 * bill only those posted before it. Drafts do not count against each other: the first to post wins.
 */
async function billedBefore(db: Db, orgId: string, orderLineIds: string[], doc: { id: string; status: string; postedAt: Date | null }) {
  const out = new Map<string, Dec>();
  const rows = await db.documentLine.findMany({
    where: {
      orgId,
      purchaseOrderLineId: { in: orderLineIds },
      document: { id: { not: doc.id }, status: 'POSTED', ...(doc.status === 'POSTED' && doc.postedAt ? { postedAt: { lt: doc.postedAt } } : {}) },
    },
    select: { purchaseOrderLineId: true, quantity: true },
  });
  for (const r of rows) out.set(r.purchaseOrderLineId!, (out.get(r.purchaseOrderLineId!) ?? new D(0)).plus(r.quantity.toString()));
  return out;
}

/**
 * Checks a bill's link to a purchase order before it is saved: the order is issued, to the same
 * vendor, and every linked line is on it. Returns the order id to store (null when not linked).
 */
export async function checkBillOrder(
  db: Db,
  orgId: string,
  input: { kind: string; contactId: string; purchaseOrderId?: string | null; lines: { purchaseOrderLineId?: string | null }[] },
): Promise<string | null> {
  const linked = input.lines.filter((l) => l.purchaseOrderLineId).map((l) => l.purchaseOrderLineId!);
  if (!input.purchaseOrderId) {
    if (linked.length) invalid('Choose the purchase order these lines bill');
    return null;
  }
  if (input.kind !== 'BILL') invalid('Only a bill is matched to a purchase order');
  const o = await db.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, orgId }, select: { id: true, number: true, contactId: true, status: true } });
  if (!o) return invalid('Purchase order not found');
  if (o.contactId !== input.contactId) invalid(`${purchaseOrderRef(o.number)} is for another vendor`);
  if (o.status === 'DRAFT') invalid(`${purchaseOrderRef(o.number)} is still a draft; issue it first`);
  if (linked.length) {
    const lines = await db.purchaseOrderLine.findMany({ where: { orgId, id: { in: linked } }, select: { id: true, orderId: true } });
    if (lines.length !== new Set(linked).size || lines.some((l) => l.orderId !== o.id)) invalid(`A bill line is not on ${purchaseOrderRef(o.number)}`);
  }
  return o.id;
}

export interface BillMatch extends MatchResult {
  order: { id: string; reference: string; status: string; matchMode: MatchMode; priceTolerancePercent: string; quantityTolerancePercent: string };
  /** The acceptance that covers exactly these differences, if any. */
  accepted: { reason: string; acceptedById: string; acceptedAt: string } | null;
  acceptances: { reason: string; acceptedById: string; acceptedAt: string; fingerprint: string }[];
}

/** The match of a bill against its purchase order; null when the bill is not matched to one. */
export async function matchDocument(db: Db, orgId: string, documentId: string): Promise<BillMatch | null> {
  const doc = await db.document.findFirst({ where: { id: documentId, orgId }, select: { id: true, kind: true, status: true, postedAt: true, purchaseOrderId: true, lines: { orderBy: { lineNo: 'asc' }, select: { lineNo: true, description: true, quantity: true, unitPrice: true, purchaseOrderLineId: true } } } });
  if (!doc?.purchaseOrderId) return null;
  const o = await db.purchaseOrder.findFirstOrThrow({ where: { id: doc.purchaseOrderId, orgId }, include: { lines: true } });
  const { received } = await lineProgress(db, orgId, o.lines.map((l) => l.id), doc.id);
  const billed = await billedBefore(db, orgId, o.lines.map((l) => l.id), doc);
  const result = matchBill({
    mode: o.matchMode,
    priceTolerancePercent: o.priceTolerancePercent.toString(),
    quantityTolerancePercent: o.quantityTolerancePercent.toString(),
    orderOpen: o.status === 'ISSUED',
    lines: doc.lines.map((l) => {
      const ol = l.purchaseOrderLineId ? o.lines.find((x) => x.id === l.purchaseOrderLineId) : undefined;
      return {
        lineNo: l.lineNo,
        description: l.description,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        order: ol ? { lineNo: ol.lineNo, quantity: ol.quantity.toString(), unitPrice: ol.unitPrice.toString(), received: (received.get(ol.id) ?? new D(0)).toFixed(), billedElsewhere: (billed.get(ol.id) ?? new D(0)).toFixed() } : null,
      };
    }),
  });
  const acc = await db.billMatchAcceptance.findMany({ where: { orgId, documentId }, orderBy: { acceptedAt: 'desc' } });
  const out = acc.map((a) => ({ reason: a.reason, acceptedById: a.acceptedById, acceptedAt: a.acceptedAt.toISOString(), fingerprint: a.fingerprint }));
  const hit = result.status === 'EXCEPTION' ? out.find((a) => a.fingerprint === result.fingerprint) : undefined;
  return {
    ...result,
    order: { id: o.id, reference: purchaseOrderRef(o.number), status: o.status, matchMode: o.matchMode, priceTolerancePercent: o.priceTolerancePercent.toFixed(2), quantityTolerancePercent: o.quantityTolerancePercent.toFixed(2) },
    accepted: hit ? { reason: hit.reason, acceptedById: hit.acceptedById, acceptedAt: hit.acceptedAt } : null,
    acceptances: out,
  };
}

/** Refuses to post a bill whose differences from its order are not accepted. */
export async function assertBillMatches(db: Db, orgId: string, documentId: string) {
  const m = await matchDocument(db, orgId, documentId);
  if (!m || m.status === 'MATCHED' || m.accepted) return;
  throw new DomainError(
    'BILL_MATCH_EXCEPTION',
    `This bill does not match ${m.order.reference}: ${m.lines.flatMap((l) => l.exceptions.map((e) => e.message)).join('; ')}. Correct the bill, record the goods received, or accept the differences with a reason.`,
    HttpStatus.CONFLICT,
    { exceptions: m.lines.flatMap((l) => l.exceptions) },
  );
}
