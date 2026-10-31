import { Injectable, NotFoundException } from '@nestjs/common';
import { AGEING_BUCKETS, AgeingBucket, D, Dec, Ledger, ageingBucket, minorUnits, paymentKindFor } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { PrismaService, Tx } from '../common/prisma.service';

export interface OrgRef {
  id: string;
  functionalCurrency: string;
}

type Db = PrismaService | Tx;

const KINDS: Record<Ledger, { charge: 'INVOICE' | 'BILL'; credit: 'CREDIT_NOTE' | 'VENDOR_CREDIT'; payment: 'RECEIPT' | 'PAYMENT' }> = {
  SALES: { charge: 'INVOICE', credit: 'CREDIT_NOTE', payment: 'RECEIPT' },
  PURCHASES: { charge: 'BILL', credit: 'VENDOR_CREDIT', payment: 'PAYMENT' },
};

export function ledgerKinds(ledger: Ledger) {
  return KINDS[ledger];
}

interface OpenItem {
  id: string;
  contactId: string;
  contactName: string;
  number: string;
  date: string;
  dueDate: string | null;
  total: Dec;
  open: Dec;
  type: 'charge' | 'credit' | 'payment';
}

/**
 * Receivables and payables sub-ledgers. Everything here is computed from posted
 * documents, payments and allocations; nothing is cached, so the numbers always
 * agree with the records behind them. The ageing report also reads the control
 * account from the general ledger and shows any difference.
 */
@Injectable()
export class SubledgerService {
  constructor(private readonly prisma: PrismaService) {}

  /** Open charges, unapplied credits and unapplied payments as of a date. */
  async openItems(db: Db, orgId: string, ledger: Ledger, asOf: string, contactId?: string): Promise<OpenItem[]> {
    const k = KINDS[ledger];
    const d = toDbDate(asOf);
    const contactFilter = contactId ? Prisma.sql`AND x.contact_id = ${contactId}::uuid` : Prisma.empty;
    const rows = await db.$queryRaw<
      { id: string; contact_id: string; contact_name: string; number: string; date: Date; due_date: Date | null; total: Prisma.Decimal; used: Prisma.Decimal; type: string }[]
    >`
      SELECT x.id, x.contact_id, c.name AS contact_name, x.number, x.issue_date AS date, x.due_date, x.total,
        COALESCE((SELECT SUM(a.amount) FROM allocations a
                  WHERE a.target_id = x.id AND a.date <= ${d}::date AND (a.removed_on IS NULL OR a.removed_on > ${d}::date)), 0) AS used,
        'charge' AS type
      FROM documents x JOIN contacts c ON c.id = x.contact_id
      WHERE x.org_id = ${orgId}::uuid AND x.kind = ${k.charge}::"DocumentKind" AND x.issue_date <= ${d}::date
        AND (x.status = 'POSTED' OR (x.status = 'VOID' AND x.void_date > ${d}::date)) ${contactFilter}
      UNION ALL
      SELECT x.id, x.contact_id, c.name, x.number, x.issue_date, NULL, x.total,
        COALESCE((SELECT SUM(a.amount) FROM allocations a
                  WHERE a.credit_document_id = x.id AND a.date <= ${d}::date AND (a.removed_on IS NULL OR a.removed_on > ${d}::date)), 0),
        'credit'
      FROM documents x JOIN contacts c ON c.id = x.contact_id
      WHERE x.org_id = ${orgId}::uuid AND x.kind = ${k.credit}::"DocumentKind" AND x.issue_date <= ${d}::date
        AND (x.status = 'POSTED' OR (x.status = 'VOID' AND x.void_date > ${d}::date)) ${contactFilter}
      UNION ALL
      SELECT x.id, x.contact_id, c.name, x.number, x.date, NULL, x.amount,
        COALESCE((SELECT SUM(a.amount) FROM allocations a
                  WHERE a.payment_id = x.id AND a.date <= ${d}::date AND (a.removed_on IS NULL OR a.removed_on > ${d}::date)), 0),
        'payment'
      FROM payments x JOIN contacts c ON c.id = x.contact_id
      WHERE x.org_id = ${orgId}::uuid AND x.kind = ${k.payment}::"PaymentKind" AND x.date <= ${d}::date
        AND (x.status = 'POSTED' OR x.void_date > ${d}::date) ${contactFilter}`;
    return rows
      .map((r) => ({
        id: r.id,
        contactId: r.contact_id,
        contactName: r.contact_name,
        number: r.number,
        date: fromDbDate(r.date),
        dueDate: r.due_date ? fromDbDate(r.due_date) : null,
        total: new D(r.total.toFixed()),
        open: new D(r.total.toFixed()).minus(r.used.toFixed()),
        type: r.type as OpenItem['type'],
      }))
      .filter((r) => !r.open.isZero());
  }

  /** Net balance per contact (open charges minus unapplied credits and payments). */
  async balances(db: Db, orgId: string, ledger: Ledger, asOf = todayIso(), contactId?: string) {
    const items = await this.openItems(db, orgId, ledger, asOf, contactId);
    const out = new Map<string, { outstanding: Dec; unapplied: Dec; overdue: Dec }>();
    for (const i of items) {
      const b = out.get(i.contactId) ?? { outstanding: new D(0), unapplied: new D(0), overdue: new D(0) };
      if (i.type === 'charge') {
        b.outstanding = b.outstanding.plus(i.open);
        if (i.dueDate && i.dueDate < asOf) b.overdue = b.overdue.plus(i.open);
      } else {
        b.unapplied = b.unapplied.plus(i.open);
      }
      out.set(i.contactId, b);
    }
    return out;
  }

  async ageing(org: OrgRef & { arAccountId: string | null; apAccountId: string | null }, ledger: Ledger, asOf: string) {
    const scale = minorUnits(org.functionalCurrency);
    const items = await this.openItems(this.prisma, org.id, ledger, asOf);
    const zero = () => Object.fromEntries([...AGEING_BUCKETS, 'unapplied', 'balance'].map((b) => [b, new D(0)])) as Record<AgeingBucket | 'unapplied' | 'balance', Dec>;
    const byContact = new Map<string, { contactId: string; contactName: string; amounts: ReturnType<typeof zero>; items: OpenItem[] }>();
    const totals = zero();
    for (const i of items) {
      const row = byContact.get(i.contactId) ?? { contactId: i.contactId, contactName: i.contactName, amounts: zero(), items: [] };
      if (i.type === 'charge') {
        const b = ageingBucket(i.dueDate!, asOf);
        row.amounts[b] = row.amounts[b].plus(i.open);
        totals[b] = totals[b].plus(i.open);
        row.amounts.balance = row.amounts.balance.plus(i.open);
        totals.balance = totals.balance.plus(i.open);
      } else {
        row.amounts.unapplied = row.amounts.unapplied.plus(i.open);
        totals.unapplied = totals.unapplied.plus(i.open);
        row.amounts.balance = row.amounts.balance.minus(i.open);
        totals.balance = totals.balance.minus(i.open);
      }
      row.items.push(i);
      byContact.set(i.contactId, row);
    }
    const controlAccountId = ledger === 'SALES' ? org.arAccountId : org.apAccountId;
    let control: Dec | null = null;
    if (controlAccountId) {
      const agg = await this.prisma.journalLine.aggregate({
        where: { orgId: org.id, accountId: controlAccountId, entry: { status: 'POSTED', date: { lte: toDbDate(asOf) } } },
        _sum: { functionalDebit: true, functionalCredit: true },
      });
      const dr = new D((agg._sum.functionalDebit ?? 0).toString());
      const cr = new D((agg._sum.functionalCredit ?? 0).toString());
      control = ledger === 'SALES' ? dr.minus(cr) : cr.minus(dr);
    }
    const f = (x: Dec) => x.toFixed(scale);
    const fmtAmounts = (a: ReturnType<typeof zero>) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, f(v)]));
    return {
      ledger,
      asOf,
      currency: org.functionalCurrency,
      buckets: AGEING_BUCKETS,
      rows: [...byContact.values()]
        .sort((a, b) => a.contactName.localeCompare(b.contactName))
        .map((r) => ({
          contactId: r.contactId,
          contactName: r.contactName,
          ...fmtAmounts(r.amounts),
          items: r.items
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((i) => ({
              id: i.id,
              type: i.type,
              number: i.number,
              date: i.date,
              dueDate: i.dueDate,
              daysOverdue: i.dueDate ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(i.dueDate)) / 86_400_000)) : null,
              bucket: i.type === 'charge' ? ageingBucket(i.dueDate!, asOf) : null,
              total: f(i.total),
              open: f(i.open),
            })),
        })),
      totals: fmtAmounts(totals),
      reconciliation: {
        controlAccountId,
        controlAccountBalance: control ? f(control) : null,
        subledgerBalance: f(totals.balance),
        difference: control ? f(control.minus(totals.balance)) : null,
      },
    };
  }

  /** Chronological statement for one contact with a running balance. */
  async statement(org: OrgRef, contactId: string, ledger: Ledger, from: string, to: string) {
    const scale = minorUnits(org.functionalCurrency);
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, orgId: org.id } });
    if (!contact) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
    const k = KINDS[ledger];
    const [docs, pays] = await Promise.all([
      this.prisma.document.findMany({ where: { orgId: org.id, contactId, kind: { in: [k.charge, k.credit] }, status: { in: ['POSTED', 'VOID'] } } }),
      this.prisma.payment.findMany({ where: { orgId: org.id, contactId, kind: paymentKindFor(ledger) } }),
    ]);
    type Ev = { date: string; seq: number; kind: string; id: string; number: string; description: string; amount: Dec };
    const events: Ev[] = [];
    for (const d of docs) {
      const sign = d.kind === k.charge ? 1 : -1;
      const total = new D(d.total.toFixed());
      const label = d.kind === 'INVOICE' ? 'Invoice' : d.kind === 'BILL' ? 'Bill' : d.kind === 'CREDIT_NOTE' ? 'Credit note' : 'Vendor credit';
      events.push({ date: fromDbDate(d.issueDate), seq: 1, kind: d.kind, id: d.id, number: d.number!, description: label + (d.reference ? ` · ${d.reference}` : ''), amount: total.times(sign) });
      if (d.status === 'VOID' && d.voidDate) {
        events.push({ date: fromDbDate(d.voidDate), seq: 3, kind: `${d.kind}_VOID`, id: d.id, number: d.number!, description: `${label} voided`, amount: total.times(-sign) });
      }
    }
    for (const p of pays) {
      const amt = new D(p.amount.toFixed());
      const label = p.kind === 'RECEIPT' ? 'Payment received' : 'Payment made';
      events.push({ date: fromDbDate(p.date), seq: 2, kind: p.kind, id: p.id, number: p.number, description: label + (p.reference ? ` · ${p.reference}` : ''), amount: amt.negated() });
      if (p.status === 'VOID' && p.voidDate) {
        events.push({ date: fromDbDate(p.voidDate), seq: 3, kind: `${p.kind}_VOID`, id: p.id, number: p.number, description: `${label} voided`, amount: amt });
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq || a.number.localeCompare(b.number));
    let opening = new D(0);
    let running = new D(0);
    const lines = [];
    for (const e of events) {
      if (e.date < from) {
        opening = opening.plus(e.amount);
        running = opening;
        continue;
      }
      if (e.date > to) break;
      running = running.plus(e.amount);
      lines.push({
        date: e.date,
        kind: e.kind,
        id: e.id,
        number: e.number,
        description: e.description,
        charge: e.amount.isPositive() ? e.amount.toFixed(scale) : null,
        credit: e.amount.isNegative() ? e.amount.negated().toFixed(scale) : null,
        balance: running.toFixed(scale),
      });
    }
    return {
      contact: { id: contact.id, name: contact.name },
      ledger,
      currency: org.functionalCurrency,
      from,
      to,
      openingBalance: opening.toFixed(scale),
      closingBalance: (lines.length ? running : opening).toFixed(scale),
      lines,
    };
  }
}
