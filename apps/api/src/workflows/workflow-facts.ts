import { alertRule, AlertRuleKey, D, Dec, Facts, minorUnits, WEEKDAYS, WORKFLOW_TRIGGER_DEFS, WorkflowTrigger } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { fromDbDate, toDbDate } from '../common/dates';
import { Tx } from '../common/prisma.service';
import { disputedIds, openAsOf } from '../db/subledger-queries';

/** What a task or a run links back to. */
export type LinkType = 'DOCUMENT' | 'PAYMENT' | 'JOURNAL' | 'EXPENSE_CLAIM' | 'ALERT' | 'PERIOD_CLOSE';

export interface EventFacts {
  trigger: WorkflowTrigger;
  facts: Facts;
  /** What the run is about; null for a plain schedule. */
  entityType: string | null;
  entityId: string | null;
  link: { type: LinkType; id: string; label: string } | null;
}

export interface AuditEventRow {
  id: bigint;
  action: string;
  entityType: string;
  entityId: string | null;
  createdAt: Date;
}

/** Every audit action some trigger listens to. */
export const WATCHED_ACTIONS = [...new Set(WORKFLOW_TRIGGER_DEFS.flatMap((t) => t.auditActions))];

const KIND_LABEL: Record<string, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit', RECEIPT: 'Receipt', PAYMENT: 'Payment' };

/**
 * Reads the facts a trigger offers for one audit event, from the records as they are now.
 * Returns null when the event is not one any trigger acts on (a credit note posted, a
 * journal made by another module) or its record is gone.
 */
export async function loadEventFacts(tx: Tx, orgId: string, e: AuditEventRow): Promise<EventFacts | null> {
  if (!e.entityId) return null;
  const org = await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
  const scale = minorUnits(org.functionalCurrency);
  const money = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : new D(v.toString()).toFixed(scale));
  const userName = async (id: string | null) => (id ? ((await tx.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? null) : null);

  switch (e.action) {
    case 'document.posted':
    case 'document.voided': {
      const d = await tx.document.findFirst({ where: { id: e.entityId, orgId }, include: { contact: { select: { name: true, email: true } } } });
      if (!d) return null;
      const label = `${KIND_LABEL[d.kind]} ${d.number ?? ''}`.trim();
      const link = { type: 'DOCUMENT' as const, id: d.id, label };
      if (e.action === 'document.voided') {
        return { trigger: 'DOCUMENT_VOIDED', entityType: 'document', entityId: d.id, link, facts: { kind: d.kind, number: d.number, contactName: d.contact.name, total: money(d.total), reason: d.voidReason } };
      }
      if (d.kind !== 'INVOICE' && d.kind !== 'BILL') return null;
      return {
        trigger: d.kind === 'INVOICE' ? 'INVOICE_POSTED' : 'BILL_POSTED',
        entityType: 'document',
        entityId: d.id,
        link,
        facts: { number: d.number, contactName: d.contact.name, contactEmail: d.contact.email, total: money(d.total), issueDate: fromDbDate(d.issueDate), dueDate: fromDbDate(d.dueDate), reference: d.reference },
      };
    }
    case 'payment.recorded': {
      const p = await tx.payment.findFirst({ where: { id: e.entityId, orgId }, include: { contact: { select: { name: true, email: true } } } });
      if (!p) return null;
      return {
        trigger: p.kind === 'RECEIPT' ? 'RECEIPT_RECORDED' : 'VENDOR_PAYMENT_RECORDED',
        entityType: 'payment',
        entityId: p.id,
        link: { type: 'PAYMENT', id: p.id, label: `${KIND_LABEL[p.kind]} ${p.number}` },
        facts: { number: p.number, contactName: p.contact.name, contactEmail: p.contact.email, amount: money(p.amount), date: fromDbDate(p.date), reference: p.reference },
      };
    }
    case 'journal.posted':
    case 'journal.created_and_posted': {
      const j = await tx.journalEntry.findFirst({ where: { id: e.entityId, orgId } });
      if (!j || j.source !== 'MANUAL' || j.status !== 'POSTED') return null;
      const number = j.entryNumber === null ? null : `#${j.entryNumber}`;
      return {
        trigger: 'JOURNAL_POSTED',
        entityType: 'journal_entry',
        entityId: j.id,
        link: { type: 'JOURNAL', id: j.id, label: `Journal ${number ?? ''}`.trim() },
        facts: { number, date: fromDbDate(j.date), total: money(j.totalDebit), memo: j.memo, postedBy: await userName(j.postedById) },
      };
    }
    case 'expense_claim.submitted': {
      const c = await tx.expenseClaim.findFirst({ where: { id: e.entityId, orgId } });
      if (!c) return null;
      return {
        trigger: 'EXPENSE_CLAIM_SUBMITTED',
        entityType: 'expense_claim',
        entityId: c.id,
        link: { type: 'EXPENSE_CLAIM', id: c.id, label: `Expense claim ${c.number}` },
        facts: { number: c.number, claimant: await userName(c.claimantId), total: money(c.total), title: c.title },
      };
    }
    case 'alert.opened': {
      const a = await tx.alert.findFirst({ where: { id: e.entityId, orgId } });
      if (!a) return null;
      let check: string = a.rule;
      try {
        check = alertRule(a.rule as AlertRuleKey).name;
      } catch {
        /* a check that no longer exists keeps its key */
      }
      return { trigger: 'ALERT_OPENED', entityType: 'alert', entityId: a.id, link: { type: 'ALERT', id: a.id, label: a.title }, facts: { severity: a.severity, check, title: a.title, amount: money(a.amount) } };
    }
    default:
      return null;
  }
}

const scaleOf = async (tx: Tx, orgId: string) => minorUnits((await tx.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } })).functionalCurrency);

/** Posted invoices or bills of a kind with something still to pay as of an India date, and no open dispute. */
async function openUndisputed(tx: Tx, orgId: string, kind: 'INVOICE' | 'BILL', asOf: string, due?: { from: string; to: string }) {
  const docs = await tx.document.findMany({
    where: { orgId, kind, status: 'POSTED', ...(due ? { dueDate: { gte: toDbDate(due.from), lte: toDbDate(due.to) } } : {}) },
    select: { id: true, total: true, dueDate: true },
  });
  const disputed = await disputedIds(tx, orgId, docs.map((d) => d.id));
  return (await openAsOf(tx, orgId, docs.filter((d) => !disputed.has(d.id)), toDbDate(asOf))).filter((d) => d.open.gt(0));
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Posted invoices (INVOICE_OVERDUE) or bills (BILL_DUE_SOON) with something still to pay,
 * due between two dates, that this workflow has not acted on for these days yet.
 */
export async function dueDocuments(tx: Tx, orgId: string, p: { kind: 'INVOICE' | 'BILL'; from: string; to: string; asOf: string; workflowId: string; keyPrefix: string; keySuffix: string; limit: number }): Promise<string[]> {
  const open = await openUndisputed(tx, orgId, p.kind, p.asOf, p);
  const keys = open.map((d) => `${p.keyPrefix}${d.id}${p.keySuffix}`);
  const done = new Set(
    keys.length ? (await tx.workflowRun.findMany({ where: { orgId, workflowId: p.workflowId, status: { not: 'TEST' }, occurrenceKey: { in: keys } }, select: { occurrenceKey: true } })).map((r) => r.occurrenceKey) : [],
  );
  return open
    .filter((d) => !done.has(`${p.keyPrefix}${d.id}${p.keySuffix}`))
    .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || byId(a, b))
    .slice(0, p.limit)
    .map((d) => d.id);
}

/** A document for testing a date trigger: the most recently overdue open invoice, or the next open bill to fall due. */
export async function sampleDueDocument(tx: Tx, orgId: string, kind: 'INVOICE' | 'BILL', asOf: string): Promise<string | null> {
  const today = toDbDate(asOf).getTime();
  const open = await openUndisputed(tx, orgId, kind, asOf);
  // Invoices: overdue first, the most recently due first. Bills: not yet due first, the soonest first.
  const rank = (d: { dueDate: Date }) => (kind === 'INVOICE' ? (d.dueDate.getTime() < today ? 0 : 1) : d.dueDate.getTime() >= today ? 0 : 1);
  open.sort((a, b) => rank(a) - rank(b) || (kind === 'INVOICE' ? b.dueDate.getTime() - a.dueDate.getTime() : a.dueDate.getTime() - b.dueDate.getTime()) || byId(a, b));
  return open[0]?.id ?? null;
}

/** Facts of an invoice or bill for a date trigger, as of an India date. */
export async function loadDueDocumentFacts(tx: Tx, orgId: string, trigger: 'INVOICE_OVERDUE' | 'BILL_DUE_SOON', documentId: string, asOf: string): Promise<EventFacts | null> {
  const scale = await scaleOf(tx, orgId);
  const d = await tx.document.findFirst({ where: { id: documentId, orgId }, include: { contact: { select: { name: true, email: true } } } });
  if (!d) return null;
  const open = (await openAsOf(tx, orgId, [d], toDbDate(asOf))).map((x) => ({ balance: x.open }));
  const money = (v: { toString(): string }) => new D(v.toString()).toFixed(scale);
  return {
    trigger,
    entityType: 'document',
    entityId: d.id,
    link: { type: 'DOCUMENT', id: d.id, label: `${KIND_LABEL[d.kind]} ${d.number ?? ''}`.trim() },
    facts: {
      number: d.number,
      contactName: d.contact.name,
      contactEmail: d.contact.email,
      currency: d.currency,
      total: money(d.total),
      balance: money(open[0]?.balance ?? d.total),
      issueDate: fromDbDate(d.issueDate),
      dueDate: fromDbDate(d.dueDate),
      reference: d.reference,
    },
  };
}

/** Facts of a schedule: the date, and receivables and payables as of that India date. */
export async function loadScheduleFacts(tx: Tx, orgId: string, date: string): Promise<EventFacts> {
  const scale = await scaleOf(tx, orgId);
  const on = toDbDate(date);
  const docs = await tx.document.findMany({
    where: { orgId, kind: { in: ['INVOICE', 'BILL'] }, issueDate: { lte: on }, OR: [{ status: 'POSTED' }, { status: 'VOID', voidDate: { gt: on } }] },
    select: { id: true, kind: true, total: true, dueDate: true },
  });
  const rows: { kind: string; outstanding: Prisma.Decimal; overdue: Prisma.Decimal }[] = [];
  for (const x of await openAsOf(tx, orgId, docs, on)) {
    let r = rows.find((y) => y.kind === x.kind);
    if (!r) rows.push((r = { kind: x.kind, outstanding: new Prisma.Decimal(0), overdue: new Prisma.Decimal(0) }));
    r.outstanding = r.outstanding.plus(x.open);
    if (x.dueDate < on) r.overdue = r.overdue.plus(x.open);
  }
  const get = (kind: string, f: 'outstanding' | 'overdue'): string => {
    const r = rows.find((x) => x.kind === kind);
    return (r ? new D(r[f].toString()) : (new D(0) as Dec)).toFixed(scale);
  };
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return {
    trigger: 'SCHEDULE',
    entityType: null,
    entityId: null,
    link: null,
    facts: { date, weekday: WEEKDAYS[dow], overdueReceivables: get('INVOICE', 'overdue'), overduePayables: get('BILL', 'overdue'), receivablesOutstanding: get('INVOICE', 'outstanding'), payablesOutstanding: get('BILL', 'outstanding') },
  };
}
