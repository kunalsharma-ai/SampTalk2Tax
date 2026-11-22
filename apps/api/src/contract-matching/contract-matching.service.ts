import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, matchInvoicesToContracts, minorUnits, type ContractFrequency, type ContractMatch, type MatchContract, type MatchInvoice } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { hasPermission } from '@talk2tax/security';
import type { OrgContext } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { contractMatchDismissals } from '../db/collections/contract-matching';
import { lockRow } from '../db/locks';

const ref = (n: number) => `CT-${String(n).padStart(4, '0')}`;
/** The most invoices looked at in one pass, newest first. */
const MAX_INVOICES = 2000;
type Actor = { id: string };

const contractInclude = { lines: { orderBy: { lineNo: 'asc' as const } }, periods: true } satisfies Prisma.SalesContractInclude;
type ContractRow = Prisma.SalesContractGetPayload<{ include: typeof contractInclude }>;
type InvoiceRow = { id: string; number: string | null; status: string; contactId: string; currency: string; issueDate: Date; subtotal: Prisma.Decimal; lines: { description: string | null; accountId: string; quantity: Prisma.Decimal; unitPrice: Prisma.Decimal }[] };

/**
 * Contract-to-invoice matching (AR-041): invoices raised by hand to customers with contracts,
 * each matched to the contract it most likely bills, with the period it falls in, any billing
 * twice and any price that differs from the contract. A person counts a match as the contract's
 * next period (so the contract does not bill it again) or dismisses it with a reason.
 */
@Injectable()
export class ContractMatchingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  private toMatchContract(c: ContractRow, billed: Map<string, { number: string | null; status: string }>): MatchContract {
    return {
      id: c.id,
      ref: ref(c.number),
      title: c.title,
      contactId: c.contactId,
      currency: c.currency,
      start: fromDbDate(c.startDate),
      end: c.endDate ? fromDbDate(c.endDate) : null,
      frequency: c.frequency as ContractFrequency,
      timing: c.timing,
      billingDay: c.billingDay ?? null,
      nextNo: c.nextPeriodNo,
      subtotal: new D(c.subtotal).toFixed(),
      lines: c.lines.map((l) => ({ description: l.description, accountId: l.accountId, quantity: new D(l.quantity).toFixed(), unitPrice: new D(l.unitPrice).toFixed() })),
      periods: new Map(
        c.periods.map((p) => {
          const d = p.documentId ? billed.get(p.documentId) : undefined;
          const live = d && d.status !== 'VOID';
          return [p.periodNo, { status: p.status, documentId: live ? p.documentId : null, documentNumber: live ? d.number : null }] as const;
        }),
      ),
    };
  }

  private toMatchInvoice(d: InvoiceRow): MatchInvoice {
    return {
      id: d.id,
      number: d.number ?? 'Draft invoice',
      contactId: d.contactId,
      currency: d.currency,
      issueDate: fromDbDate(d.issueDate),
      subtotal: new D(d.subtotal).toFixed(),
      lines: d.lines.map((l) => ({ description: l.description, accountId: l.accountId, quantity: new D(l.quantity).toFixed(), unitPrice: new D(l.unitPrice).toFixed() })),
    };
  }

  private async billedDocs(db: Tx | PrismaService, orgId: string, contracts: ContractRow[]) {
    const ids = contracts.flatMap((c) => c.periods.map((p) => p.documentId)).filter((x): x is string => !!x);
    const docs = ids.length ? await db.document.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, number: true, status: true } }) : [];
    return new Map(docs.map((d) => [d.id, { number: d.number, status: d.status as string }]));
  }

  private invoiceSelect = { id: true, number: true, status: true, contactId: true, currency: true, issueDate: true, subtotal: true, lines: { orderBy: { lineNo: 'asc' as const }, select: { description: true, accountId: true, quantity: true, unitPrice: true } } } as const;

  async list(org: OrgContext) {
    const scale = minorUnits(org.functionalCurrency);
    const contracts = await this.prisma.salesContract.findMany({ where: { orgId: org.id, status: { in: ['ACTIVE', 'PAUSED', 'ENDED'] } }, include: contractInclude, orderBy: { number: 'asc' } });
    const canManage = hasPermission(org.role, 'sales.manage');
    if (!contracts.length) return { matches: [], summary: { matches: 0, billedTwice: 0, toLink: 0, priceDifferences: 0 }, contracts: 0, dismissed: 0, canManage };
    const billed = await this.billedDocs(this.prisma, org.id, contracts);
    const linked = new Set(contracts.flatMap((c) => c.periods.map((p) => p.documentId)).filter(Boolean));
    const from = contracts.map((c) => c.startDate).reduce((a, b) => (a < b ? a : b));
    const rows = (await this.prisma.document.findMany({
      where: { orgId: org.id, kind: 'INVOICE', status: { in: ['DRAFT', 'POSTED'] }, contactId: { in: [...new Set(contracts.map((c) => c.contactId))] }, issueDate: { gte: from } },
      select: this.invoiceSelect,
      orderBy: { issueDate: 'desc' },
      take: MAX_INVOICES,
    })) as unknown as InvoiceRow[];
    const dismissals = await this.store.collection(contractMatchDismissals).find({});
    const dismissed = new Set(dismissals.map((x) => `${x.documentId}:${x.contractId}`));
    const mcs = contracts.map((c) => this.toMatchContract(c, billed));
    const matches: (ContractMatch & { status: string })[] = [];
    for (const d of rows) {
      if (linked.has(d.id)) continue;
      const [m] = matchInvoicesToContracts({ contracts: mcs.filter((c) => !dismissed.has(`${d.id}:${c.id}`)), invoices: [this.toMatchInvoice(d)], scale });
      if (m) matches.push({ ...m, status: d.status });
    }
    const names = new Map((await this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: [...new Set(contracts.map((c) => c.contactId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    const customerOf = new Map(contracts.map((c) => [c.id, names.get(c.contactId) ?? 'Former customer']));
    const rank = { ALREADY_BILLED: 0, NEXT: 1, EARLIER_UNBILLED: 2, BILLING_VOIDED: 3, SKIPPED: 4, OUTSIDE_TERM: 5 } as const; // not money
    matches.sort((a, b) => rank[a.periodState] - rank[b.periodState] || b.score - a.score || a.invoice.issueDate.localeCompare(b.invoice.issueDate));
    return {
      matches: matches.map((m) => ({ ...m, customer: customerOf.get(m.contract.id)! })),
      summary: {
        matches: matches.length,
        billedTwice: matches.filter((m) => m.periodState === 'ALREADY_BILLED').length,
        toLink: matches.filter((m) => m.canLink).length,
        priceDifferences: matches.filter((m) => m.differences.length).length,
      },
      contracts: contracts.length,
      dismissed: dismissals.length,
      canManage,
    };
  }

  /** Counts a hand-made invoice as the contract's next period, so the contract does not bill it again. */
  async link(org: OrgContext, actor: Actor, input: { documentId: string; contractId: string }) {
    if (!hasPermission(org.role, 'sales.manage')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot link invoices to contracts; it needs sales.manage`, HttpStatus.FORBIDDEN);
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'sales_contracts', input.contractId, org.id);
      const c = await tx.salesContract.findFirst({ where: { id: input.contractId, orgId: org.id }, include: contractInclude });
      if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contract not found' });
      if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') throw new DomainError('CONTRACT_NOT_BILLING', `${ref(c.number)} is ${c.status.toLowerCase()}: it has no period left to count an invoice as`, HttpStatus.CONFLICT);
      const d = (await tx.document.findFirst({ where: { id: input.documentId, orgId: org.id, kind: 'INVOICE' }, select: this.invoiceSelect })) as unknown as InvoiceRow | null;
      if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
      if (d.status === 'VOID') throw new DomainError('INVOICE_VOID', 'A void invoice cannot bill a contract period', HttpStatus.CONFLICT);
      const elsewhere = await tx.salesContractPeriod.findFirst({ where: { orgId: org.id, documentId: d.id } });
      if (elsewhere) throw new DomainError('ALREADY_LINKED', 'This invoice already bills a contract period', HttpStatus.CONFLICT);
      const [m] = matchInvoicesToContracts({ contracts: [this.toMatchContract(c, await this.billedDocs(tx, org.id, [c]))], invoices: [this.toMatchInvoice(d)], scale: minorUnits(org.functionalCurrency) });
      if (!m) throw new DomainError('NO_MATCH', `This invoice does not look like billing for ${ref(c.number)}: the customer, currency or lines differ`, HttpStatus.UNPROCESSABLE_ENTITY);
      if (!m.canLink) throw new DomainError('NOT_NEXT_PERIOD', m.advice, HttpStatus.CONFLICT);
      const p = m.period!;
      await tx.salesContractPeriod.create({ data: { orgId: org.id, contractId: c.id, periodNo: p.no, periodStart: toDbDate(p.start), periodEnd: toDbDate(p.end), status: 'BILLED', documentId: d.id } });
      await tx.salesContract.update({ where: { id: c.id }, data: { nextPeriodNo: c.nextPeriodNo + 1 } });
      const label = d.number ?? 'A draft invoice';
      await tx.salesContractEvent.create({ data: { orgId: org.id, contractId: c.id, kind: 'INVOICE_LINKED', body: `${label} counted as period ${p.start} to ${p.end}`, data: { periodNo: p.no, documentId: d.id } as Prisma.InputJsonValue, actorId: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'sales_contract.invoice_linked', entityType: 'sales_contract', entityId: c.id, data: { reference: ref(c.number), periodNo: p.no, documentId: d.id, score: m.score, totalDifference: m.totalDifference } });
    });
    return this.list(org);
  }

  /** Records that an invoice does not bill a contract; that pair is not suggested again. */
  async dismiss(org: OrgContext, actor: Actor, input: { documentId: string; contractId: string; reason: string }) {
    if (!hasPermission(org.role, 'sales.manage')) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot dismiss contract matches; it needs sales.manage`, HttpStatus.FORBIDDEN);
    const [c, d] = await Promise.all([
      this.prisma.salesContract.findFirst({ where: { id: input.contractId, orgId: org.id }, select: { id: true, number: true } }),
      this.prisma.document.findFirst({ where: { id: input.documentId, orgId: org.id, kind: 'INVOICE' }, select: { id: true, number: true } }),
    ]);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contract not found' });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    if (await this.store.collection(contractMatchDismissals).findOne({ documentId: d.id, contractId: c.id })) throw new DomainError('ALREADY_DISMISSED', 'This match was already dismissed', HttpStatus.CONFLICT);
    const doc = await this.store.collection(contractMatchDismissals).insertOne({ documentId: d.id, contractId: c.id, reason: input.reason.trim(), dismissedById: actor.id, dismissedAt: new Date() });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contract_match.dismissed', entityType: 'sales_contract', entityId: c.id, data: { reference: ref(c.number), documentId: d.id, number: d.number, reason: input.reason.trim(), dismissalId: doc.id } }));
    return this.list(org);
  }
}
