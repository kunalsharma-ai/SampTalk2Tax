import { HttpStatus, Injectable } from '@nestjs/common';
import { findOpportunities, OPPORTUNITY_INFO, OPPORTUNITY_KINDS, shiftYm, TwinError, type OpportunityCustomer, type OpportunityInput, type OpportunitySettings } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { todayIst } from '../cash-flow/cash-flow.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { lineSums } from '../db/ledger-queries';
import { PrismaService } from '../common/prisma.service';
import { DimensionsService, type DimOrg } from '../dimensions/dimensions.service';
import { ImpactService } from '../impact/impact.service';
import { TwinService } from '../twin/twin.service';

type Actor = { id: string };
export type OpportunityQuery = OpportunitySettings & { horizonMonths: number };

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Opportunity intelligence. Reads the last twelve complete months of posted sales (by customer,
 * month and revenue line), department and project profit, and gross margin, then asks the engine
 * for opportunities, each measured with the business impact engine. Read-only: taking one forward
 * saves it as an impact assessment, which is audited there.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twin: TwinService,
    private readonly dimensions: DimensionsService,
    private readonly impact: ImpactService,
    private readonly store: DocumentStoreService,
  ) {}

  private async input(org: DimOrg, q: OpportunityQuery): Promise<OpportunityInput> {
    const last = shiftYm(todayIst().slice(0, 7), -1);
    const months = Array.from({ length: 12 }, (_, i) => shiftYm(last, i - 11));
    const from = `${months[0]}-01`;
    const to = monthEnd(last);
    const year = await this.twin.actuals(org.id, 12);
    const baseline = { currency: year.currency, scale: year.scale, months: year.months.slice(6) };
    const cashBuffer = await this.twin.buffer(org.id);

    // Net sales before tax: revenue lines of posted invoices less credit notes, by customer, month and account.
    const docs = await this.prisma.document.findMany({ where: { orgId: org.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: 'POSTED', issueDate: { gte: toDbDate(from), lte: toDbDate(to) }, journalEntryId: { not: null } }, select: { contactId: true, issueDate: true, journalEntryId: true } });
    const revenue = (await this.prisma.account.findMany({ where: { orgId: org.id, type: 'REVENUE' }, select: { id: true } })).map((a) => a.id);
    const sums = docs.length && revenue.length ? await lineSums(this.store, org.id, { entry: { _id: { $in: docs.map((d) => d.journalEntryId!) } }, line: { accountId: { $in: revenue } }, by: { entryId: '_id', accountId: 'lines.accountId' } }) : [];
    const names = new Map((docs.length ? await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(docs.map((d) => d.contactId))] } }, select: { id: true, name: true } }) : []).map((c) => [c.id, c.name]));
    const grouped = new Map<string, { contact_id: string; name: string; month: string; account_id: string; amount: Prisma.Decimal }>();
    for (const d of docs) {
      const month = fromDbDate(d.issueDate).slice(0, 7);
      for (const r of sums.filter((x) => x.key.entryId === d.journalEntryId)) {
        const accountId = r.key.accountId as string;
        const k = `${d.contactId}|${month}|${accountId}`;
        const cur = grouped.get(k);
        grouped.set(k, { contact_id: d.contactId, name: names.get(d.contactId) ?? '', month, account_id: accountId, amount: (cur?.amount ?? new Prisma.Decimal(0)).plus(r.credit.minus(r.debit).toFixed()) });
      }
    }
    const rows = [...grouped.values()];
    const customers = new Map<string, { contactId: string; name: string; byMonth: Prisma.Decimal[]; byLine: Map<string, Prisma.Decimal> }>();
    for (const r of rows) {
      const c = customers.get(r.contact_id) ?? { contactId: r.contact_id, name: r.name, byMonth: months.map(() => new Prisma.Decimal(0)), byLine: new Map() };
      const i = months.indexOf(r.month);
      if (i >= 0) c.byMonth[i] = c.byMonth[i]!.plus(r.amount);
      c.byLine.set(r.account_id, (c.byLine.get(r.account_id) ?? new Prisma.Decimal(0)).plus(r.amount));
      customers.set(r.contact_id, c);
    }
    const used = [...new Set(rows.map((r) => r.account_id))];
    const accounts = used.length ? await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: used } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }) : [];
    const fmt = (d: Prisma.Decimal) => d.toFixed(year.scale);

    const segments: OpportunityInput['segments'] = [];
    for (const kind of ['DEPARTMENT', 'PROJECT'] as const) {
      const rep = await this.dimensions.profit(org, { type: kind, from, to });
      const rev = rep.sections.find((s) => s.type === 'REVENUE');
      const exp = rep.sections.find((s) => s.type === 'EXPENSE');
      rep.columns.forEach((c, i) => {
        if (!c.id) return;
        segments.push({ kind, id: c.id, code: c.code ?? '', name: c.name, revenue: rev?.totals[i] ?? '0', costs: exp?.totals[i] ?? '0' });
      });
    }

    return {
      baseline,
      horizonMonths: q.horizonMonths,
      cashBuffer,
      months,
      margins: year.months.map((m) => ({ revenue: m.revenue, costOfSales: m.costOfSales })),
      customers: [...customers.values()].map((c): OpportunityCustomer => ({ contactId: c.contactId, name: c.name, byMonth: c.byMonth.map(fmt), byLine: Object.fromEntries([...c.byLine].map(([k, v]) => [k, fmt(v)])) })),
      lines: accounts.map((a) => ({ accountId: a.id, code: a.code, name: a.name })),
      segments,
      settings: { winBackRatePercent: q.winBackRatePercent, crossSellRatePercent: q.crossSellRatePercent, segmentGrowthPercent: q.segmentGrowthPercent },
    };
  }

  private run(input: OpportunityInput) {
    const empty = input.margins.every((m) => new Prisma.Decimal(m.revenue).isZero());
    if (empty) throw new DomainError('NO_BOOKS', 'There are no posted sales in the last twelve months to look for opportunities in', HttpStatus.UNPROCESSABLE_ENTITY);
    try {
      return findOpportunities(input);
    } catch (e) {
      if (e instanceof TwinError) throw new DomainError('OPPORTUNITIES_INVALID', e.message, HttpStatus.UNPROCESSABLE_ENTITY, { issues: e.issues });
      throw e;
    }
  }

  async find(org: DimOrg, q: OpportunityQuery) {
    const input = await this.input(org, q);
    return { currency: input.baseline.currency, horizonMonths: q.horizonMonths, kinds: OPPORTUNITY_KINDS.map((k) => ({ key: k, ...OPPORTUNITY_INFO[k] })), ...this.run(input) };
  }

  /** Takes an opportunity forward as a saved impact assessment, to adjust, save and send to the war room. */
  async toAssessment(org: DimOrg, actor: Actor, key: string, q: OpportunityQuery) {
    const r = this.run(await this.input(org, q));
    const o = r.opportunities.find((x) => x.key === key);
    if (!o) throw new DomainError('NOT_FOUND', 'That opportunity is no longer in the books; refresh the list', HttpStatus.NOT_FOUND);
    let name = o.title.slice(0, 110);
    for (let i = 2; await this.prisma.impactAssessment.findFirst({ where: { orgId: org.id, name } }); i++) name = `${o.title.slice(0, 110)} (${i})`;
    const description = `From opportunity intelligence: ${o.finding} ${o.assumptions.join(' ')}`.slice(0, 1000);
    return this.impact.create(org.id, actor, { name, description, baselineMonths: 6, horizonMonths: q.horizonMonths, changes: o.changes });
  }
}
