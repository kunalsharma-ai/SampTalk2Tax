import { Injectable } from '@nestjs/common';
import { addDays, BEHAVIOUR_PROFILES, BEHAVIOUR_SIGNALS, customerBehaviour, D, minorUnits, type BehaviourInvoice } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { roundPg, withOpen } from '../db/subledger-queries';

const TONE_ORDER = { RISK: 0, WATCH: 1, GOOD: 2, INFO: 3 } as const;

/**
 * Customer financial behaviour analysis (AR-038): for every customer invoiced in the last two
 * years, how they pay (days late, its trend, spread, paying in parts, usual pay day) and buy
 * (the last 12 months against the 12 before, a stop in buying), with a profile and signals that
 * say what they were raised on. Read-only; amounts in the functional currency.
 */
@Injectable()
export class CustomerBehaviourService {
  constructor(private readonly prisma: PrismaService) {}

  async analyse(org: OrgContext, q: { contactId?: string } = {}, today = todayIso()) {
    const asOf = toDbDate(today);
    const s = minorUnits(org.functionalCurrency);
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'INVOICE', status: 'POSTED', issueDate: { lte: asOf }, ...(q.contactId ? { contactId: q.contactId } : {}) },
      select: { id: true, contactId: true, issueDate: true, dueDate: true, total: true, exchangeRate: true },
    });
    const rows = await withOpen(this.prisma, org.id, docs, asOf);
    const since = addDays(today, -730);
    const active = new Set(rows.filter((r) => fromDbDate(r.issueDate) > since).map((r) => r.contactId));
    const paidRecently = rows.filter((r) => active.has(r.contactId) && r.open.lte(0) && r.lastAllocated && fromDbDate(r.lastAllocated) > addDays(today, -365));
    const [allocs, receipts, contacts] = await Promise.all([
      paidRecently.length ? this.prisma.allocation.findMany({ where: { orgId: org.id, targetId: { in: paidRecently.map((r) => r.id) }, removedOn: null, date: { lte: asOf } }, select: { targetId: true } }) : [],
      active.size ? this.prisma.payment.findMany({ where: { orgId: org.id, kind: 'RECEIPT', status: 'POSTED', contactId: { in: [...active] }, date: { gt: toDbDate(addDays(today, -365)), lte: asOf } }, select: { contactId: true, date: true } }) : [],
      active.size ? this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...active] } }, select: { id: true, name: true } }) : [],
    ]);
    const payments = new Map<string, number>();
    for (const a of allocs) payments.set(a.targetId, (payments.get(a.targetId) ?? 0) + 1);
    const invoicesOf = new Map<string, BehaviourInvoice[]>();
    for (const r of rows) {
      if (!active.has(r.contactId)) continue;
      const list = invoicesOf.get(r.contactId) ?? [];
      list.push({ issueDate: fromDbDate(r.issueDate), dueDate: fromDbDate(r.dueDate), total: roundPg(r.total.times(r.exchangeRate), 2).toFixed(), paidOn: r.open.lte(0) && r.lastAllocated ? fromDbDate(r.lastAllocated) : null, payments: payments.get(r.id) ?? 0 });
      invoicesOf.set(r.contactId, list);
    }
    const receiptsOf = new Map<string, string[]>();
    for (const p of receipts) receiptsOf.set(p.contactId, [...(receiptsOf.get(p.contactId) ?? []), fromDbDate(p.date)]);

    const customers = contacts
      .map((c) => ({ contactId: c.id, name: c.name, ...customerBehaviour(invoicesOf.get(c.id) ?? [], receiptsOf.get(c.id) ?? [], today, s) }))
      .sort((a, b) => {
        const worst = (x: typeof a) => Math.min(4, ...x.signals.map((g) => TONE_ORDER[g.tone]));
        return worst(a) - worst(b) || new D(b.buying.last12.amount).cmp(a.buying.last12.amount) || a.name.localeCompare(b.name);
      });
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: {
        customers: customers.length,
        profiles: Object.fromEntries(BEHAVIOUR_PROFILES.map((p) => [p, customers.filter((c) => c.profile === p).length])),
        signals: Object.fromEntries(BEHAVIOUR_SIGNALS.map((g) => [g, customers.filter((c) => c.signals.some((x) => x.code === g)).length])),
      },
      customers,
    };
  }
}
