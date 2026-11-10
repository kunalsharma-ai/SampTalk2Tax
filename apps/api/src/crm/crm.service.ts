import { MovedTables } from '../db/moved-table';
import { CONTACTS, newContact } from '../db/collections/sales';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  CrmError,
  D,
  dealStageChange,
  DEAL_STAGE_LABEL,
  DEAL_STAGE_PROBABILITY,
  isOpenStage,
  leadConvertible,
  leadTransition,
  minorUnits,
  normalEmail,
  pipelineSummary,
  weightedByCloseMonth,
  weightedValue,
  checkProbability,
  type DealStage,
  type LeadSource,
  type LeadStatus,
} from '@talk2tax/accounting-engine';
import { CrmActivity, CrmDeal, CrmLead, Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, istDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';
import { nextCounter } from '../db/counters';

export interface CrmOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };

export interface LeadInput {
  name: string;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  source: LeadSource;
  ownerId?: string | null;
  estimatedValue?: string | null;
  notes?: string | null;
}

export interface DealInput {
  name: string;
  contactId: string;
  amount: string;
  expectedCloseDate: string;
  ownerId?: string | null;
  notes?: string | null;
}

export interface ConvertInput {
  /** An existing contact to attach the lead to; otherwise a new customer is created from the lead. */
  contactId?: string | null;
  deal?: { name: string; amount: string; expectedCloseDate: string } | null;
}

export type ActivityKindInput = 'NOTE' | 'CALL' | 'EMAIL' | 'MEETING';

const leadRef = (n: number) => `LD-${String(n).padStart(4, '0')}`;
const dealRef = (n: number) => `DL-${String(n).padStart(4, '0')}`;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

@Injectable()
export class CrmService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moved: MovedTables,
  ) {}

  private scale(org: CrmOrg) {
    return minorUnits(org.functionalCurrency);
  }

  private can(org: CrmOrg) {
    return { manage: hasPermission(org.role, 'crm.manage'), manageContacts: hasPermission(org.role, 'contacts.manage') };
  }

  private invalid(message: string, code = 'CRM_INVALID', status: number = HttpStatus.UNPROCESSABLE_ENTITY): never {
    throw new DomainError(code, message, status);
  }

  /** Engine rule failures become 422s with the rule's code. */
  private rule<T>(f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof CrmError) this.invalid(e.message, e.code);
      throw e;
    }
  }

  private amount(org: CrmOrg, v: string, what: string) {
    const scale = this.scale(org);
    const a = new D(v);
    if (a.isNegative()) this.invalid(`The ${what} cannot be negative`);
    if (!a.toDecimalPlaces(scale).eq(a)) this.invalid(`Give the ${what} to ${scale} decimal places`);
    return a.toFixed(scale);
  }

  private async nextNumber(tx: Tx, orgId: string, key: 'crm_lead' | 'crm_deal') {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, key) }];
    return value;
  }

  private async checkOwner(db: Pick<Tx, 'membership'>, orgId: string, ownerId: string | null | undefined) {
    if (!ownerId) return null;
    const m = await db.membership.findUnique({ where: { orgId_userId: { orgId, userId: ownerId } } });
    if (!m) this.invalid('The owner must be a member of this organisation', 'CRM_OWNER_NOT_MEMBER');
    return ownerId;
  }

  private async checkCustomer(db: Pick<Tx, 'contact'>, orgId: string, contactId: string) {
    const c = await db.contact.findFirst({ where: { id: contactId, orgId } });
    if (!c) this.invalid('Choose a customer of this organisation', 'CRM_CUSTOMER_NOT_FOUND');
    if (!c.isCustomer) this.invalid(`${c.name} is not set up as a customer`, 'CRM_NOT_CUSTOMER');
    if (!c.isActive) this.invalid(`${c.name} is inactive`, 'CRM_CUSTOMER_INACTIVE');
    return c;
  }

  private async lock(tx: Tx, table: 'crm_leads' | 'crm_deals', orgId: string, id: string) {
    if (table === 'crm_leads') await tx.$queryRaw`SELECT id FROM crm_leads WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    else await tx.$queryRaw`SELECT id FROM crm_deals WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
  }

  private async lockLead(tx: Tx, orgId: string, id: string) {
    await this.lock(tx, 'crm_leads', orgId, id);
    const l = await tx.crmLead.findFirst({ where: { id, orgId } });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Lead not found' });
    return l;
  }

  private async lockDeal(tx: Tx, orgId: string, id: string) {
    await this.lock(tx, 'crm_deals', orgId, id);
    const d = await tx.crmDeal.findFirst({ where: { id, orgId } });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Deal not found' });
    return d;
  }

  private activity(tx: Tx, orgId: string, actor: Actor, target: { leadId?: string; dealId?: string }, kind: CrmActivity['kind'], body: string | null, data?: Record<string, unknown>) {
    return tx.crmActivity.create({ data: { orgId, leadId: target.leadId ?? null, dealId: target.dealId ?? null, kind, body, data: (data ?? undefined) as Prisma.InputJsonValue | undefined, actorId: actor.id } });
  }

  // ------------------------------------------------------------------ people

  /** Members who can be given leads and deals. */
  async owners(org: CrmOrg) {
    const ms = await this.prisma.membership.findMany({ where: { orgId: org.id, role: { not: 'EMPLOYEE' } }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } });
    return ms.map((m) => ({ id: m.user.id, name: m.user.name, email: m.user.email, role: m.role }));
  }

  private async users(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return (id: string | null) => (id ? (rows.find((u) => u.id === id) ?? { id, name: 'Former member' }) : null);
  }

  // ------------------------------------------------------------------ leads

  private leadOut(org: CrmOrg, l: CrmLead, user: (id: string | null) => { id: string; name: string } | null) {
    const scale = this.scale(org);
    return {
      id: l.id,
      reference: leadRef(l.number),
      externalRef: l.externalRef,
      name: l.name,
      company: l.company,
      email: l.email,
      phone: l.phone,
      source: l.source,
      status: l.status,
      owner: user(l.ownerId),
      estimatedValue: l.estimatedValue ? new D(l.estimatedValue.toString()).toFixed(scale) : null,
      notes: l.notes,
      disqualifiedReason: l.disqualifiedReason,
      convertedContactId: l.convertedContactId,
      convertedDealId: l.convertedDealId,
      convertedAt: l.convertedAt?.toISOString() ?? null,
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  }

  async listLeads(org: CrmOrg, q: { status?: LeadStatus; ownerId?: string; q?: string }) {
    const where: Prisma.CrmLeadWhereInput = {
      orgId: org.id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { company: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [leads, counts] = await Promise.all([
      this.prisma.crmLead.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take: 500 }),
      this.prisma.crmLead.groupBy({ by: ['status'], where: { orgId: org.id }, _count: { _all: true } }),
    ]);
    const user = await this.users(leads.map((l) => l.ownerId));
    const scale = this.scale(org);
    const open = await this.prisma.crmLead.findMany({ where: { orgId: org.id, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] } }, select: { estimatedValue: true } });
    return {
      leads: leads.map((l) => this.leadOut(org, l, user)),
      counts: Object.fromEntries((['NEW', 'CONTACTED', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED'] as const).map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
      openEstimatedValue: open.reduce((t, l) => t.plus(l.estimatedValue?.toString() ?? 0), new D(0)).toFixed(scale),
      can: this.can(org),
    };
  }

  /** Other leads and contacts with the same email: a likely duplicate. */
  private async duplicates(orgId: string, email: string | null, exceptLeadId?: string, exceptContactId?: string | null) {
    const e = normalEmail(email);
    if (!e) return { leads: [], contacts: [] };
    const [leads, contacts] = await Promise.all([
      this.prisma.crmLead.findMany({ where: { orgId, email: { equals: e, mode: 'insensitive' }, ...(exceptLeadId ? { id: { not: exceptLeadId } } : {}) }, select: { id: true, number: true, name: true, status: true }, take: 10 }),
      this.prisma.contact.findMany({ where: { orgId, email: { equals: e, mode: 'insensitive' }, ...(exceptContactId ? { id: { not: exceptContactId } } : {}) }, select: { id: true, name: true, isCustomer: true }, take: 10 }),
    ]);
    return { leads: leads.map((l) => ({ id: l.id, reference: leadRef(l.number), name: l.name, status: l.status })), contacts };
  }

  async getLead(org: CrmOrg, id: string) {
    const l = await this.prisma.crmLead.findFirst({ where: { id, orgId: org.id } });
    if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Lead not found' });
    const acts = await this.prisma.crmActivity.findMany({ where: { orgId: org.id, leadId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const user = await this.users([l.ownerId, ...acts.map((a) => a.actorId)]);
    const [contact, deal, duplicates] = await Promise.all([
      l.convertedContactId ? this.prisma.contact.findFirst({ where: { id: l.convertedContactId, orgId: org.id }, select: { id: true, name: true } }) : null,
      l.convertedDealId ? this.prisma.crmDeal.findFirst({ where: { id: l.convertedDealId, orgId: org.id }, select: { id: true, number: true, name: true, stage: true } }) : null,
      this.duplicates(org.id, l.email, l.id, l.convertedContactId),
    ]);
    return {
      ...this.leadOut(org, l, user),
      convertedContact: contact,
      convertedDeal: deal ? { id: deal.id, reference: dealRef(deal.number), name: deal.name, stage: deal.stage } : null,
      duplicates,
      activities: acts.map((a) => this.activityOut(a, user)),
      can: this.can(org),
    };
  }

  private activityOut(a: CrmActivity, user: (id: string | null) => { id: string; name: string } | null) {
    return { id: a.id, kind: a.kind, body: a.body, data: a.data, actor: user(a.actorId), createdAt: a.createdAt.toISOString() };
  }

  async createLead(org: CrmOrg, actor: Actor, input: LeadInput) {
    return (await this.createLeadOnce(org, actor, input)).lead;
  }

  /**
   * Creates a lead, or, when another system sends its own id (externalRef) that is already on a
   * lead, returns that lead unchanged, so a retried call never makes a second one.
   */
  async createLeadOnce(org: CrmOrg, actor: Actor, input: LeadInput & { externalRef?: string | null }): Promise<{ lead: Awaited<ReturnType<CrmService['getLead']>>; created: boolean }> {
    const externalRef = clean(input.externalRef);
    if (externalRef) {
      const existing = await this.prisma.crmLead.findFirst({ where: { orgId: org.id, externalRef }, select: { id: true } });
      if (existing) return { lead: await this.getLead(org, existing.id), created: false };
    }
    const estimatedValue = input.estimatedValue ? this.amount(org, input.estimatedValue, 'estimated value') : null;
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        const ownerId = await this.checkOwner(tx, org.id, input.ownerId === undefined ? actor.id : input.ownerId);
        const number = await this.nextNumber(tx, org.id, 'crm_lead');
        const l = await tx.crmLead.create({
          data: { orgId: org.id, number, name: input.name.trim(), company: clean(input.company), email: normalEmail(input.email), phone: clean(input.phone), source: input.source, ownerId, estimatedValue, notes: clean(input.notes), externalRef, createdById: actor.id },
        });
        await this.activity(tx, org.id, actor, { leadId: l.id }, 'CREATED', null, { source: input.source });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.lead.created', entityType: 'crm_lead', entityId: l.id, data: { reference: leadRef(number), name: l.name, company: l.company, source: l.source, ownerId, ...(externalRef ? { externalRef } : {}) } });
        return l.id;
      });
    } catch (e) {
      // Two calls with the same externalRef at once: the second finds the first's lead.
      if (externalRef && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.crmLead.findFirst({ where: { orgId: org.id, externalRef }, select: { id: true } });
        if (existing) return { lead: await this.getLead(org, existing.id), created: false };
      }
      throw e;
    }
    return { lead: await this.getLead(org, id), created: true };
  }

  async updateLead(org: CrmOrg, actor: Actor, id: string, input: LeadInput) {
    const estimatedValue = input.estimatedValue ? this.amount(org, input.estimatedValue, 'estimated value') : null;
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockLead(tx, org.id, id);
      if (before.status === 'CONVERTED') this.invalid('A converted lead is closed; work on its customer and deal instead', 'LEAD_CONVERTED');
      const ownerId = await this.checkOwner(tx, org.id, input.ownerId ?? null);
      const after = { name: input.name.trim(), company: clean(input.company), email: normalEmail(input.email), phone: clean(input.phone), source: input.source, ownerId, estimatedValue, notes: clean(input.notes) };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => {
        const b = before[k];
        const a = after[k];
        if (k === 'estimatedValue') return (b === null ? null : new D(b.toString()).toFixed(this.scale(org))) !== a;
        return (b ?? null) !== (a ?? null);
      });
      if (!changed.length) return;
      await tx.crmLead.update({ where: { id }, data: after });
      await this.activity(tx, org.id, actor, { leadId: id }, 'UPDATED', null, { fields: changed });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.lead.updated', entityType: 'crm_lead', entityId: id, data: { fields: changed } });
    });
    return this.getLead(org, id);
  }

  async setLeadStatus(org: CrmOrg, actor: Actor, id: string, input: { status: LeadStatus; reason?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const l = await this.lockLead(tx, org.id, id);
      this.rule(() => leadTransition(l.status, input.status, input.reason));
      const reason = input.status === 'DISQUALIFIED' ? input.reason!.trim() : null;
      await tx.crmLead.update({ where: { id }, data: { status: input.status, disqualifiedReason: reason } });
      await this.activity(tx, org.id, actor, { leadId: id }, 'STATUS_CHANGED', reason, { from: l.status, to: input.status });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.lead.status_changed', entityType: 'crm_lead', entityId: id, data: { from: l.status, to: input.status, reason } });
    });
    return this.getLead(org, id);
  }

  /**
   * Turn a qualified lead into a customer, once: attach it to an existing customer or create one
   * from the lead's details, and optionally open a deal for it at the qualification stage.
   */
  async convertLead(org: CrmOrg, actor: Actor, id: string, input: ConvertInput) {
    const dealAmount = input.deal ? this.amount(org, input.deal.amount, 'deal amount') : null;
    await this.prisma.$transaction(async (tx) => {
      const l = await this.lockLead(tx, org.id, id);
      this.rule(() => leadConvertible(l.status));
      let contactId: string;
      let createdContact = false;
      if (input.contactId) {
        const c = await tx.contact.findFirst({ where: { id: input.contactId, orgId: org.id } });
        if (!c) this.invalid('Choose a contact of this organisation', 'CRM_CUSTOMER_NOT_FOUND');
        if (!c.isActive) this.invalid(`${c.name} is inactive`, 'CRM_CUSTOMER_INACTIVE');
        if (!c.isCustomer) {
          await this.moved.update(tx, CONTACTS, org.id, c.id, { isCustomer: true, updatedAt: new Date() });
          await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.updated', entityType: 'contact', entityId: c.id, data: { isCustomer: true, from: 'crm.lead.converted' } });
        }
        contactId = c.id;
      } else {
        if (!hasPermission(org.role, 'contacts.manage')) this.invalid('Creating a customer needs permission to manage contacts; choose an existing customer instead', 'FORBIDDEN', HttpStatus.FORBIDDEN);
        const now = new Date();
        const c = await this.moved.create<{ id: string; name: string }>(tx, CONTACTS, org.id, newContact({ name: l.company ?? l.name, email: l.email, phone: l.phone, isCustomer: true }, now));
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'contact.created', entityType: 'contact', entityId: c.id, data: { name: c.name, isCustomer: true, isVendor: false, fromLead: leadRef(l.number) } });
        contactId = c.id;
        createdContact = true;
      }
      let dealId: string | null = null;
      if (input.deal && dealAmount !== null) {
        const number = await this.nextNumber(tx, org.id, 'crm_deal');
        const d = await tx.crmDeal.create({
          data: { orgId: org.id, number, name: input.deal.name.trim(), contactId, leadId: l.id, amount: dealAmount, stage: 'QUALIFICATION', probability: DEAL_STAGE_PROBABILITY.QUALIFICATION, expectedCloseDate: toDbDate(input.deal.expectedCloseDate), ownerId: l.ownerId, createdById: actor.id },
        });
        dealId = d.id;
        await this.activity(tx, org.id, actor, { dealId: d.id }, 'CREATED', null, { fromLead: leadRef(l.number), stage: d.stage });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.deal.created', entityType: 'crm_deal', entityId: d.id, data: { reference: dealRef(number), amount: dealAmount, contactId, fromLead: l.id } });
      }
      await this.activity(tx, org.id, actor, { leadId: l.id }, 'CONVERTED', null, { contactId, createdContact, dealId });
      await tx.crmLead.update({ where: { id }, data: { status: 'CONVERTED', convertedContactId: contactId, convertedDealId: dealId, convertedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.lead.converted', entityType: 'crm_lead', entityId: id, data: { contactId, createdContact, dealId } });
    });
    return this.getLead(org, id);
  }

  // ------------------------------------------------------------------ deals

  private dealOut(org: CrmOrg, d: CrmDeal, user: (id: string | null) => { id: string; name: string } | null, contact: (id: string) => { id: string; name: string } | null, today: string) {
    const scale = this.scale(org);
    const amount = new D(d.amount.toString()).toFixed(scale);
    const expectedCloseDate = fromDbDate(d.expectedCloseDate);
    return {
      id: d.id,
      reference: dealRef(d.number),
      externalRef: d.externalRef,
      name: d.name,
      contact: contact(d.contactId),
      leadId: d.leadId,
      amount,
      stage: d.stage,
      probability: d.probability,
      weighted: weightedValue(amount, d.probability, scale),
      expectedCloseDate,
      overdue: isOpenStage(d.stage) && expectedCloseDate < today,
      owner: user(d.ownerId),
      closedOn: d.closedOn ? fromDbDate(d.closedOn) : null,
      lostReason: d.lostReason,
      notes: d.notes,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  private async contacts(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = unique.length ? await this.prisma.contact.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : [];
    return (id: string) => rows.find((c) => c.id === id) ?? null;
  }

  async listDeals(org: CrmOrg, q: { stage?: DealStage; ownerId?: string; contactId?: string; q?: string; view?: 'open' | 'closed' | 'all' }) {
    const today = todayIst();
    const scale = this.scale(org);
    const view = q.view ?? 'open';
    const where: Prisma.CrmDealWhereInput = {
      orgId: org.id,
      ...(q.stage ? { stage: q.stage } : view === 'open' ? { stage: { notIn: ['WON', 'LOST'] } } : view === 'closed' ? { stage: { in: ['WON', 'LOST'] } } : {}),
      ...(q.ownerId ? { ownerId: q.ownerId } : {}),
      ...(q.contactId ? { contactId: q.contactId } : {}),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [deals, all] = await Promise.all([
      this.prisma.crmDeal.findMany({ where, orderBy: [{ expectedCloseDate: 'asc' }, { number: 'asc' }], take: 500 }),
      this.prisma.crmDeal.findMany({ where: { orgId: org.id, ...(q.ownerId ? { ownerId: q.ownerId } : {}), ...(q.contactId ? { contactId: q.contactId } : {}) }, select: { stage: true, amount: true, probability: true, ownerId: true, expectedCloseDate: true, closedOn: true, createdAt: true } }),
    ]);
    const [user, contact] = await Promise.all([this.users(deals.map((d) => d.ownerId)), this.contacts(deals.map((d) => d.contactId))]);
    const pipe = all.map((d) => ({ stage: d.stage, amount: d.amount.toString(), probability: d.probability, ownerId: d.ownerId, expectedCloseDate: fromDbDate(d.expectedCloseDate), closedOn: d.closedOn ? fromDbDate(d.closedOn) : null, createdOn: istDate(d.createdAt) }));
    return {
      today,
      deals: deals.map((d) => this.dealOut(org, d, user, contact, today)),
      summary: pipelineSummary(pipe, today, scale),
      byCloseMonth: weightedByCloseMonth(pipe, today, scale, 6),
      can: this.can(org),
    };
  }

  async getDeal(org: CrmOrg, id: string) {
    const today = todayIst();
    const d = await this.prisma.crmDeal.findFirst({ where: { id, orgId: org.id } });
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Deal not found' });
    const acts = await this.prisma.crmActivity.findMany({ where: { orgId: org.id, dealId: id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const [user, contact, lead] = await Promise.all([
      this.users([d.ownerId, ...acts.map((a) => a.actorId)]),
      this.contacts([d.contactId]),
      d.leadId ? this.prisma.crmLead.findFirst({ where: { id: d.leadId, orgId: org.id }, select: { id: true, number: true, name: true, source: true } }) : null,
    ]);
    return {
      ...this.dealOut(org, d, user, contact, today),
      lead: lead ? { id: lead.id, reference: leadRef(lead.number), name: lead.name, source: lead.source } : null,
      activities: acts.map((a) => this.activityOut(a, user)),
      can: this.can(org),
    };
  }

  async createDeal(org: CrmOrg, actor: Actor, input: DealInput & { stage?: DealStage; probability?: number | null }) {
    return (await this.createDealOnce(org, actor, input)).deal;
  }

  /** Like createLeadOnce: a deal already carrying this externalRef is returned, not made again. */
  async createDealOnce(org: CrmOrg, actor: Actor, input: DealInput & { stage?: DealStage; probability?: number | null; externalRef?: string | null }): Promise<{ deal: Awaited<ReturnType<CrmService['getDeal']>>; created: boolean }> {
    const externalRef = clean(input.externalRef);
    const existingDeal = async () => {
      const d = externalRef ? await this.prisma.crmDeal.findFirst({ where: { orgId: org.id, externalRef }, select: { id: true } }) : null;
      return d ? { deal: await this.getDeal(org, d.id), created: false } : null;
    };
    const before = await existingDeal();
    if (before) return before;
    const amount = this.amount(org, input.amount, 'deal amount');
    const stage = input.stage ?? 'PROSPECTING';
    if (!isOpenStage(stage)) this.invalid('A new deal starts at an open stage', 'DEAL_STAGE');
    const probability = input.probability ?? DEAL_STAGE_PROBABILITY[stage];
    this.rule(() => checkProbability(probability));
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        await this.checkCustomer(tx, org.id, input.contactId);
        const ownerId = await this.checkOwner(tx, org.id, input.ownerId === undefined ? actor.id : input.ownerId);
        const number = await this.nextNumber(tx, org.id, 'crm_deal');
        const d = await tx.crmDeal.create({
          data: { orgId: org.id, number, name: input.name.trim(), contactId: input.contactId, amount, stage, probability, expectedCloseDate: toDbDate(input.expectedCloseDate), ownerId, notes: clean(input.notes), externalRef, createdById: actor.id },
        });
        await this.activity(tx, org.id, actor, { dealId: d.id }, 'CREATED', null, { stage, probability });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.deal.created', entityType: 'crm_deal', entityId: d.id, data: { reference: dealRef(number), amount, contactId: input.contactId, stage, probability, ownerId, ...(externalRef ? { externalRef } : {}) } });
        return d.id;
      });
    } catch (e) {
      if (externalRef && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await existingDeal();
        if (again) return again;
      }
      throw e;
    }
    return { deal: await this.getDeal(org, id), created: true };
  }

  async updateDeal(org: CrmOrg, actor: Actor, id: string, input: DealInput) {
    const amount = this.amount(org, input.amount, 'deal amount');
    await this.prisma.$transaction(async (tx) => {
      const before = await this.lockDeal(tx, org.id, id);
      const ownerId = await this.checkOwner(tx, org.id, input.ownerId ?? null);
      const after = { name: input.name.trim(), contactId: input.contactId, amount, expectedCloseDate: input.expectedCloseDate, ownerId, notes: clean(input.notes) };
      const was = { name: before.name, contactId: before.contactId, amount: new D(before.amount.toString()).toFixed(this.scale(org)), expectedCloseDate: fromDbDate(before.expectedCloseDate), ownerId: before.ownerId, notes: before.notes };
      const changed = (Object.keys(after) as (keyof typeof after)[]).filter((k) => (was[k] ?? null) !== (after[k] ?? null));
      if (!changed.length) return;
      // A closed deal keeps what was won or lost; only its notes and owner change.
      if (!isOpenStage(before.stage) && changed.some((k) => !['notes', 'ownerId'].includes(k))) this.invalid(`A ${DEAL_STAGE_LABEL[before.stage].toLowerCase()} deal keeps its customer, amount and dates; reopen it to change them`, 'DEAL_CLOSED');
      if (changed.includes('contactId')) await this.checkCustomer(tx, org.id, input.contactId);
      await tx.crmDeal.update({ where: { id }, data: { ...after, expectedCloseDate: toDbDate(after.expectedCloseDate) } });
      const diff = Object.fromEntries(changed.map((k) => [k, { from: was[k], to: after[k] }]));
      await this.activity(tx, org.id, actor, { dealId: id }, 'UPDATED', null, { fields: changed, ...(diff.amount ? { amount: diff.amount } : {}), ...(diff.expectedCloseDate ? { expectedCloseDate: diff.expectedCloseDate } : {}) });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.deal.updated', entityType: 'crm_deal', entityId: id, data: diff });
    });
    return this.getDeal(org, id);
  }

  /** Move a deal to a stage (or change its probability within one), closing or reopening it. */
  async moveDeal(org: CrmOrg, actor: Actor, id: string, input: { stage: DealStage; probability?: number | null; lostReason?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const d = await this.lockDeal(tx, org.id, id);
      const r = this.rule(() => dealStageChange(d.stage, input.stage, { probability: input.probability ?? (d.stage === input.stage ? undefined : null), lostReason: input.lostReason }));
      if (d.stage === input.stage && r.probability === d.probability) this.invalid(`The deal is already at ${DEAL_STAGE_LABEL[d.stage].toLowerCase()} with ${d.probability}%`, 'DEAL_SAME_STAGE');
      const closedOn = isOpenStage(input.stage) ? null : r.closes ? toDbDate(todayIst()) : d.closedOn;
      const lostReason = input.stage === 'LOST' ? input.lostReason!.trim() : null;
      await tx.crmDeal.update({ where: { id }, data: { stage: input.stage, probability: r.probability, closedOn, lostReason } });
      await this.activity(tx, org.id, actor, { dealId: id }, 'STAGE_CHANGED', lostReason, { from: d.stage, to: input.stage, probabilityFrom: d.probability, probability: r.probability, reopened: r.reopens });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: r.reopens ? 'crm.deal.reopened' : input.stage === 'WON' ? 'crm.deal.won' : input.stage === 'LOST' ? 'crm.deal.lost' : 'crm.deal.stage_changed', entityType: 'crm_deal', entityId: id, data: { from: d.stage, to: input.stage, probability: r.probability, lostReason } });
    });
    return this.getDeal(org, id);
  }

  // ------------------------------------------------------------------ activities

  async logActivity(org: CrmOrg, actor: Actor, input: { leadId?: string | null; dealId?: string | null; kind: ActivityKindInput; body: string }) {
    if (!input.leadId === !input.dealId) this.invalid('Log the activity on one lead or one deal', 'CRM_ACTIVITY_TARGET');
    const body = input.body.trim();
    if (!body) this.invalid('Write what happened', 'CRM_ACTIVITY_EMPTY');
    await this.prisma.$transaction(async (tx) => {
      if (input.leadId) {
        const l = await tx.crmLead.findFirst({ where: { id: input.leadId, orgId: org.id }, select: { id: true } });
        if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Lead not found' });
        // A converted lead is frozen, but its timeline can still grow.
        await this.activity(tx, org.id, actor, { leadId: l.id }, input.kind, body);
      } else {
        const d = await tx.crmDeal.findFirst({ where: { id: input.dealId!, orgId: org.id }, select: { id: true } });
        if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Deal not found' });
        await this.activity(tx, org.id, actor, { dealId: d.id }, input.kind, body);
      }
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'crm.activity.logged', entityType: input.leadId ? 'crm_lead' : 'crm_deal', entityId: input.leadId ?? input.dealId!, data: { kind: input.kind } });
    });
    return input.leadId ? this.getLead(org, input.leadId) : this.getDeal(org, input.dealId!);
  }
}
