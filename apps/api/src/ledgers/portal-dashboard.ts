import { minorUnits, portalDashboard, portalMonths } from '@talk2tax/accounting-engine';
import { fromDbDate, toDbDate } from '../common/dates';
import type { PrismaService } from '../common/prisma.service';
import type { OpenItem } from './subledger.service';

/**
 * The dashboard at the top of a customer's or vendor's portal (DASH-060/061), from the same open
 * items as their balances plus a year of their invoices or bills and payments. In the currency
 * the most is open in, else the organisation's own.
 */
export async function portalDashboardFor(prisma: PrismaService, input: { orgId: string; contactId: string; side: 'SALES' | 'PURCHASES'; today: string; functionalCurrency: string; items: OpenItem[] }) {
  const since = toDbDate(`${portalMonths(input.today)[0]}-01`);
  const kinds = input.side === 'SALES' ? { charge: 'INVOICE', credit: 'CREDIT_NOTE', payment: 'RECEIPT' } : { charge: 'BILL', credit: 'VENDOR_CREDIT', payment: 'PAYMENT' };
  const [docs, payments] = await Promise.all([
    prisma.document.findMany({ where: { orgId: input.orgId, contactId: input.contactId, kind: { in: [kinds.charge, kinds.credit] as never }, status: { in: ['POSTED', 'VOID'] }, issueDate: { gte: since } }, select: { kind: true, status: true, currency: true, issueDate: true, total: true } }),
    prisma.payment.findMany({ where: { orgId: input.orgId, contactId: input.contactId, kind: kinds.payment as never, date: { gte: since } }, select: { status: true, currency: true, date: true, amount: true } }),
  ]);
  const openBy = new Map<string, number>();
  for (const i of input.items) if (i.type === 'charge') openBy.set(i.currency, (openBy.get(i.currency) ?? 0) + Number(i.foreignOpen.toString())); // not money: only to pick a currency
  const currency = [...openBy.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? input.functionalCurrency;
  const scale = minorUnits(currency);
  return portalDashboard({
    currency,
    today: input.today,
    scale,
    items: input.items.map((i) => ({ type: i.type === 'charge' ? 'charge' : 'credit', currency: i.currency, open: i.foreignOpen.toFixed(scale), dueDate: i.dueDate, issueDate: i.date })),
    documents: docs.map((d) => ({ kind: d.kind === kinds.charge ? 'CHARGE' : 'CREDIT', status: d.status, currency: d.currency, issueDate: fromDbDate(d.issueDate), total: d.total.toFixed(scale) })),
    payments: payments.map((p) => ({ status: p.status, currency: p.currency, date: fromDbDate(p.date), amount: p.amount.toFixed(scale) })),
  });
}
