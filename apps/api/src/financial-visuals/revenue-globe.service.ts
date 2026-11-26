import { HttpStatus, Injectable } from '@nestjs/common';
import { minorUnits, revenueGlobe, type GlobeSale } from '@talk2tax/accounting-engine';
import { FOREIGN_PLACE_OF_SUPPLY, INDIA_STATES } from '@talk2tax/tax-engine';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { accounts } from '../db/collections/chart';
import { contacts, documents } from '../db/collections/sales';
import { lineSums, postedBetween } from '../db/ledger-queries';

const MAX_MONTHS = 24; // not money
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money
const STATE_NAMES = Object.fromEntries(INDIA_STATES.map((s) => [s.code, s.name]));

/**
 * Revenue distribution globe (DASH-025): sales revenue (the revenue lines of posted invoices and
 * credit notes, other income left out) by where the customer is. Abroad by the customer's
 * country; at home by state (India: the invoice's place of supply, else the customer's state).
 * Read only; reports.read. Places name countries and states, never customers.
 */
@Injectable()
export class RevenueGlobeService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async globe(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -11);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    const months: string[] = [];
    for (let m = from; m <= to; m = shift(m, 1)) {
      months.push(m);
      if (months.length > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    const home = o.countryCode.toUpperCase();
    const revenue = (await this.store.collection(accounts).find({ type: 'REVENUE' })).filter((a) => a.subtype !== 'OTHER_INCOME').map((a) => a.id);
    const sums = revenue.length
      ? await lineSums(this.store, org.id, {
          entry: postedBetween(toDbDate(`${from}-01`), toDbDate(lastDay(to))),
          line: { accountId: { $in: revenue } },
          by: { entryId: '_id', month: { $dateToString: { date: '$date', format: '%Y-%m' } } },
        })
      : [];
    const entryIds = [...new Set(sums.map((r) => r.key.entryId as string))];
    const docs = entryIds.length
      ? await this.store.collection(documents).find({ kind: { $in: ['INVOICE', 'CREDIT_NOTE'] }, $or: [{ journalEntryId: { $in: entryIds } }, { voidJournalEntryId: { $in: entryIds } }] })
      : [];
    const byEntry = new Map<string, (typeof docs)[number]>();
    for (const d of docs) {
      if (d.journalEntryId) byEntry.set(d.journalEntryId, d);
      if (d.voidJournalEntryId) byEntry.set(d.voidJournalEntryId, d);
    }
    const contactIds = [...new Set(docs.map((d) => d.contactId))];
    const people = new Map(
      (contactIds.length ? await this.store.collection(contacts).find({ id: { $in: contactIds } }, { projection: { id: 1, countryCode: 1, stateCode: 1 } }) : []).map((c) => [c.id, c]),
    );
    const sales: GlobeSale[] = [];
    for (const r of sums) {
      const d = byEntry.get(r.key.entryId as string);
      if (!d) continue;
      const c = people.get(d.contactId);
      const pos = d.placeOfSupply ?? null;
      const contactCountry = c?.countryCode?.toUpperCase() ?? null;
      // An export with no other country recorded goes abroad, place unknown.
      const country = pos === FOREIGN_PLACE_OF_SUPPLY ? (contactCountry && contactCountry !== home ? contactCountry : null) : (contactCountry ?? home);
      const state = country === home ? (pos && pos !== FOREIGN_PLACE_OF_SUPPLY ? pos : (c?.stateCode ?? null)) : null;
      sales.push({ contactId: d.contactId, country, state, month: r.key.month as string, amount: r.credit.minus(r.debit).toFixed() });
    }
    const g = revenueGlobe({ sales, months, homeCountry: home, stateNames: home === 'IN' ? STATE_NAMES : undefined, scale: minorUnits(org.functionalCurrency) });
    return { currency: org.functionalCurrency, from, to, fromDate: `${from}-01`, toDate: lastDay(to), ...g };
  }
}
