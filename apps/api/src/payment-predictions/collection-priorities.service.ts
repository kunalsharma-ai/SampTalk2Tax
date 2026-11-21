import { Injectable } from '@nestjs/common';
import { COLLECTION_ACTION_LABEL, collectionPriorities, D, minorUnits, type PriorityCustomer } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { istDate, todayIso } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { PaymentPredictionsService } from './payment-predictions.service';

/**
 * Intelligent collection prioritisation (AR-034): customers ranked by who to chase first today,
 * from overdue balances not in dispute, their age, the payment predictions (AR-033) and the last
 * reminder sent, with the points behind every score and a suggested action. Read-only.
 */
@Injectable()
export class CollectionPrioritiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly predictions: PaymentPredictionsService,
  ) {}

  async priorities(org: OrgContext, today = todayIso()) {
    const p = await this.predictions.predictions(org, {}, today);
    const ids = [...new Set(p.invoices.map((i) => i.contactId))];
    const s = minorUnits(org.functionalCurrency);
    const [contacts, disputes, reminders] = ids.length
      ? await Promise.all([
          this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: ids } }, select: { id: true, name: true, email: true, creditHold: true } }),
          this.prisma.invoiceDispute.findMany({ where: { orgId: org.id, status: 'OPEN', documentId: { in: p.invoices.map((i) => i.invoiceId) } }, select: { documentId: true, amount: true } }),
          this.prisma.collectionDraft.findMany({ where: { orgId: org.id, status: 'SENT', contactId: { in: ids } }, orderBy: { sentAt: 'desc' }, select: { contactId: true, sentAt: true } }),
        ])
      : [[], [], []];
    const disputed = new Map<string, InstanceType<typeof D>>();
    for (const d of disputes) disputed.set(d.documentId, (disputed.get(d.documentId) ?? new D(0)).plus(d.amount.toString()));
    const lastReminder = new Map<string, string>();
    for (const r of reminders) if (r.sentAt && !lastReminder.has(r.contactId)) lastReminder.set(r.contactId, istDate(r.sentAt));
    const customers: PriorityCustomer[] = contacts.map((c) => ({
      contactId: c.id,
      name: c.name,
      email: c.email,
      creditHold: c.creditHold,
      lastReminderOn: lastReminder.get(c.id) ?? null,
      invoices: p.invoices
        .filter((i) => i.contactId === c.id)
        .map((i) => ({ id: i.invoiceId, number: i.number ?? '', dueDate: i.dueDate, outstanding: i.outstanding, lateChance: i.lateChance, disputed: (disputed.get(i.invoiceId) ?? new D(0)).toFixed(s) })),
    }));
    const ranked = collectionPriorities(customers, today, s);
    const sum = (k: 'toChase' | 'disputed') => ranked.reduce((t, r) => t.plus(r[k]), new D(0)).toFixed(s);
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: { customers: ranked.length, toChase: sum('toChase'), disputed: sum('disputed'), callNow: ranked.filter((r) => r.action === 'CALL' || r.action === 'CALL_AND_HOLD').length },
      customers: ranked.map((r) => ({
        ...r,
        actionLabel: COLLECTION_ACTION_LABEL[r.action],
        invoices: customers
          .find((c) => c.contactId === r.contactId)!
          .invoices.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
      })),
    };
  }
}
