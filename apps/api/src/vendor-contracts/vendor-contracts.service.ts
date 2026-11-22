import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, checkContractCompliance, CONTRACT_ISSUE_LABEL, contractFor, contractPriceKey, D, dec, minorUnits, outsideTermIssue, type ComplianceBill } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { vendorContracts, type VendorContractDoc } from '../db/collections/vendor-contracts';

const ref = (n: number) => `VC-${String(n).padStart(3, '0')}`;
/** How long after a contract ends a bill from the vendor still counts as outside its term. */
const OUTSIDE_TERM_DAYS = 365;

export interface ContractInput {
  contactId: string;
  title: string;
  vendorReference?: string | null;
  startDate: string;
  endDate: string;
  paymentTermsDays?: number | null;
  spendCap?: string | null;
  itemsOnly?: boolean;
  prices: { hsnCode?: string | null; description?: string | null; unitPrice: string }[];
  note?: string | null;
}

/**
 * Vendor contract compliance (AP-032): contracts with vendors (period, payment terms, spend cap,
 * price list) and every posted bill from the vendor checked against the contract covering its
 * date: prices above the contract, items not on it, shorter payment terms, the spend cap, and
 * bills after a contract ended. A contract only changes by being terminated; both are audited.
 */
@Injectable()
export class VendorContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
    private readonly audit: AuditService,
  ) {}

  private invalid(message: string, code = 'CONTRACT_INVALID'): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private effectiveEnd(c: VendorContractDoc) {
    return c.terminatedOn && c.terminatedOn < c.endDate ? c.terminatedOn : c.endDate;
  }

  /** Each contract's compliance, and bills after a contract ended with nothing covering them. */
  private async compliance(org: OrgContext, contracts: VendorContractDoc[]) {
    const vendorIds = [...new Set(contracts.map((c) => c.contactId))];
    const bills = vendorIds.length
      ? await this.prisma.document.findMany({
          where: { orgId: org.id, kind: 'BILL', status: 'POSTED', contactId: { in: vendorIds } },
          select: { id: true, number: true, contactId: true, issueDate: true, dueDate: true, exchangeRate: true, subtotal: true, lines: { select: { description: true, hsnCode: true, quantity: true, unitPrice: true } } },
        })
      : [];
    const byVendor = new Map<string, ComplianceBill[]>();
    for (const b of bills) {
      byVendor.set(b.contactId, [
        ...(byVendor.get(b.contactId) ?? []),
        {
          id: b.id,
          number: b.number ?? 'Bill',
          issueDate: fromDbDate(b.issueDate),
          dueDate: fromDbDate(b.dueDate),
          exchangeRate: b.exchangeRate.toString(),
          subtotal: b.subtotal.toString(),
          lines: b.lines.map((l) => ({ description: l.description, hsnCode: l.hsnCode, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() })),
        },
      ]);
    }
    const result = new Map<string, ReturnType<typeof checkContractCompliance>>();
    for (const vendorId of vendorIds) {
      const mine = contracts.filter((c) => c.contactId === vendorId).map((c) => ({ c, startDate: c.startDate, endDate: this.effectiveEnd(c), reference: ref(c.number) }));
      const vb = byVendor.get(vendorId) ?? [];
      for (const x of mine) {
        result.set(x.c.id, checkContractCompliance({ startDate: x.startDate, endDate: x.endDate, paymentTermsDays: x.c.paymentTermsDays, spendCap: x.c.spendCap, itemsOnly: x.c.itemsOnly, prices: x.c.prices }, vb, org.functionalCurrency));
      }
      for (const b of vb) {
        if (contractFor(mine, b.issueDate)) continue;
        const ended = mine.filter((x) => x.endDate < b.issueDate && b.issueDate <= addDays(x.endDate, OUTSIDE_TERM_DAYS)).sort((a, z) => z.endDate.localeCompare(a.endDate))[0];
        if (!ended) continue;
        const r = result.get(ended.c.id)!;
        r.issues.push(outsideTermIssue(b, ended));
        r.billsWithIssues = new Set(r.issues.map((i) => i.billId)).size;
      }
    }
    return result;
  }

  private async names(ids: string[]) {
    const list = ids.length ? await this.prisma.contact.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true } }) : [];
    return new Map(list.map((c) => [c.id, c.name]));
  }

  private view(c: VendorContractDoc, vendor: string, r: ReturnType<typeof checkContractCompliance>, today: string) {
    const end = this.effectiveEnd(c);
    return {
      id: c.id,
      reference: ref(c.number),
      title: c.title,
      vendor: { id: c.contactId, name: vendor },
      vendorReference: c.vendorReference,
      startDate: c.startDate,
      endDate: c.endDate,
      currency: c.currency,
      paymentTermsDays: c.paymentTermsDays,
      spendCap: c.spendCap,
      itemsOnly: c.itemsOnly,
      status: c.status,
      state: c.status === 'TERMINATED' ? 'TERMINATED' : today < c.startDate ? 'NOT_STARTED' : today > end ? 'ENDED' : 'IN_FORCE',
      terminatedOn: c.terminatedOn,
      spend: r.spend,
      capUsed: r.capUsed,
      billsChecked: r.billsChecked,
      billsWithIssues: r.billsWithIssues,
      overcharge: r.overcharge,
      issues: r.issues.sort((a, b) => a.date.localeCompare(b.date) || a.billNumber.localeCompare(b.billNumber)).map((i) => ({ ...i, label: CONTRACT_ISSUE_LABEL[i.code] })),
    };
  }

  async list(org: OrgContext, today = todayIso()) {
    const contracts = await this.store.collection(vendorContracts).find({}, { sort: { number: -1 } });
    const [r, names] = await Promise.all([this.compliance(org, contracts), this.names(contracts.map((c) => c.contactId))]);
    const views = contracts.map((c) => this.view(c, names.get(c.contactId) ?? 'Unknown vendor', r.get(c.id)!, today));
    const issues = views.flatMap((v) => v.issues.map((i) => ({ ...i, contract: { id: v.id, reference: v.reference }, vendor: v.vendor })));
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    return {
      asOf: today,
      currency: org.functionalCurrency,
      summary: {
        contracts: views.length,
        inForce: views.filter((v) => v.state === 'IN_FORCE').length,
        withIssues: views.filter((v) => v.issues.length).length,
        issues: issues.length,
        high: issues.filter((i) => i.severity === 'HIGH').length,
        overcharge: views.reduce((s, v) => s.plus(dec(v.overcharge)), new D(0)).toFixed(minorUnits(org.functionalCurrency)),
      },
      contracts: views.map(({ issues: list, ...v }) => ({ ...v, issues: list.length })),
      issues: issues.sort((a, b) => rank[a.severity] - rank[b.severity] || b.date.localeCompare(a.date) || a.billNumber.localeCompare(b.billNumber)),
    };
  }

  async get(org: OrgContext, id: string, today = todayIso()) {
    const c = await this.store.collection(vendorContracts).findById(id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor contract not found' });
    const all = await this.store.collection(vendorContracts).find({ contactId: c.contactId });
    const [r, names] = await Promise.all([this.compliance(org, all), this.names([c.contactId])]);
    return { ...this.view(c, names.get(c.contactId) ?? 'Unknown vendor', r.get(c.id)!, today), prices: c.prices, note: c.note, terminateReason: c.terminateReason, createdAt: c.createdAt.toISOString() };
  }

  async create(org: OrgContext, user: AuthUser, input: ContractInput, today = todayIso()) {
    const vendor = await this.prisma.contact.findFirst({ where: { orgId: org.id, id: input.contactId, isVendor: true }, select: { id: true, name: true } });
    if (!vendor) this.invalid('Choose a vendor', 'VENDOR_NOT_FOUND');
    if (input.endDate < input.startDate) this.invalid('The contract ends before it starts');
    const prices = input.prices.map((p) => {
      const key = contractPriceKey(p);
      if (!key) this.invalid('Give each price an HSN/SAC code or a description');
      if (dec(p.unitPrice).lte(0)) this.invalid('A contract price is more than zero');
      return { key, label: p.description?.trim() || p.hsnCode!.trim(), hsnCode: p.hsnCode?.trim() || null, unitPrice: dec(p.unitPrice).toFixed() };
    });
    if (new Set(prices.map((p) => p.key)).size !== prices.length) this.invalid('An item is priced twice; keep one price per item');
    if (input.itemsOnly && !prices.length) this.invalid('List the contract items to check bills against them');
    const running = (await this.store.collection(vendorContracts).find({ contactId: vendor.id, status: 'ACTIVE' })).find((c) => c.startDate <= input.endDate && input.startDate <= this.effectiveEnd(c));
    if (running) throw new DomainError('OVERLAPS', `${vendor.name} already has contract ${ref(running.number)} for part of that period; terminate it first`, HttpStatus.CONFLICT);
    const number = await this.store.nextTenantSequence('vendor_contract');
    const doc = await this.store.collection(vendorContracts).insertOne({
      number,
      contactId: vendor.id,
      title: input.title.trim(),
      vendorReference: input.vendorReference?.trim() || null,
      startDate: input.startDate,
      endDate: input.endDate,
      currency: org.functionalCurrency,
      paymentTermsDays: input.paymentTermsDays ?? null,
      spendCap: input.spendCap ? dec(input.spendCap).toFixed() : null,
      itemsOnly: !!input.itemsOnly,
      prices,
      note: input.note?.trim() || null,
      status: 'ACTIVE',
      createdById: user.id,
      createdAt: new Date(),
      terminatedOn: null,
      terminatedById: null,
      terminatedAt: null,
      terminateReason: null,
    });
    await this.log(org, user, 'vendor_contract.created', doc.id, { reference: ref(number), contactId: vendor.id, startDate: input.startDate, endDate: input.endDate, prices: prices.length, spendCap: doc.spendCap, paymentTermsDays: doc.paymentTermsDays });
    return this.get(org, doc.id, today);
  }

  async terminate(org: OrgContext, user: AuthUser, id: string, input: { reason: string; date?: string }, today = todayIso()) {
    const c = await this.store.collection(vendorContracts).findById(id);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Vendor contract not found' });
    if (c.status === 'TERMINATED') throw new DomainError('ALREADY_TERMINATED', 'The contract is already terminated', HttpStatus.CONFLICT);
    const date = input.date ?? today;
    if (date < c.startDate || date > c.endDate) this.invalid(`Terminate between the start (${c.startDate}) and the end (${c.endDate})`);
    const r = await this.store.collection(vendorContracts).updateOne({ id, status: 'ACTIVE' }, { $set: { status: 'TERMINATED', terminatedOn: date, terminatedById: user.id, terminatedAt: new Date(), terminateReason: input.reason.trim() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The contract changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'vendor_contract.terminated', id, { reference: ref(c.number), date, reason: input.reason.trim() });
    return this.get(org, id, today);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'vendor_contract', entityId, data }));
  }
}

