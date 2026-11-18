import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, billCheckFingerprint, checkBill, D, type BillCheckBill, type BillCheckFinding } from '@talk2tax/accounting-engine';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate, istDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { billCheckReviews, BillCheckReviewDoc } from '../db/collections/bill-checks';
import { accounts } from '../db/collections/chart';
import { users } from '../db/collections/identity';
import { contacts, DocumentDoc, documents } from '../db/collections/sales';

/** How far back a vendor's bills are compared, and how far back the worklist looks. */
const HISTORY_DAYS = 730;
const WORKLIST_DAYS = 120;

/**
 * Unusual bill checks (AP-031). MongoDB only. Each bill is compared with the same vendor's other
 * posted bills and the vendor's bank details; findings are rule-based and explained. A person
 * reviews a bill's findings with a note; the review covers those findings only.
 */
@Injectable()
export class BillChecksService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private toBill(d: DocumentDoc, names: Map<string, string>): BillCheckBill {
    const rate = new D(d.exchangeRate);
    return {
      id: d.id,
      number: d.number,
      reference: d.reference,
      issueDate: fromDbDate(d.issueDate),
      total: new D(d.total).times(rate).toDecimalPlaces(2).toFixed(),
      currency: d.currency,
      lines: d.lines.map((l) => ({
        description: l.description,
        accountId: l.accountId,
        accountName: names.get(l.accountId),
        quantity: new D(l.quantity).toFixed(),
        unitPrice: new D(l.unitPrice).times(rate).toDecimalPlaces(6).toFixed(),
        taxAmount: new D(l.taxAmount).toFixed(),
      })),
    };
  }

  /** Findings for each given bill, loading every vendor's history and bank details once. */
  private async evaluate(org: OrgContext, bills: DocumentDoc[]) {
    const today = todayIso();
    const vendorIds = [...new Set(bills.map((b) => b.contactId))];
    const [others, accs, vendors, banks] = await Promise.all([
      this.store.collection(documents).find({ kind: 'BILL', status: 'POSTED', contactId: { $in: vendorIds }, issueDate: { $gte: toDbDate(addDays(today, -HISTORY_DAYS)) } }),
      this.store.collection(accounts).find({}, { projection: { id: 1, code: 1, name: 1 } }),
      this.store.collection(contacts).find({ id: { $in: vendorIds } }, { projection: { id: 1, name: 1 } }),
      this.prisma.vendorBankDetails.findMany({ where: { orgId: org.id, contactId: { in: vendorIds } }, select: { contactId: true, changedAt: true, verifiedAt: true } }),
    ]);
    const names = new Map(accs.map((a) => [a.id, `${a.code} ${a.name}`]));
    const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
    const bank = new Map(banks.map((b) => [b.contactId, { changedAt: b.changedAt ? istDate(b.changedAt) : null, verifiedAt: b.verifiedAt ? istDate(b.verifiedAt) : null }]));
    const byVendor = new Map<string, BillCheckBill[]>();
    for (const o of others) {
      const list = byVendor.get(o.contactId) ?? [];
      list.push(this.toBill(o, names));
      byVendor.set(o.contactId, list);
    }
    const reviews = await this.store.collection(billCheckReviews).find({ documentId: { $in: bills.map((b) => b.id) } }, { sort: { reviewedAt: -1 } });
    const latest = new Map<string, BillCheckReviewDoc>();
    for (const r of reviews) if (!latest.has(r.documentId)) latest.set(r.documentId, r);
    const people = await this.people([...latest.values()].map((r) => r.reviewedById));
    return bills.map((b) => {
      const bill = this.toBill(b, names);
      const findings = checkBill({ bill, history: (byVendor.get(b.contactId) ?? []).filter((h) => h.id !== b.id && h.issueDate <= bill.issueDate), bank: bank.get(b.contactId) ?? null, today });
      const r = latest.get(b.id);
      const fingerprint = billCheckFingerprint(findings);
      return {
        documentId: b.id,
        number: b.number,
        reference: b.reference,
        status: b.status,
        issueDate: bill.issueDate,
        vendorId: b.contactId,
        vendor: vendorName.get(b.contactId) ?? '',
        currency: b.currency,
        total: new D(b.total).toFixed(2),
        findings,
        fingerprint,
        highest: findings[0]?.severity ?? null,
        review: r ? { note: r.note, by: people.get(r.reviewedById) ?? null, at: r.reviewedAt.toISOString(), current: r.fingerprint === fingerprint } : null,
      };
    });
  }

  private async people(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const rows = await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }, { projection: { id: 1, name: 1 } });
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private async bill(id: string) {
    const d = await this.store.collection(documents).findById(id);
    if (!d || d.kind !== 'BILL') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
    return d;
  }

  async forBill(org: OrgContext, id: string) {
    const d = await this.bill(id);
    if (d.status === 'VOID') return { ...(await this.evaluate(org, [d]))[0]!, findings: [] as BillCheckFinding[], highest: null, fingerprint: '' };
    return (await this.evaluate(org, [d]))[0]!;
  }

  /**
   * Draft and posted bills dated in the last 120 days with a finding worth a look (medium or high;
   * for-information findings show on the bill only), unreviewed first.
   */
  async worklist(org: OrgContext, q: { includeReviewed?: boolean }) {
    const since = toDbDate(addDays(todayIso(), -WORKLIST_DAYS));
    const bills = await this.store.collection(documents).find({ kind: 'BILL', status: { $in: ['DRAFT', 'POSTED'] }, issueDate: { $gte: since } }, { sort: { issueDate: -1 } });
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const all = (await this.evaluate(org, bills)).filter((b) => b.findings.some((f) => f.severity !== 'LOW'));
    const open = all.filter((b) => !b.review?.current);
    const items = (q.includeReviewed ? all : open).sort((a, b) => Number(!!a.review?.current) - Number(!!b.review?.current) || rank[a.highest!] - rank[b.highest!] || b.issueDate.localeCompare(a.issueDate));
    return {
      summary: { toReview: open.length, high: open.filter((b) => b.highest === 'HIGH').length, reviewed: all.length - open.length, checked: bills.length },
      items,
    };
  }

  async review(org: OrgContext, actorId: string, id: string, note: string) {
    const d = await this.bill(id);
    const [current] = d.status === 'VOID' ? [] : await this.evaluate(org, [d]);
    if (!current?.findings.length) throw new DomainError('NOTHING_TO_REVIEW', 'This bill has no unusual findings to review', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.store.collection(billCheckReviews).insertOne({ orgId: org.id, documentId: id, fingerprint: current.fingerprint, note: note.trim(), reviewedById: actorId, reviewedAt: new Date() });
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId, action: 'bill_check.reviewed', entityType: 'document', entityId: id, data: { findings: current.findings.map((f) => f.code), note: note.trim() } }));
    return this.forBill(org, id);
  }
}
