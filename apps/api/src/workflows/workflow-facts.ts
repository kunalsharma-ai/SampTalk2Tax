import { alertRule, AlertRuleKey, D, Facts, minorUnits, WORKFLOW_TRIGGER_DEFS, WorkflowTrigger } from '@talk2tax/accounting-engine';
import { fromDbDate } from '../common/dates';
import { Tx } from '../common/prisma.service';

/** What a task or a run links back to. */
export type LinkType = 'DOCUMENT' | 'PAYMENT' | 'JOURNAL' | 'EXPENSE_CLAIM' | 'ALERT';

export interface EventFacts {
  trigger: WorkflowTrigger;
  facts: Facts;
  entityType: string;
  entityId: string;
  link: { type: LinkType; id: string; label: string };
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
      const d = await tx.document.findFirst({ where: { id: e.entityId, orgId }, include: { contact: { select: { name: true } } } });
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
        facts: { number: d.number, contactName: d.contact.name, total: money(d.total), issueDate: fromDbDate(d.issueDate), dueDate: fromDbDate(d.dueDate), reference: d.reference },
      };
    }
    case 'payment.recorded': {
      const p = await tx.payment.findFirst({ where: { id: e.entityId, orgId }, include: { contact: { select: { name: true } } } });
      if (!p) return null;
      return {
        trigger: p.kind === 'RECEIPT' ? 'RECEIPT_RECORDED' : 'VENDOR_PAYMENT_RECORDED',
        entityType: 'payment',
        entityId: p.id,
        link: { type: 'PAYMENT', id: p.id, label: `${KIND_LABEL[p.kind]} ${p.number}` },
        facts: { number: p.number, contactName: p.contact.name, amount: money(p.amount), date: fromDbDate(p.date), reference: p.reference },
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
