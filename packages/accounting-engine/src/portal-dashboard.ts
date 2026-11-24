import { D } from './money';
import { agingByDueDate } from './role-dashboards';

/**
 * The dashboard a vendor or customer sees in their portal (DASH-060/061), in one currency: what is
 * open by how late it is, what falls due next, and the last twelve months of invoices and payments.
 */
export interface PortalOpenItem {
  type: 'charge' | 'credit';
  currency: string;
  open: string;
  dueDate: string | null;
  issueDate: string;
}
export interface PortalDocumentFact {
  kind: 'CHARGE' | 'CREDIT';
  status: string;
  currency: string;
  issueDate: string;
  total: string;
}
export interface PortalPaymentFact {
  status: string;
  currency: string;
  date: string;
  amount: string;
}

/** The twelve months up to and including the month of a day, oldest first, as YYYY-MM. */
export function portalMonths(today: string): string[] {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const t = y * 12 + m - 11 + i; // not money: month index
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

export function portalDashboard(input: { currency: string; today: string; items: PortalOpenItem[]; documents: PortalDocumentFact[]; payments: PortalPaymentFact[]; scale?: number }) {
  const scale = input.scale ?? 2;
  const charges = input.items.filter((i) => i.currency === input.currency && i.type === 'charge' && new D(i.open).greaterThan(0));
  const aging = agingByDueDate(
    charges.map((c) => ({ open: c.open, dueDate: c.dueDate ?? c.issueDate })),
    input.today,
    scale,
  );
  const upcoming = charges.filter((c) => c.dueDate && c.dueDate >= input.today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const nextDate = upcoming[0]?.dueDate ?? null;
  const nextDue = nextDate
    ? {
        date: nextDate,
        amount: upcoming
          .filter((c) => c.dueDate === nextDate)
          .reduce((t, c) => t.plus(c.open), new D(0))
          .toFixed(scale),
        items: upcoming.filter((c) => c.dueDate === nextDate).length,
      }
    : null;
  const dueIn30 = upcoming.filter((c) => Date.parse(`${c.dueDate}T00:00:00Z`) - Date.parse(`${input.today}T00:00:00Z`) <= 30 * 86_400_000).reduce((t, c) => t.plus(c.open), new D(0));
  const months = portalMonths(input.today);
  const first = months[0]!;
  const billed = new Map(months.map((m) => [m, new D(0)]));
  const paid = new Map(months.map((m) => [m, new D(0)]));
  for (const d of input.documents) {
    const m = d.issueDate.slice(0, 7);
    if (d.currency !== input.currency || d.status === 'VOID' || m < first || !billed.has(m)) continue;
    billed.set(m, billed.get(m)!.plus(d.kind === 'CREDIT' ? new D(d.total).negated() : d.total));
  }
  for (const p of input.payments) {
    const m = p.date.slice(0, 7);
    if (p.currency !== input.currency || p.status === 'VOID' || m < first || !paid.has(m)) continue;
    paid.set(m, paid.get(m)!.plus(p.amount));
  }
  const sum = (x: Map<string, InstanceType<typeof D>>) => [...x.values()].reduce((t, v) => t.plus(v), new D(0));
  return {
    currency: input.currency,
    aging,
    nextDue,
    dueIn30Days: dueIn30.toFixed(scale),
    months: months.map((m) => ({ month: m, invoiced: billed.get(m)!.toFixed(scale), paid: paid.get(m)!.toFixed(scale) })),
    lastTwelveMonths: { invoiced: sum(billed).toFixed(scale), paid: sum(paid).toFixed(scale) },
  };
}
