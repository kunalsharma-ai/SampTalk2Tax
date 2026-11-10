import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, linkExpired, makePortalToken, minorUnits, paymentLinkRef, PORTAL_TOKEN_PATTERN, portalInvoiceState, portalLinkState, portalTokenPrefix, type PaymentLinkStatus } from '@talk2tax/accounting-engine';
import { createHash, randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { fromDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, withSystemAccess } from '../common/prisma.service';
import { enterOrg } from '../common/tenant-context';
import { InvoiceTemplatesService } from '../invoice-templates/invoice-templates.service';
import { SubledgerService } from '../ledgers/subledger.service';
import { RegionsService } from '../regions/regions.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
interface PortalOrg {
  id: string;
  functionalCurrency: string;
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const DAY = 86_400_000;

/**
 * Customer portal (AR-030). Staff make a private link for a customer; the customer opens it to
 * see their invoices, what they owe, their statement and any payment links, and to download an
 * invoice, without signing in. Nothing in the portal changes the books. Links expire or are
 * revoked; only a hash of the secret is stored.
 */
@Injectable()
export class CustomerPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly subledger: SubledgerService,
    private readonly templates: InvoiceTemplatesService,
    private readonly regions: RegionsService,
  ) {}

  // ------------------------------------------------------------------ staff

  private async customer(orgId: string, contactId: string) {
    const c = await this.prisma.contact.findFirst({ where: { id: contactId, orgId }, select: { id: true, name: true, isCustomer: true, isActive: true } });
    if (!c || !c.isCustomer) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Customer not found' });
    return c;
  }

  async list(org: PortalOrg, contactId: string) {
    await this.customer(org.id, contactId);
    const links = await this.prisma.customerPortalLink.findMany({ where: { orgId: org.id, contactId }, orderBy: { createdAt: 'desc' } });
    const ids = [...new Set(links.flatMap((l) => [l.createdById, l.revokedById]).filter((x): x is string => !!x))];
    const users = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const now = new Date();
    return links.map((l) => ({
      id: l.id,
      prefix: l.prefix,
      note: l.note,
      state: portalLinkState(l, now),
      createdAt: l.createdAt.toISOString(),
      createdBy: users.get(l.createdById) ?? 'Former member',
      expiresAt: l.expiresAt?.toISOString() ?? null,
      lastSeenAt: l.lastSeenAt?.toISOString() ?? null,
      viewCount: l.viewCount,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      revokedBy: l.revokedById ? (users.get(l.revokedById) ?? 'Former member') : null,
    }));
  }

  /** Makes a link. The token is returned this once and never again. */
  async create(org: PortalOrg, actor: Actor, contactId: string, input: { expiresInDays: number | null; note?: string | null }) {
    const c = await this.customer(org.id, contactId);
    if (!c.isActive) throw new DomainError('CONTACT_INACTIVE', `${c.name} is inactive`, HttpStatus.CONFLICT);
    const token = makePortalToken((n) => randomBytes(n));
    const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY) : null;
    const link = await this.prisma.$transaction(async (tx) => {
      const l = await tx.customerPortalLink.create({ data: { orgId: org.id, contactId, prefix: portalTokenPrefix(token), tokenHash: hash(token), note: input.note?.trim() || null, expiresAt, createdById: actor.id } });
      // The audit trail names the link by its prefix; the secret is never recorded.
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'customer_portal.link_created', entityType: 'customer_portal_link', entityId: l.id, data: { contactId, prefix: l.prefix, expiresAt: expiresAt?.toISOString() ?? null } });
      return l;
    });
    return { id: link.id, prefix: link.prefix, token, path: `/portal/${token}`, expiresAt: link.expiresAt?.toISOString() ?? null };
  }

  async revoke(org: PortalOrg, actor: Actor, contactId: string, linkId: string) {
    await this.prisma.$transaction(async (tx) => {
      const l = await tx.customerPortalLink.findFirst({ where: { id: linkId, orgId: org.id, contactId } });
      if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Portal link not found' });
      if (l.revokedAt) throw new DomainError('ALREADY_REVOKED', 'This link is already revoked', HttpStatus.CONFLICT);
      await tx.customerPortalLink.update({ where: { id: l.id }, data: { revokedAt: new Date(), revokedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'customer_portal.link_revoked', entityType: 'customer_portal_link', entityId: l.id, data: { contactId, prefix: l.prefix } });
    });
    return this.list(org, contactId);
  }

  // ------------------------------------------------------------------ the portal (no sign-in)

  /**
   * Finds the live link for a token across organisations, then narrows the request to its
   * organisation, so every later query is held to that tenant by row-level security.
   */
  private async open(token: string, count = false) {
    const invalid = (message = 'This link is not valid. Ask the business that sent it for a new one.') => new DomainError('PORTAL_LINK_INVALID', message, HttpStatus.NOT_FOUND);
    if (!PORTAL_TOKEN_PATTERN.test(token)) throw invalid();
    const found = await this.prisma.$transaction(async (tx) =>
      withSystemAccess(tx, async () => {
        const l = await tx.customerPortalLink.findUnique({ where: { tokenHash: hash(token) } });
        if (!l) return null;
        const org = await tx.organization.findUniqueOrThrow({ where: { id: l.orgId }, select: { id: true, name: true, legalName: true, functionalCurrency: true, dataRegion: true, suspendedAt: true } });
        return { l, org };
      }),
    );
    if (!found) throw invalid();
    const { l, org } = found;
    const state = portalLinkState(l, new Date());
    if (state === 'REVOKED') throw invalid(`${org.name} has withdrawn this link. Ask them for a new one.`);
    if (state === 'EXPIRED') throw invalid(`This link from ${org.name} has expired. Ask them for a new one.`);
    if (org.suspendedAt) throw invalid(`${org.name}'s portal is not available right now.`);
    this.regions.assertHere(org.dataRegion);
    enterOrg(org.id);
    const contact = await this.prisma.contact.findFirst({ where: { id: l.contactId, orgId: org.id }, select: { id: true, name: true, gstin: true, isActive: true } });
    if (!contact || !contact.isActive) throw invalid();
    if (count) await this.prisma.customerPortalLink.update({ where: { id: l.id }, data: { lastSeenAt: new Date(), viewCount: { increment: 1 } } });
    return { link: l, org, contact };
  }

  /** The portal's front page: who it is from, what is owed, the invoices and the payments. */
  async overview(token: string) {
    const { link, org, contact } = await this.open(token, true);
    const today = todayIst();
    const gst = await this.prisma.gstRegistration.findUnique({ where: { orgId: org.id }, select: { gstin: true, legalName: true } });
    const items = await this.subledger.openItems(this.prisma, org.id, 'SALES', today, contact.id);
    const openBy = new Map(items.map((i) => [i.id, i]));
    const docs = await this.prisma.document.findMany({
      where: { orgId: org.id, contactId: contact.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: { in: ['POSTED', 'VOID'] } },
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: 100,
      select: { id: true, kind: true, number: true, status: true, issueDate: true, dueDate: true, currency: true, total: true, reference: true },
    });
    const links = await this.prisma.paymentLink.findMany({ where: { orgId: org.id, documentId: { in: docs.map((d) => d.id) }, status: 'OPEN' }, orderBy: { number: 'desc' } });
    const now = new Date();
    const invoices = docs.map((d) => {
      const scale = minorUnits(d.currency);
      const total = d.total.toFixed(scale);
      const oi = openBy.get(d.id);
      const open = d.status === 'VOID' || !oi ? new D(0).toFixed(scale) : oi.foreignOpen.toFixed(scale);
      const dueDate = d.dueDate ? fromDbDate(d.dueDate) : null;
      const pl = d.kind === 'INVOICE' ? links.find((x) => x.documentId === d.id && !linkExpired(x.status as PaymentLinkStatus, x.expiresAt, now)) : undefined;
      return {
        id: d.id,
        kind: d.kind,
        number: d.number!,
        reference: d.reference,
        issueDate: fromDbDate(d.issueDate),
        dueDate,
        currency: d.currency,
        total,
        open,
        state: d.kind === 'CREDIT_NOTE' ? (d.status === 'VOID' ? 'VOID' : Number(open) > 0 ? 'UNUSED_CREDIT' : 'USED') : portalInvoiceState({ status: d.status, total, open, dueDate }, today),
        daysOverdue: d.kind === 'INVOICE' && dueDate && dueDate < today && Number(open) > 0 ? Math.round((Date.parse(today) - Date.parse(dueDate)) / DAY) : 0,
        payLink: pl ? { reference: paymentLinkRef(pl.number), url: pl.url, expiresAt: pl.expiresAt?.toISOString() ?? null } : null,
      };
    });
    // What is owed, by currency: open invoices less unused credit notes and payments not yet applied.
    const byCurrency = new Map<string, { owed: InstanceType<typeof D>; overdue: InstanceType<typeof D>; credits: InstanceType<typeof D> }>();
    for (const i of items) {
      const b = byCurrency.get(i.currency) ?? { owed: new D(0), overdue: new D(0), credits: new D(0) };
      if (i.type === 'charge') {
        b.owed = b.owed.plus(i.foreignOpen);
        if (i.dueDate && i.dueDate < today) b.overdue = b.overdue.plus(i.foreignOpen);
      } else b.credits = b.credits.plus(i.foreignOpen);
      byCurrency.set(i.currency, b);
    }
    const balances = [...byCurrency.entries()]
      .sort(([a], [b]) => (a === org.functionalCurrency ? -1 : b === org.functionalCurrency ? 1 : a.localeCompare(b)))
      .map(([currency, b]) => {
        const s = minorUnits(currency);
        return { currency, owed: b.owed.toFixed(s), overdue: b.overdue.toFixed(s), credits: b.credits.toFixed(s), balance: b.owed.minus(b.credits).toFixed(s) };
      });
    const receipts = await this.prisma.payment.findMany({ where: { orgId: org.id, contactId: contact.id, kind: 'RECEIPT' }, orderBy: [{ date: 'desc' }, { number: 'desc' }], take: 50, select: { id: true, number: true, date: true, amount: true, currency: true, status: true, reference: true } });
    return {
      from: { name: gst?.legalName || org.legalName || org.name, tradeName: org.name, gstin: gst?.gstin ?? null },
      customer: { name: contact.name, gstin: contact.gstin },
      link: { expiresAt: link.expiresAt?.toISOString() ?? null },
      today,
      balances,
      invoices,
      receipts: receipts.map((r) => ({ id: r.id, number: r.number, date: fromDbDate(r.date), amount: r.amount.toFixed(minorUnits(r.currency)), currency: r.currency, status: r.status, reference: r.reference })),
    };
  }

  /** The customer's statement: every invoice, credit, payment and void with a running balance. */
  async statement(token: string, q: { from?: string; to?: string; currency?: string }) {
    const { org, contact } = await this.open(token);
    const to = q.to ?? todayIst();
    const from = q.from ?? `${Number(to.slice(0, 4)) - 1}${to.slice(4, 8)}01`;
    if (from > to) throw new DomainError('INVALID_RANGE', 'The statement must start on or before its end', HttpStatus.UNPROCESSABLE_ENTITY);
    const s = await this.subledger.statement({ id: org.id, functionalCurrency: org.functionalCurrency }, contact.id, 'SALES', from, to, q.currency);
    // Only invoices, credit notes and receipts can be opened from the portal; ids of other rows are not shown.
    return { ...s, lines: s.lines.map((l) => ({ ...l, id: ['INVOICE', 'CREDIT_NOTE'].includes(l.kind) ? l.id : null })) };
  }

  /** One invoice or credit note as a self-contained page, printed with the business's template. */
  async documentHtml(token: string, documentId: string) {
    const { org, contact } = await this.open(token);
    const d = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id, contactId: contact.id, kind: { in: ['INVOICE', 'CREDIT_NOTE'] }, status: { in: ['POSTED', 'VOID'] } }, select: { id: true } });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    return this.templates.printHtml({ id: org.id, role: 'VIEWER' }, d.id);
  }
}
