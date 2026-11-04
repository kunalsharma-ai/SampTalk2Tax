import { Injectable, NotFoundException } from '@nestjs/common';
import { D, formatAmountText, formatDateText, minorUnits } from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { fromDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
  /** Alerts whose evidence points at one of these records. */
  private async alertsAbout(orgId: string, ids: string[]): Promise<GraphEdge[]> {
    if (!ids.length) return [];
    const patterns = ids.map((id) => `%${id}%`);
    const rows = await this.prisma.$queryRaw<{ id: string; title: string; severity: string; status: string }[]>`
      SELECT id, title, severity::text AS severity, status::text AS status FROM alerts
      WHERE org_id = ${orgId}::uuid AND evidence::text LIKE ANY(${patterns}::text[]) ORDER BY last_seen_at DESC LIMIT ${LIMIT}`;
    return rows.map((a) => ({ relation: 'FLAGGED_BY', explanation: `The alert "${a.title}" lists it as evidence (${a.status.toLowerCase()}).`, node: this.alertNode(a) }));
  }

  /** Where each journal entry came from: a document, payment, claim, payroll, asset, loan and so on. */
  async entrySources(orgId: string, entryIds: string[]): Promise<Map<string, EntrySource>> {
    const out = new Map<string, EntrySource>();
    if (!entryIds.length) return out;
    const rows = await this.prisma.$queryRaw<{ entry_id: string; type: string; id: string; label: string; path: string | null; role: string }[]>`
      WITH e(id) AS (SELECT unnest(${entryIds}::uuid[]))
      SELECT d.journal_entry_id AS entry_id, 'DOCUMENT' AS type, d.id, COALESCE(d.number, 'Draft') AS label, CASE WHEN d.kind IN ('INVOICE','CREDIT_NOTE') THEN '/sales/invoices/' ELSE '/purchases/bills/' END || d.id AS path, 'posts' AS role FROM documents d WHERE d.org_id = ${orgId}::uuid AND d.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT d.void_journal_entry_id, 'DOCUMENT', d.id, COALESCE(d.number, 'Draft'), CASE WHEN d.kind IN ('INVOICE','CREDIT_NOTE') THEN '/sales/invoices/' ELSE '/purchases/bills/' END || d.id, 'voids' FROM documents d WHERE d.org_id = ${orgId}::uuid AND d.void_journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT p.journal_entry_id, 'PAYMENT', p.id, p.number, CASE WHEN p.kind = 'RECEIPT' THEN '/sales/receipts/' ELSE '/purchases/payments/' END || p.id, 'posts' FROM payments p WHERE p.org_id = ${orgId}::uuid AND p.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT p.void_journal_entry_id, 'PAYMENT', p.id, p.number, CASE WHEN p.kind = 'RECEIPT' THEN '/sales/receipts/' ELSE '/purchases/payments/' END || p.id, 'voids' FROM payments p WHERE p.org_id = ${orgId}::uuid AND p.void_journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Expense claim ' || x.number, '/expenses/' || x.id, 'posts' FROM expense_claims x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.reimbursement_journal_entry_id, 'SOURCE', x.id, 'Expense claim ' || x.number, '/expenses/' || x.id, 'pays back' FROM expense_claims x WHERE x.org_id = ${orgId}::uuid AND x.reimbursement_journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.void_journal_entry_id, 'SOURCE', x.id, 'Expense claim ' || x.number, '/expenses/' || x.id, 'voids' FROM expense_claims x WHERE x.org_id = ${orgId}::uuid AND x.void_journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'TDS/TCS deposit ' || x.number, '/tax/tds-tcs', 'posts' FROM withholding_deposits x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Pay run ' || x.number, '/payroll/runs/' || x.id, 'posts' FROM pay_runs x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.void_journal_entry_id, 'SOURCE', x.id, 'Pay run ' || x.number, '/payroll/runs/' || x.id, 'voids' FROM pay_runs x WHERE x.org_id = ${orgId}::uuid AND x.void_journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Payroll remittance ' || x.number, '/payroll/runs', 'posts' FROM payroll_remittances x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.acquisition_entry_id, 'ASSET', x.id, 'FA-' || lpad(x.number::text, 4, '0') || ' ' || x.name, '/fixed-assets/' || x.id, 'records the purchase of' FROM fixed_assets x WHERE x.org_id = ${orgId}::uuid AND x.acquisition_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.disposal_entry_id, 'ASSET', x.id, 'FA-' || lpad(x.number::text, 4, '0') || ' ' || x.name, '/fixed-assets/' || x.id, 'disposes of' FROM fixed_assets x WHERE x.org_id = ${orgId}::uuid AND x.disposal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Depreciation for ' || x.month, '/fixed-assets/depreciation', 'posts' FROM depreciation_runs x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.reversal_entry_id, 'SOURCE', x.id, 'Depreciation for ' || x.month, '/fixed-assets/depreciation', 'reverses' FROM depreciation_runs x WHERE x.org_id = ${orgId}::uuid AND x.reversal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.initial_entry_id, 'SOURCE', x.id, 'Schedule ' || x.number || ' ' || x.name, '/deferrals/' || x.id, 'records' FROM deferral_schedules x WHERE x.org_id = ${orgId}::uuid AND x.initial_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Deferral releases for ' || x.month, '/deferrals/releases', 'posts' FROM deferral_runs x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.entry_id, 'SOURCE', x.id, 'Accrual AC-' || lpad(x.number::text, 4, '0') || ' ' || x.description, '/accruals', 'posts' FROM accruals x WHERE x.org_id = ${orgId}::uuid AND x.entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.reversal_entry_id, 'SOURCE', x.id, 'Accrual AC-' || lpad(x.number::text, 4, '0') || ' ' || x.description, '/accruals', 'reverses' FROM accruals x WHERE x.org_id = ${orgId}::uuid AND x.reversal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.disbursement_entry_id, 'LOAN', x.id, 'LN-' || lpad(x.number::text, 4, '0') || ' ' || x.name, '/loans/' || x.id, 'disburses' FROM loans x WHERE x.org_id = ${orgId}::uuid AND x.disbursement_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT ev.entry_id, 'LOAN', l.id, 'LN-' || lpad(l.number::text, 4, '0') || ' ' || l.name, '/loans/' || l.id, 'records a ' || lower(replace(ev.kind::text, '_', ' ')) || ' on' FROM loan_events ev JOIN loans l ON l.id = ev.loan_id WHERE ev.org_id = ${orgId}::uuid AND ev.entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.journal_entry_id, 'SOURCE', x.id, 'Month-end adjustment', '/close', 'posts' FROM close_adjustments x WHERE x.org_id = ${orgId}::uuid AND x.journal_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.from_entry_id, 'SOURCE', x.id, 'IC-' || lpad(x.number::text, 4, '0') || ' ' || x.description, '/consolidation/' || x.group_id, 'posts' FROM intercompany_transactions x WHERE x.from_org_id = ${orgId}::uuid AND x.from_entry_id IN (SELECT id FROM e)
      UNION ALL SELECT x.to_entry_id, 'SOURCE', x.id, 'IC-' || lpad(x.number::text, 4, '0') || ' ' || x.description, '/consolidation/' || x.group_id, 'posts' FROM intercompany_transactions x WHERE x.to_org_id = ${orgId}::uuid AND x.to_entry_id IN (SELECT id FROM e)`;
    for (const r of rows) if (!out.has(r.entry_id)) out.set(r.entry_id, { type: r.type as EntrySource['type'], id: r.id, label: r.label, path: r.path, role: r.role });
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
      this.prisma.$queryRaw<{ id: string; kind: string; number: string; status: string; date: Date; amount: Prisma.Decimal; currency: string }[]>`
        SELECT p.id, p.kind::text AS kind, p.number, p.status::text AS status, p.date, p.currency, p.amount
        FROM payments p WHERE p.org_id = ${orgId}::uuid AND (p.number ILIKE ${`%${term}%`} OR p.reference ILIKE ${`%${term}%`}) ORDER BY p.date DESC LIMIT 8`,
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
        const pays = await this.prisma.$queryRaw<{ id: string; kind: string; number: string; status: string; date: Date; amount: Prisma.Decimal; currency: string }[]>`
          SELECT p.id, p.kind::text AS kind, p.number, p.status::text AS status, p.date, p.currency, p.amount
          FROM payments p WHERE p.org_id = ${orgId}::uuid AND p.contact_id = ${id}::uuid ORDER BY p.date DESC LIMIT ${LIMIT}`;
        const dims = await this.prisma.$queryRaw<{ id: string; type: string; code: string; name: string; lines: number; amount: Prisma.Decimal }[]>`
          SELECT v.id, v.type::text AS type, v.code, v.name, COUNT(*)::int AS lines, SUM(l.net_amount) AS amount
          FROM document_lines l JOIN documents d ON d.id = l.document_id AND d.org_id = l.org_id
          JOIN dimension_values v ON v.org_id = l.org_id AND (v.id = l.project_id OR v.id = l.department_id)
          WHERE l.org_id = ${orgId}::uuid AND d.contact_id = ${id}::uuid AND d.status = 'POSTED'
          GROUP BY v.id, v.type, v.code, v.name ORDER BY v.type DESC, v.code`;
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
          ...settledBy.map((a) =>
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
        const lines = await this.prisma.$queryRaw<{ id: string; entry_number: number | null; date: Date; memo: string | null; source: string; status: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
          SELECT e.id, e.entry_number, e.date, e.memo, e.source::text AS source, e.status::text AS status, SUM(l.functional_debit) AS debit, SUM(l.functional_credit) AS credit
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
          WHERE l.org_id = ${orgId}::uuid AND l.account_id = ${id}::uuid AND e.status = 'POSTED'
          GROUP BY e.id ORDER BY e.date DESC, e.entry_number DESC LIMIT ${LIMIT}`;
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
        const col = type === 'PROJECT' ? Prisma.sql`project_id` : Prisma.sql`department_id`;
        const docs = await this.prisma.$queryRaw<{ id: string; kind: string; number: string | null; status: string; issue_date: Date; total: Prisma.Decimal; currency: string; contact_id: string; lines: number; amount: Prisma.Decimal }[]>`
          SELECT d.id, d.kind::text AS kind, d.number, d.status::text AS status, d.issue_date, d.total, d.currency, d.contact_id, COUNT(*)::int AS lines, SUM(l.net_amount) AS amount
          FROM document_lines l JOIN documents d ON d.id = l.document_id AND d.org_id = l.org_id
          WHERE l.org_id = ${orgId}::uuid AND l.${col} = ${id}::uuid GROUP BY d.id ORDER BY d.issue_date DESC LIMIT ${LIMIT + 1}`;
        const journals = await this.prisma.$queryRaw<{ id: string; entry_number: number | null; date: Date; memo: string | null; source: string; status: string; amount: Prisma.Decimal }[]>`
          SELECT e.id, e.entry_number, e.date, e.memo, e.source::text AS source, e.status::text AS status, SUM(l.functional_debit + l.functional_credit) AS amount
          FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
          WHERE l.org_id = ${orgId}::uuid AND l.${col} = ${id}::uuid AND e.status = 'POSTED' AND e.source NOT IN ('DOCUMENT', 'PAYMENT')
          GROUP BY e.id ORDER BY e.date DESC LIMIT ${LIMIT}`;
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
        const runs = await this.prisma.$queryRaw<{ id: string; entry_number: number | null; date: Date; memo: string | null; source: string; status: string; amount: Prisma.Decimal; month: string }[]>`
          SELECT e.id, e.entry_number, e.date, e.memo, e.source::text AS source, e.status::text AS status, l.amount, r.month
          FROM depreciation_lines l JOIN depreciation_runs r ON r.id = l.run_id AND r.org_id = l.org_id JOIN journal_entries e ON e.id = r.journal_entry_id
          WHERE l.org_id = ${orgId}::uuid AND l.asset_id = ${id}::uuid AND r.status = 'POSTED' ORDER BY r.month DESC LIMIT ${LIMIT}`;
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
