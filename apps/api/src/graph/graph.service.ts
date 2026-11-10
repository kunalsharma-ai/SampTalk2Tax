import { Injectable, NotFoundException } from '@nestjs/common';
import { D, formatAmountText, formatDateText, minorUnits } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { fromDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService } from '../common/prisma.service';
import { lineSums } from '../db/ledger-queries';

export const GRAPH_NODE_TYPES = ['CONTACT', 'DOCUMENT', 'PAYMENT', 'JOURNAL', 'ACCOUNT', 'PROJECT', 'DEPARTMENT', 'LOAN', 'ASSET', 'ALERT'] as const;
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

/** A record in the graph. `path` is where it lives in the app; `graph` is false for records the graph cannot open. */
export interface GraphNode {
  type: GraphNodeType | 'SOURCE';
  id: string;
  label: string;
  subtitle: string | null;
  path: string | null;
}
/** A relationship, with a sentence that says why the two records are connected. */
export interface GraphEdge {
  relation: string;
  explanation: string;
  node: GraphNode;
}
/** Where a journal entry came from. */
export interface EntrySource {
  type: GraphNodeType | 'SOURCE';
  id: string;
  label: string;
  path: string | null;
  /** How the entry relates to it: "posts", "voids", "reverses", ... */
  role: string;
}

/** How many related records of one kind are listed before the rest is summarised. */
const LIMIT = 25;
const DOC_LABEL: Record<string, string> = { INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', BILL: 'Bill', VENDOR_CREDIT: 'Vendor credit' };
const docPath = (kind: string, id: string) => (kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? `/sales/invoices/${id}` : `/purchases/bills/${id}`);
const payPath = (kind: string, id: string) => (kind === 'RECEIPT' ? `/sales/receipts/${id}` : `/purchases/payments/${id}`);
const je = (n: number | null) => (n ? `JE-${String(n).padStart(6, '0')}` : 'Draft journal');
const pad4 = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, '0')}`;
const dec = (x: Prisma.Decimal | string | number | null | undefined) => new D((x ?? 0).toString());

/**
 * The relationship graph. It is not a separate store: every edge is read from the books when
 * asked (documents and their customers and vendors, payments and what they settle, the journal
 * entries each one posted, the accounts and projects on their lines, loans, fixed assets and the
 * alerts that point at them), so it can never drift from the ledger. Each edge carries a sentence
 * explaining it. Row-level security limits every query to the organisation.
 */
@Injectable()
export class GraphService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
  ) {}

  private async money(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    const scale = minorUnits(o.functionalCurrency);
    return (x: Prisma.Decimal | string | number | null | undefined, currency = o.functionalCurrency) => formatAmountText(dec(x).toFixed(currency === o.functionalCurrency ? scale : minorUnits(currency)), currency);
  }

  // ------------------------------------------------------------------ nodes

  private contactNode(c: { id: string; name: string; isCustomer: boolean; isVendor: boolean }): GraphNode {
    const role = c.isCustomer && c.isVendor ? 'Customer and vendor' : c.isCustomer ? 'Customer' : c.isVendor ? 'Vendor' : 'Contact';
    return { type: 'CONTACT', id: c.id, label: c.name, subtitle: role, path: c.isCustomer || !c.isVendor ? `/sales/customers/${c.id}` : `/purchases/vendors/${c.id}` };
  }
  private docNode(d: { id: string; kind: string; number: string | null; status: string; issueDate: Date }, m: (x: Prisma.Decimal) => string, total: Prisma.Decimal, currency: string): GraphNode {
    return { type: 'DOCUMENT', id: d.id, label: d.number ?? `Draft ${DOC_LABEL[d.kind]!.toLowerCase()}`, subtitle: `${DOC_LABEL[d.kind]}, ${formatDateText(fromDbDate(d.issueDate))}, ${formatAmountText(total.toFixed(minorUnits(currency)), currency)}${d.status === 'POSTED' ? '' : `, ${d.status.toLowerCase()}`}`, path: docPath(d.kind, d.id) };
  }
  private payNode(p: { id: string; kind: string; number: string; status: string; date: Date; amount: Prisma.Decimal; currency: string }): GraphNode {
    return { type: 'PAYMENT', id: p.id, label: p.number, subtitle: `${p.kind === 'RECEIPT' ? 'Receipt' : 'Payment'}, ${formatDateText(fromDbDate(p.date))}, ${formatAmountText(p.amount.toFixed(minorUnits(p.currency)), p.currency)}${p.status === 'POSTED' ? '' : `, ${p.status.toLowerCase()}`}`, path: payPath(p.kind, p.id) };
  }
  private jeNode(e: { id: string; entryNumber: number | null; date: Date; memo: string | null; source: string; status: string }): GraphNode {
    return { type: 'JOURNAL', id: e.id, label: je(e.entryNumber), subtitle: `${formatDateText(fromDbDate(e.date))}${e.memo ? `, ${e.memo}` : ''}${e.status === 'POSTED' ? '' : `, ${e.status.toLowerCase()}`}`, path: `/journals/${e.id}` };
  }
  private accountNode(a: { id: string; code: string; name: string; type: string }): GraphNode {
    return { type: 'ACCOUNT', id: a.id, label: `${a.code} ${a.name}`, subtitle: `${a.type.charAt(0)}${a.type.slice(1).toLowerCase()} account`, path: `/reports/general-ledger?accountId=${a.id}` };
  }
  private dimNode(v: { id: string; type: string; code: string; name: string }): GraphNode {
    return { type: v.type === 'PROJECT' ? 'PROJECT' : 'DEPARTMENT', id: v.id, label: `${v.code} ${v.name}`, subtitle: v.type === 'PROJECT' ? 'Project' : 'Department', path: `/reports/profit-by-dimension?type=${v.type}` };
  }
  private loanNode(l: { id: string; number: number; name: string; lender: string | null; status: string }): GraphNode {
    return { type: 'LOAN', id: l.id, label: `${pad4('LN', l.number)} ${l.name}`, subtitle: `Loan${l.lender ? ` from ${l.lender}` : ''}${l.status === 'ACTIVE' ? '' : `, ${l.status.toLowerCase()}`}`, path: `/loans/${l.id}` };
  }
  private assetNode(a: { id: string; number: number; name: string; status: string }): GraphNode {
    return { type: 'ASSET', id: a.id, label: `${pad4('FA', a.number)} ${a.name}`, subtitle: `Fixed asset${a.status === 'ACTIVE' ? '' : `, ${a.status.toLowerCase()}`}`, path: `/fixed-assets/${a.id}` };
  }
  private alertNode(a: { id: string; title: string; severity: string; status: string }): GraphNode {
    return { type: 'ALERT', id: a.id, label: a.title, subtitle: `${a.severity.charAt(0)}${a.severity.slice(1).toLowerCase()} alert, ${a.status.toLowerCase()}`, path: `/alerts` };
  }

  private async docTotals(orgId: string, ids: string[]) {
    if (!ids.length) return new Map<string, Prisma.Decimal>();
    const rows = await this.prisma.document.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, total: true } });
    return new Map(rows.map((r) => [r.id, r.total]));
  }
  /** Journal entries with the sums of their lines that match `line`, from MongoDB. */
  private async byEntry(orgId: string, entry: Record<string, unknown>, line: Record<string, unknown>) {
    const sums = await lineSums(this.store, orgId, { entry, line, by: { id: '_id', entryNumber: 'entryNumber', date: 'date', memo: 'memo', source: 'source', status: 'status' } });
    return sums.map((x) => ({
      id: x.key.id as string,
      entry_number: (x.key.entryNumber as number | null) ?? null,
      date: x.key.date as Date,
      memo: (x.key.memo as string | null) ?? null,
      source: x.key.source as string,
      status: x.key.status as string,
      debit: new Prisma.Decimal(x.debit.toFixed()),
      credit: new Prisma.Decimal(x.credit.toFixed()),
    }));
  }

  /** Alerts whose evidence points at one of these records. */
  private async alertsAbout(orgId: string, ids: string[]): Promise<GraphEdge[]> {
    if (!ids.length) return [];
    // An alert's evidence is free-form JSON, so it is searched as text, as the SQL did.
    const all = await this.prisma.alert.findMany({ where: { orgId }, orderBy: { lastSeenAt: 'desc' }, select: { id: true, title: true, severity: true, status: true, evidence: true } });
    const rows = all.filter((a) => {
      const text = JSON.stringify(a.evidence ?? null);
      return ids.some((id) => text.includes(id));
    }).slice(0, LIMIT);
    return rows.map((a) => ({ relation: 'FLAGGED_BY', explanation: `The alert "${a.title}" lists it as evidence (${a.status.toLowerCase()}).`, node: this.alertNode(a) }));
  }

  /** Where each journal entry came from: a document, payment, claim, payroll, asset, loan and so on. */
  async entrySources(orgId: string, entryIds: string[]): Promise<Map<string, EntrySource>> {
    const out = new Map<string, EntrySource>();
    if (!entryIds.length) return out;
    const p = this.prisma;
    const ids = { in: entryIds };
    const pad = (n: number) => String(n).padStart(4, '0');
    const docPath = (kind: string, id: string) => `${kind === 'INVOICE' || kind === 'CREDIT_NOTE' ? '/sales/invoices/' : '/purchases/bills/'}${id}`;
    const payPath = (kind: string, id: string) => `${kind === 'RECEIPT' ? '/sales/receipts/' : '/purchases/payments/'}${id}`;
    type Row = { entry_id: string | null; type: string; id: string; label: string; path: string | null; role: string };
    // In the order the sources are looked at: the first one found for an entry is the one shown.
    const sources: (() => Promise<Row[]>)[] = [
      async () => (await p.document.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, kind: true, number: true, journalEntryId: true } })).map((d) => ({ entry_id: d.journalEntryId, type: 'DOCUMENT', id: d.id, label: d.number ?? 'Draft', path: docPath(d.kind, d.id), role: 'posts' })),
      async () => (await p.document.findMany({ where: { orgId, voidJournalEntryId: ids }, select: { id: true, kind: true, number: true, voidJournalEntryId: true } })).map((d) => ({ entry_id: d.voidJournalEntryId, type: 'DOCUMENT', id: d.id, label: d.number ?? 'Draft', path: docPath(d.kind, d.id), role: 'voids' })),
      async () => (await p.payment.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, kind: true, number: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'PAYMENT', id: x.id, label: x.number, path: payPath(x.kind, x.id), role: 'posts' })),
      async () => (await p.payment.findMany({ where: { orgId, voidJournalEntryId: ids }, select: { id: true, kind: true, number: true, voidJournalEntryId: true } })).map((x) => ({ entry_id: x.voidJournalEntryId, type: 'PAYMENT', id: x.id, label: x.number, path: payPath(x.kind, x.id), role: 'voids' })),
      async () => (await p.expenseClaim.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, number: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `Expense claim ${x.number}`, path: `/expenses/${x.id}`, role: 'posts' })),
      async () => (await p.expenseClaim.findMany({ where: { orgId, reimbursementJournalEntryId: ids }, select: { id: true, number: true, reimbursementJournalEntryId: true } })).map((x) => ({ entry_id: x.reimbursementJournalEntryId, type: 'SOURCE', id: x.id, label: `Expense claim ${x.number}`, path: `/expenses/${x.id}`, role: 'pays back' })),
      async () => (await p.expenseClaim.findMany({ where: { orgId, voidJournalEntryId: ids }, select: { id: true, number: true, voidJournalEntryId: true } })).map((x) => ({ entry_id: x.voidJournalEntryId, type: 'SOURCE', id: x.id, label: `Expense claim ${x.number}`, path: `/expenses/${x.id}`, role: 'voids' })),
      async () => (await p.withholdingDeposit.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, number: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `TDS/TCS deposit ${x.number}`, path: '/tax/tds-tcs', role: 'posts' })),
      async () => (await p.payRun.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, number: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `Pay run ${x.number}`, path: `/payroll/runs/${x.id}`, role: 'posts' })),
      async () => (await p.payRun.findMany({ where: { orgId, voidJournalEntryId: ids }, select: { id: true, number: true, voidJournalEntryId: true } })).map((x) => ({ entry_id: x.voidJournalEntryId, type: 'SOURCE', id: x.id, label: `Pay run ${x.number}`, path: `/payroll/runs/${x.id}`, role: 'voids' })),
      async () => (await p.payrollRemittance.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, number: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `Payroll remittance ${x.number}`, path: '/payroll/runs', role: 'posts' })),
      async () => (await p.fixedAsset.findMany({ where: { orgId, acquisitionEntryId: ids }, select: { id: true, number: true, name: true, acquisitionEntryId: true } })).map((x) => ({ entry_id: x.acquisitionEntryId, type: 'ASSET', id: x.id, label: `FA-${pad(x.number)} ${x.name}`, path: `/fixed-assets/${x.id}`, role: 'records the purchase of' })),
      async () => (await p.fixedAsset.findMany({ where: { orgId, disposalEntryId: ids }, select: { id: true, number: true, name: true, disposalEntryId: true } })).map((x) => ({ entry_id: x.disposalEntryId, type: 'ASSET', id: x.id, label: `FA-${pad(x.number)} ${x.name}`, path: `/fixed-assets/${x.id}`, role: 'disposes of' })),
      async () => (await p.depreciationRun.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, month: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `Depreciation for ${x.month}`, path: '/fixed-assets/depreciation', role: 'posts' })),
      async () => (await p.depreciationRun.findMany({ where: { orgId, reversalEntryId: ids }, select: { id: true, month: true, reversalEntryId: true } })).map((x) => ({ entry_id: x.reversalEntryId, type: 'SOURCE', id: x.id, label: `Depreciation for ${x.month}`, path: '/fixed-assets/depreciation', role: 'reverses' })),
      async () => (await p.deferralSchedule.findMany({ where: { orgId, initialEntryId: ids }, select: { id: true, number: true, name: true, initialEntryId: true } })).map((x) => ({ entry_id: x.initialEntryId, type: 'SOURCE', id: x.id, label: `Schedule ${x.number} ${x.name}`, path: `/deferrals/${x.id}`, role: 'records' })),
      async () => (await p.deferralRun.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, month: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: `Deferral releases for ${x.month}`, path: '/deferrals/releases', role: 'posts' })),
      async () => (await p.accrual.findMany({ where: { orgId, entryId: ids }, select: { id: true, number: true, description: true, entryId: true } })).map((x) => ({ entry_id: x.entryId, type: 'SOURCE', id: x.id, label: `Accrual AC-${pad(x.number)} ${x.description}`, path: '/accruals', role: 'posts' })),
      async () => (await p.accrual.findMany({ where: { orgId, reversalEntryId: ids }, select: { id: true, number: true, description: true, reversalEntryId: true } })).map((x) => ({ entry_id: x.reversalEntryId, type: 'SOURCE', id: x.id, label: `Accrual AC-${pad(x.number)} ${x.description}`, path: '/accruals', role: 'reverses' })),
      async () => (await p.loan.findMany({ where: { orgId, disbursementEntryId: ids }, select: { id: true, number: true, name: true, disbursementEntryId: true } })).map((x) => ({ entry_id: x.disbursementEntryId, type: 'LOAN', id: x.id, label: `LN-${pad(x.number)} ${x.name}`, path: `/loans/${x.id}`, role: 'disburses' })),
      async () =>
        (await p.loanEvent.findMany({ where: { orgId, entryId: ids }, select: { entryId: true, kind: true, loan: { select: { id: true, number: true, name: true } } } })).map((x) => ({
          entry_id: x.entryId,
          type: 'LOAN',
          id: x.loan.id,
          label: `LN-${pad(x.loan.number)} ${x.loan.name}`,
          path: `/loans/${x.loan.id}`,
          role: `records a ${String(x.kind).replace(/_/g, ' ').toLowerCase()} on`,
        })),
      async () => (await p.closeAdjustment.findMany({ where: { orgId, journalEntryId: ids }, select: { id: true, journalEntryId: true } })).map((x) => ({ entry_id: x.journalEntryId, type: 'SOURCE', id: x.id, label: 'Month-end adjustment', path: '/close', role: 'posts' })),
      async () => (await p.intercompanyTransaction.findMany({ where: { fromOrgId: orgId, fromEntryId: ids }, select: { id: true, number: true, description: true, groupId: true, fromEntryId: true } })).map((x) => ({ entry_id: x.fromEntryId, type: 'SOURCE', id: x.id, label: `IC-${pad(x.number)} ${x.description}`, path: `/consolidation/${x.groupId}`, role: 'posts' })),
      async () => (await p.intercompanyTransaction.findMany({ where: { toOrgId: orgId, toEntryId: ids }, select: { id: true, number: true, description: true, groupId: true, toEntryId: true } })).map((x) => ({ entry_id: x.toEntryId, type: 'SOURCE', id: x.id, label: `IC-${pad(x.number)} ${x.description}`, path: `/consolidation/${x.groupId}`, role: 'posts' })),
    ];
    const rows: Row[] = [];
    for (const q of sources) rows.push(...(await q()));
    for (const r of rows) if (r.entry_id && !out.has(r.entry_id)) out.set(r.entry_id, { type: r.type as EntrySource['type'], id: r.id, label: r.label, path: r.path, role: r.role });
    // Reversals of manual entries point at the entry they reverse.
    const missing = entryIds.filter((id) => !out.has(id));
    if (missing.length) {
      const rev = await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: missing }, reversesEntryId: { not: null } }, include: { reverses: { select: { id: true, entryNumber: true } } } });
      for (const r of rev) if (r.reverses) out.set(r.id, { type: 'JOURNAL', id: r.reverses.id, label: je(r.reverses.entryNumber), path: `/journals/${r.reverses.id}`, role: 'reverses' });
    }
    return out;
  }

  // ------------------------------------------------------------------ search

  /** Records whose name or number matches, to start exploring from. */
  async search(orgId: string, q: string): Promise<GraphNode[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const like = { contains: term, mode: 'insensitive' as const };
    const num = /^je-?0*(\d+)$/i.exec(term)?.[1] ?? (/^\d+$/.test(term) ? term : null);
    const [contacts, docs, pays, journals, accounts, dims, loans, assets] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId, name: like }, take: 8, orderBy: { name: 'asc' } }),
      this.prisma.document.findMany({ where: { orgId, OR: [{ number: like }, { reference: like }] }, take: 8, orderBy: { issueDate: 'desc' } }),
      this.prisma.payment.findMany({ where: { orgId, OR: [{ number: like }, { reference: like }] }, orderBy: { date: 'desc' }, take: 8, select: { id: true, kind: true, number: true, status: true, date: true, amount: true, currency: true } }),
      this.prisma.journalEntry.findMany({ where: { orgId, OR: [...(num ? [{ entryNumber: Number(num) }] : []), { memo: like }, { reference: like }] }, take: 8, orderBy: { date: 'desc' } }),
      this.prisma.account.findMany({ where: { orgId, OR: [{ code: { startsWith: term } }, { name: like }] }, take: 8, orderBy: { code: 'asc' } }),
      this.prisma.dimensionValue.findMany({ where: { orgId, OR: [{ code: like }, { name: like }] }, take: 8, orderBy: { code: 'asc' } }),
      this.prisma.loan.findMany({ where: { orgId, OR: [{ name: like }, { lender: like }] }, take: 5 }),
      this.prisma.fixedAsset.findMany({ where: { orgId, name: like }, take: 5 }),
    ]);
    return [
      ...contacts.map((c) => this.contactNode(c)),
      ...docs.map((d) => this.docNode(d, () => '', d.total, d.currency)),
      ...pays.map((p) => this.payNode(p)),
      ...journals.map((e) => this.jeNode(e)),
      ...accounts.map((a) => this.accountNode(a)),
      ...dims.map((v) => this.dimNode(v)),
      ...loans.map((l) => this.loanNode(l)),
      ...assets.map((a) => this.assetNode(a)),
    ];
  }

  // ------------------------------------------------------------------ neighbourhoods

  /** One record and everything directly connected to it, each connection explained. */
  async neighbourhood(orgId: string, type: GraphNodeType, id: string): Promise<{ node: GraphNode; edges: GraphEdge[]; more: { relation: string; count: number }[] }> {
    const r = await this.build(orgId, type, id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'That record does not exist in this organisation' });
    // Group, cap each relation at LIMIT and say how many more there are.
    const byRelation = new Map<string, GraphEdge[]>();
    for (const e of r.edges) byRelation.set(e.relation, [...(byRelation.get(e.relation) ?? []), e]);
    const edges: GraphEdge[] = [];
    const more: { relation: string; count: number }[] = [...(r.more ?? [])];
    for (const [relation, list] of byRelation) {
      edges.push(...list.slice(0, LIMIT));
      if (list.length > LIMIT) more.push({ relation, count: list.length - LIMIT });
    }
    return { node: r.node, edges, more };
  }

  private async build(orgId: string, type: GraphNodeType, id: string): Promise<{ node: GraphNode; edges: GraphEdge[]; more?: { relation: string; count: number }[] } | null> {
    const m = await this.money(orgId);
    switch (type) {
      case 'CONTACT': {
        const c = await this.prisma.contact.findFirst({ where: { orgId, id } });
        if (!c) return null;
        const node = this.contactNode(c);
        const docs = await this.prisma.document.findMany({ where: { orgId, contactId: id }, orderBy: [{ issueDate: 'desc' }, { number: 'desc' }], take: LIMIT + 1 });
        const docCount = await this.prisma.document.count({ where: { orgId, contactId: id } });
        const pays = await this.prisma.payment.findMany({ where: { orgId, contactId: id }, orderBy: { date: 'desc' }, take: LIMIT, select: { id: true, kind: true, number: true, status: true, date: true, amount: true, currency: true } });
        const tagged = await this.prisma.documentLine.findMany({ where: { orgId, document: { contactId: id, status: 'POSTED' } }, select: { netAmount: true, projectId: true, departmentId: true } });
        const perDim = new Map<string, { lines: number; amount: Prisma.Decimal }>();
        for (const l of tagged)
          for (const v of new Set([l.projectId, l.departmentId])) {
            if (!v) continue;
            const t = perDim.get(v) ?? { lines: 0, amount: new Prisma.Decimal(0) };
            perDim.set(v, { lines: t.lines + 1, amount: t.amount.plus(l.netAmount) });
          }
        const dimValues = perDim.size ? await this.prisma.dimensionValue.findMany({ where: { orgId, id: { in: [...perDim.keys()] } }, orderBy: [{ type: 'desc' }, { code: 'asc' }], select: { id: true, type: true, code: true, name: true } }) : [];
        const dims = dimValues.map((v) => ({ ...v, ...perDim.get(v.id)! }));
        const edges: GraphEdge[] = [
          ...docs.slice(0, LIMIT).map((d) => ({
            relation: d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE' ? 'ISSUED_TO' : 'RECEIVED_FROM',
            explanation: d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE' ? `${DOC_LABEL[d.kind]} ${d.number ?? '(draft)'} for ${m(d.total, d.currency)} was issued to ${c.name}.` : `${DOC_LABEL[d.kind]} ${d.number ?? '(draft)'} for ${m(d.total, d.currency)} was received from ${c.name}.`,
            node: this.docNode(d, () => '', d.total, d.currency),
          })),
          ...pays.map((p) => ({ relation: p.kind === 'RECEIPT' ? 'PAID_BY' : 'PAID_TO', explanation: p.kind === 'RECEIPT' ? `${c.name} paid ${m(p.amount, p.currency)} (${p.number}) on ${formatDateText(fromDbDate(p.date))}.` : `${m(p.amount, p.currency)} was paid to ${c.name} (${p.number}) on ${formatDateText(fromDbDate(p.date))}.`, node: this.payNode(p) })),
          ...dims.map((v) => ({ relation: v.type === 'PROJECT' ? 'WORKS_ON' : 'SERVED_BY', explanation: `${v.lines} line${v.lines === 1 ? '' : 's'} on ${c.name}'s posted documents, ${m(v.amount)} before tax, ${v.lines === 1 ? 'is' : 'are'} tagged with ${v.type === 'PROJECT' ? 'project' : 'department'} ${v.code}.`, node: this.dimNode(v) })),
          ...(await this.alertsAbout(orgId, [id, ...docs.map((d) => d.id)])),
        ];
        return { node, edges, more: docCount > LIMIT ? [{ relation: docs[0]?.kind === 'BILL' ? 'RECEIVED_FROM' : 'ISSUED_TO', count: docCount - LIMIT }] : [] };
      }
      case 'DOCUMENT': {
        const d = await this.prisma.document.findFirst({ where: { orgId, id }, include: { contact: true, lines: { include: { account: true } } } });
        if (!d) return null;
        const node = this.docNode(d, () => '', d.total, d.currency);
        const label = `${DOC_LABEL[d.kind]} ${d.number ?? '(draft)'}`;
        const sales = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE';
        const entries = await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: [d.journalEntryId, d.voidJournalEntryId].filter((x): x is string => !!x) } } });
        const settledBy = await this.prisma.allocation.findMany({ where: { orgId, targetId: id, removedOn: null }, include: { payment: true, creditDocument: true } });
        const settles = await this.prisma.allocation.findMany({ where: { orgId, creditDocumentId: id, removedOn: null }, include: { target: true } });
        const byAccount = new Map<string, { a: (typeof d.lines)[number]['account']; amount: InstanceType<typeof D> }>();
        for (const l of d.lines) {
          const x = byAccount.get(l.accountId) ?? { a: l.account, amount: new D(0) };
          x.amount = x.amount.plus(dec(l.netAmount));
          byAccount.set(l.accountId, x);
        }
        const dimIds = [...new Set(d.lines.flatMap((l) => [l.projectId, l.departmentId]).filter((x): x is string => !!x))];
        const dims = dimIds.length ? await this.prisma.dimensionValue.findMany({ where: { orgId, id: { in: dimIds } } }) : [];
        const edges: GraphEdge[] = [
          { relation: sales ? 'ISSUED_TO' : 'RECEIVED_FROM', explanation: sales ? `${label} was issued to ${d.contact.name}.` : `${label} was received from ${d.contact.name}.`, node: this.contactNode(d.contact) },
          ...entries.map((e) => ({ relation: e.id === d.journalEntryId ? 'POSTED_BY' : 'VOIDED_BY', explanation: e.id === d.journalEntryId ? `${je(e.entryNumber)} put ${label} into the ledger on ${formatDateText(fromDbDate(e.date))}.` : `${je(e.entryNumber)} reversed ${label} when it was voided.`, node: this.jeNode(e) })),
          // Bad-debt write-offs are explained by their BAD_DEBT journal, not as a settling document.
          ...settledBy.filter((a) => a.payment || a.creditDocument).map((a) =>
            a.payment
              ? { relation: 'SETTLED_BY', explanation: `${a.payment.number} settled ${m(a.amount, d.currency)} of ${label} on ${formatDateText(fromDbDate(a.date))}.`, node: this.payNode(a.payment) }
              : { relation: 'SETTLED_BY', explanation: `${DOC_LABEL[a.creditDocument!.kind]} ${a.creditDocument!.number} took ${m(a.amount, d.currency)} off ${label} on ${formatDateText(fromDbDate(a.date))}.`, node: this.docNode(a.creditDocument!, () => '', a.creditDocument!.total, a.creditDocument!.currency) },
          ),
          ...settles.map((a) => ({ relation: 'SETTLES', explanation: `${label} took ${m(a.amount, d.currency)} off ${DOC_LABEL[a.target.kind]} ${a.target.number} on ${formatDateText(fromDbDate(a.date))}.`, node: this.docNode(a.target, () => '', a.target.total, a.target.currency) })),
          ...[...byAccount.values()].map(({ a, amount }) => ({ relation: 'BOOKED_TO', explanation: `${m(amount, d.currency)} of its lines, before tax, ${sales ? 'is income in' : 'is booked to'} ${a.code} ${a.name}.`, node: this.accountNode(a) })),
          ...dims.map((v) => {
            const lines = d.lines.filter((l) => l.projectId === v.id || l.departmentId === v.id);
            return { relation: v.type === 'PROJECT' ? 'FOR_PROJECT' : 'FOR_DEPARTMENT', explanation: `${lines.length} line${lines.length === 1 ? '' : 's'} (${m(lines.reduce((t, l) => t.plus(dec(l.netAmount)), new D(0)), d.currency)}) ${lines.length === 1 ? 'is' : 'are'} tagged with ${v.type === 'PROJECT' ? 'project' : 'department'} ${v.code}.`, node: this.dimNode(v) };
          }),
          ...(await this.alertsAbout(orgId, [id])),
        ];
        return { node, edges };
      }
      case 'PAYMENT': {
        const p = await this.prisma.payment.findFirst({ where: { orgId, id }, include: { contact: true, bankAccount: true, allocations: { where: { removedOn: null }, include: { target: true } } } });
        if (!p) return null;
        const node = this.payNode(p);
        const entries = await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: [p.journalEntryId, p.voidJournalEntryId].filter((x): x is string => !!x) } } });
        const receipt = p.kind === 'RECEIPT';
        const edges: GraphEdge[] = [
          { relation: receipt ? 'PAID_BY' : 'PAID_TO', explanation: receipt ? `${p.contact.name} paid ${p.number}.` : `${p.number} was paid to ${p.contact.name}.`, node: this.contactNode(p.contact) },
          { relation: receipt ? 'DEPOSITED_TO' : 'PAID_FROM', explanation: receipt ? `The money went into ${p.bankAccount.code} ${p.bankAccount.name}.` : `The money came out of ${p.bankAccount.code} ${p.bankAccount.name}.`, node: this.accountNode(p.bankAccount) },
          ...entries.map((e) => ({ relation: e.id === p.journalEntryId ? 'POSTED_BY' : 'VOIDED_BY', explanation: e.id === p.journalEntryId ? `${je(e.entryNumber)} recorded ${p.number} in the ledger.` : `${je(e.entryNumber)} reversed ${p.number} when it was voided.`, node: this.jeNode(e) })),
          ...p.allocations.map((a) => ({ relation: 'SETTLES', explanation: `${m(a.amount, p.currency)} of ${p.number} settled ${DOC_LABEL[a.target.kind]} ${a.target.number}.`, node: this.docNode(a.target, () => '', a.target.total, a.target.currency) })),
          ...(await this.alertsAbout(orgId, [id])),
        ];
        return { node, edges };
      }
      case 'JOURNAL': {
        const e = await this.prisma.journalEntry.findFirst({ where: { orgId, id }, include: { lines: { include: { account: true } }, reverses: true, reversedBy: true } });
        if (!e) return null;
        const node = this.jeNode(e);
        const src = (await this.entrySources(orgId, [id])).get(id);
        const dimIds = [...new Set(e.lines.flatMap((l) => [l.projectId, l.departmentId]).filter((x): x is string => !!x))];
        const dims = dimIds.length ? await this.prisma.dimensionValue.findMany({ where: { orgId, id: { in: dimIds } } }) : [];
        const byAccount = new Map<string, { a: (typeof e.lines)[number]['account']; debit: InstanceType<typeof D>; credit: InstanceType<typeof D> }>();
        for (const l of e.lines) {
          const x = byAccount.get(l.accountId) ?? { a: l.account, debit: new D(0), credit: new D(0) };
          x.debit = x.debit.plus(dec(l.functionalDebit));
          x.credit = x.credit.plus(dec(l.functionalCredit));
          byAccount.set(l.accountId, x);
        }
        const srcEdge = async (): Promise<GraphEdge[]> => {
          if (!src) return e.source === 'MANUAL' ? [] : [];
          const n = src.type === 'DOCUMENT' ? (await this.build(orgId, 'DOCUMENT', src.id))!.node : src.type === 'PAYMENT' ? (await this.build(orgId, 'PAYMENT', src.id))!.node : { type: src.type, id: src.id, label: src.label, subtitle: null, path: src.path };
          return [{ relation: 'CREATED_BY', explanation: `${je(e.entryNumber)} ${src.role} ${src.label}.`, node: n }];
        };
        const edges: GraphEdge[] = [
          ...(await srcEdge()),
          ...[...byAccount.values()].map(({ a, debit, credit }) => {
            const net = debit.minus(credit);
            return { relation: net.isNegative() ? 'CREDITS' : 'DEBITS', explanation: `${net.isNegative() ? 'Credits' : 'Debits'} ${a.code} ${a.name} with ${m(net.abs())}.`, node: this.accountNode(a) };
          }),
          ...(e.reverses ? [{ relation: 'REVERSES', explanation: `${je(e.entryNumber)} reverses ${je(e.reverses.entryNumber)}.`, node: this.jeNode(e.reverses) }] : []),
          ...(e.reversedBy ? [{ relation: 'REVERSED_BY', explanation: `${je(e.reversedBy.entryNumber)} reverses ${je(e.entryNumber)}.`, node: this.jeNode(e.reversedBy) }] : []),
          ...dims.map((v) => ({ relation: v.type === 'PROJECT' ? 'FOR_PROJECT' : 'FOR_DEPARTMENT', explanation: `Lines of ${je(e.entryNumber)} are tagged with ${v.type === 'PROJECT' ? 'project' : 'department'} ${v.code}.`, node: this.dimNode(v) })),
          ...(await this.alertsAbout(orgId, [id])),
        ];
        return { node, edges };
      }
      case 'ACCOUNT': {
        const a = await this.prisma.account.findFirst({ where: { orgId, id } });
        if (!a) return null;
        const node = this.accountNode(a);
        const total = await this.prisma.journalLine.count({ where: { orgId, accountId: id, entry: { status: 'POSTED' } } });
        const lines = (await this.byEntry(orgId, { status: 'POSTED' }, { accountId: id }))
          .sort((a, b) => b.date.getTime() - a.date.getTime() || (b.entry_number ?? -1) - (a.entry_number ?? -1))
          .slice(0, LIMIT);
        const [loans, assets] = await Promise.all([
          this.prisma.loan.findMany({ where: { orgId, OR: [{ liabilityAccountId: id }, { interestAccountId: id }, { bankAccountId: id }] } }),
          this.prisma.fixedAsset.findMany({ where: { orgId, OR: [{ assetAccountId: id }, { accumulatedAccountId: id }, { expenseAccountId: id }] }, take: LIMIT }),
        ]);
        const edges: GraphEdge[] = [
          ...lines.map((l) => {
            const net = dec(l.debit).minus(dec(l.credit));
            return { relation: 'POSTED_IN', explanation: `${je(l.entry_number)} on ${formatDateText(fromDbDate(l.date))} ${net.isNegative() ? 'credits' : 'debits'} it with ${m(net.abs())}.`, node: this.jeNode({ id: l.id, entryNumber: l.entry_number, date: l.date, memo: l.memo, source: l.source, status: l.status }) };
          }),
          ...loans.map((l) => ({ relation: 'USED_BY_LOAN', explanation: `${pad4('LN', l.number)} uses it as its ${l.liabilityAccountId === id ? 'liability' : l.interestAccountId === id ? 'interest' : 'bank'} account.`, node: this.loanNode(l) })),
          ...assets.map((x) => ({ relation: 'USED_BY_ASSET', explanation: `${pad4('FA', x.number)} uses it as its ${x.assetAccountId === id ? 'asset' : x.accumulatedAccountId === id ? 'accumulated depreciation' : 'depreciation expense'} account.`, node: this.assetNode(x) })),
        ];
        const entries = new Set(lines.map((l) => l.id)).size;
        return { node, edges, more: total > entries && lines.length === LIMIT ? [{ relation: 'POSTED_IN', count: total - LIMIT }] : [] };
      }
      case 'PROJECT':
      case 'DEPARTMENT': {
        const v = await this.prisma.dimensionValue.findFirst({ where: { orgId, id, type: type } });
        if (!v) return null;
        const node = this.dimNode(v);
        const col = type === 'PROJECT' ? 'projectId' : 'departmentId';
        const own = await this.prisma.documentLine.findMany({ where: { orgId, [col]: id }, select: { documentId: true, netAmount: true } });
        const perDoc = new Map<string, { lines: number; amount: Prisma.Decimal }>();
        for (const l of own) {
          const t = perDoc.get(l.documentId) ?? { lines: 0, amount: new Prisma.Decimal(0) };
          perDoc.set(l.documentId, { lines: t.lines + 1, amount: t.amount.plus(l.netAmount) });
        }
        const docRows = perDoc.size
          ? await this.prisma.document.findMany({ where: { orgId, id: { in: [...perDoc.keys()] } }, orderBy: { issueDate: 'desc' }, take: LIMIT + 1, select: { id: true, kind: true, number: true, status: true, issueDate: true, total: true, currency: true, contactId: true } })
          : [];
        const docs = docRows.map((d) => ({ id: d.id, kind: d.kind as string, number: d.number, status: d.status as string, issue_date: d.issueDate, total: d.total, currency: d.currency, contact_id: d.contactId, ...perDoc.get(d.id)! }));
        const journals = (await this.byEntry(orgId, { status: 'POSTED', source: { $nin: ['DOCUMENT', 'PAYMENT'] } }, { [col]: id }))
          .sort((a, b) => b.date.getTime() - a.date.getTime())
          .slice(0, LIMIT)
          .map((e) => ({ ...e, amount: e.debit.plus(e.credit) }));
        const contactIds = [...new Set(docs.map((d) => d.contact_id))];
        const contacts = contactIds.length ? await this.prisma.contact.findMany({ where: { orgId, id: { in: contactIds } } }) : [];
        const what = type === 'PROJECT' ? 'project' : 'department';
        const edges: GraphEdge[] = [
          ...contacts.map((c) => {
            const mine = docs.filter((d) => d.contact_id === c.id);
            return { relation: type === 'PROJECT' ? 'WORKS_ON' : 'SERVED_BY', explanation: `${mine.length} of ${c.name}'s documents ${mine.length === 1 ? 'has' : 'have'} lines tagged with this ${what}.`, node: this.contactNode(c) };
          }),
          ...docs.slice(0, LIMIT).map((d) => ({ relation: type === 'PROJECT' ? 'FOR_PROJECT' : 'FOR_DEPARTMENT', explanation: `${d.lines} line${d.lines === 1 ? '' : 's'} of ${DOC_LABEL[d.kind]} ${d.number ?? '(draft)'} (${m(d.amount, d.currency)} before tax) ${d.lines === 1 ? 'is' : 'are'} tagged with this ${what}.`, node: this.docNode({ id: d.id, kind: d.kind, number: d.number, status: d.status, issueDate: d.issue_date }, () => '', d.total, d.currency) })),
          ...journals.map((e) => ({ relation: 'TAGGED_IN', explanation: `Journal lines of ${je(e.entry_number)} are tagged with this ${what}.`, node: this.jeNode({ id: e.id, entryNumber: e.entry_number, date: e.date, memo: e.memo, source: e.source, status: e.status }) })),
        ];
        return { node, edges, more: docs.length > LIMIT ? [{ relation: type === 'PROJECT' ? 'FOR_PROJECT' : 'FOR_DEPARTMENT', count: docs.length - LIMIT }] : [] };
      }
      case 'LOAN': {
        const l = await this.prisma.loan.findFirst({ where: { orgId, id } });
        if (!l) return null;
        const node = this.loanNode(l);
        const accounts = await this.prisma.account.findMany({ where: { orgId, id: { in: [l.liabilityAccountId, l.interestAccountId, l.bankAccountId] } } });
        const events = await this.prisma.loanEvent.findMany({ where: { orgId, loanId: id, entryId: { not: null } }, orderBy: { date: 'desc' }, take: LIMIT });
        const entryIds = [l.disbursementEntryId, ...events.map((e) => e.entryId)].filter((x): x is string => !!x);
        const entries = await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: entryIds } } });
        const role = (a: string) => (a === l.liabilityAccountId ? 'owed on' : a === l.interestAccountId ? 'interest is charged to' : 'paid through');
        const edges: GraphEdge[] = [
          ...accounts.map((a) => ({ relation: 'USES_ACCOUNT', explanation: `The loan is ${role(a.id)} ${a.code} ${a.name}.`, node: this.accountNode(a) })),
          ...entries.map((e) => {
            const ev = events.find((x) => x.entryId === e.id);
            return { relation: 'POSTED_BY', explanation: ev ? `${je(e.entryNumber)} records a ${ev.kind.toLowerCase().replace(/_/g, ' ')} on ${formatDateText(fromDbDate(e.date))}.` : `${je(e.entryNumber)} records the disbursement.`, node: this.jeNode(e) };
          }),
        ];
        return { node, edges };
      }
      case 'ASSET': {
        const x = await this.prisma.fixedAsset.findFirst({ where: { orgId, id } });
        if (!x) return null;
        const node = this.assetNode(x);
        const accounts = await this.prisma.account.findMany({ where: { orgId, id: { in: [x.assetAccountId, x.accumulatedAccountId, x.expenseAccountId] } } });
        const entries = await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: [x.acquisitionEntryId, x.disposalEntryId].filter((y): y is string => !!y) } } });
        const depLines = await this.prisma.depreciationLine.findMany({ where: { orgId, assetId: id, run: { status: 'POSTED' } }, select: { amount: true, run: { select: { month: true, journalEntryId: true } } } });
        depLines.sort((a, b) => (a.run.month < b.run.month ? 1 : a.run.month > b.run.month ? -1 : 0));
        const runEntries = new Map((await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: depLines.map((l) => l.run.journalEntryId).filter((y): y is string => !!y) } } })).map((e) => [e.id, e]));
        const runs = depLines
          .filter((l) => l.run.journalEntryId && runEntries.has(l.run.journalEntryId))
          .slice(0, LIMIT)
          .map((l) => {
            const e = runEntries.get(l.run.journalEntryId!)!;
            return { id: e.id, entry_number: e.entryNumber, date: e.date, memo: e.memo, source: e.source as string, status: e.status as string, amount: l.amount, month: l.run.month };
          });
        const role = (a: string) => (a === x.assetAccountId ? 'Its cost is held in' : a === x.accumulatedAccountId ? 'Its accumulated depreciation is held in' : 'Its depreciation is charged to');
        const edges: GraphEdge[] = [
          ...accounts.map((a) => ({ relation: 'USES_ACCOUNT', explanation: `${role(a.id)} ${a.code} ${a.name}.`, node: this.accountNode(a) })),
          ...entries.map((e) => ({ relation: 'POSTED_BY', explanation: e.id === x.acquisitionEntryId ? `${je(e.entryNumber)} records its purchase.` : `${je(e.entryNumber)} records its disposal.`, node: this.jeNode(e) })),
          ...runs.map((r) => ({ relation: 'DEPRECIATED_IN', explanation: `${je(r.entry_number)} charges ${m(r.amount)} of depreciation for ${r.month}.`, node: this.jeNode({ id: r.id, entryNumber: r.entry_number, date: r.date, memo: r.memo, source: r.source, status: r.status }) })),
        ];
        return { node, edges };
      }
      case 'ALERT': {
        const a = await this.prisma.alert.findFirst({ where: { orgId, id } });
        if (!a) return null;
        const node = this.alertNode(a);
        const ev = a.evidence as { rows?: { items?: { link?: { kind: string; id: string } }[] }; links?: { kind: string; id?: string }[] };
        const links = [...(ev.rows?.items ?? []).map((i) => i.link), ...(ev.links ?? [])].filter((l): l is { kind: string; id: string } => !!l && typeof l.id === 'string');
        const kindType: Record<string, GraphNodeType> = { INVOICE: 'DOCUMENT', BILL: 'DOCUMENT', PAYMENT: 'PAYMENT', JOURNAL: 'JOURNAL', CUSTOMER: 'CONTACT', VENDOR: 'CONTACT' };
        const edges: GraphEdge[] = [];
        const seen = new Set<string>();
        for (const l of links) {
          const t = kindType[l.kind];
          if (!t || seen.has(l.id) || edges.length >= LIMIT) continue;
          seen.add(l.id);
          const n = await this.build(orgId, t, l.id);
          if (n) edges.push({ relation: 'EVIDENCE', explanation: `The alert lists ${n.node.label} as evidence.`, node: n.node });
        }
        return { node, edges };
      }
    }
  }

}
