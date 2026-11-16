import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, DEFAULT_ONBOARDING_REQUIREMENTS, DEFAULT_VENDOR_ONBOARDING_REQUIREMENTS, decisionAllowed, detailChecks, onboardingProgress, submitIssues, termsIssues, vendorDetailChecks, type OnboardingParty, type OnboardingStatus } from '@talk2tax/accounting-engine';
import { CustomerOnboarding, CustomerOnboardingCheck } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { CONTACTS } from '../db/collections/sales';
import { MovedTables } from '../db/moved-table';
import { lockRow } from '../db/locks';

type Actor = { id: string };
type Db = Tx | PrismaService;
export interface OnboardingOrg {
  id: string;
  role: RoleName;
  /** Customers (AR-003) or vendors (AP-002); each has its own onboardings, checklist and setting. */
  party: OnboardingParty;
}
const WHO: Record<OnboardingParty, { one: string; area: 'sales' | 'purchases' }> = { CUSTOMER: { one: 'Customer', area: 'sales' }, VENDOR: { one: 'Vendor', area: 'purchases' } };
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

/**
 * Customer onboarding (AR-003): the details, documents and credit terms collected about a new
 * customer, submitted and approved by a second person before the customer is invoiced. Approval
 * sets the credit limit and payment terms on the customer. A customer whose onboarding is not
 * approved cannot have invoices posted (DocumentsService.post asks assertCanInvoice).
 */
@Injectable()
export class CustomerOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly moved: MovedTables,
  ) {}

  private invalid(message: string, code = 'ONBOARDING_INVALID', status = HttpStatus.UNPROCESSABLE_ENTITY, details?: unknown): never {
    throw new DomainError(code, message, status, details);
  }

  private can(org: OnboardingOrg) {
    return { manage: hasPermission(org.role, `${WHO[org.party].area}.manage`), decide: hasPermission(org.role, 'approvals.decide'), setUp: hasPermission(org.role, 'org.manage') };
  }

  /** Called while posting an invoice: refuses a customer whose onboarding is not approved. */
  static async assertCanInvoice(tx: Tx, orgId: string, contact: { id: string; name: string }) {
    const o = await tx.customerOnboarding.findFirst({ where: { orgId, contactId: contact.id, party: 'CUSTOMER' }, select: { status: true } });
    if (o && o.status !== 'APPROVED') {
      const what = o.status === 'SUBMITTED' ? 'is waiting for approval' : o.status === 'REJECTED' ? 'was rejected' : 'is not finished';
      throw new DomainError('ONBOARDING_INCOMPLETE', `${contact.name}'s customer onboarding ${what}. Invoices to them post once it is approved.`, HttpStatus.CONFLICT);
    }
  }

  /** Called while posting a bill or paying a vendor: refuses a vendor whose onboarding is not approved. */
  static async assertCanPayOrBill(tx: Tx, orgId: string, contact: { id: string; name: string }, what: 'bills' | 'payments') {
    const o = await tx.customerOnboarding.findFirst({ where: { orgId, contactId: contact.id, party: 'VENDOR' }, select: { status: true } });
    if (o && o.status !== 'APPROVED') {
      const state = o.status === 'SUBMITTED' ? 'is waiting for approval' : o.status === 'REJECTED' ? 'was rejected' : 'is not finished';
      throw new DomainError('ONBOARDING_INCOMPLETE', `${contact.name}'s vendor onboarding ${state}. ${what === 'bills' ? 'Bills from them post' : 'They can be paid'} once it is approved.`, HttpStatus.CONFLICT);
    }
  }

  // ---------------------------------------------------------------------------------- settings

  /** The organisation's checklist, made from the defaults the first time it is needed. */
  private async requirements(tx: Tx, orgId: string, party: OnboardingParty) {
    const rows = await tx.customerOnboardingRequirement.findMany({ where: { orgId, party }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    if (rows.length) return rows;
    const defaults = party === 'VENDOR' ? DEFAULT_VENDOR_ONBOARDING_REQUIREMENTS : DEFAULT_ONBOARDING_REQUIREMENTS;
    await tx.customerOnboardingRequirement.createMany({ data: defaults.map((r, i) => ({ orgId, party, label: r.label, needsFile: r.needsFile, sortOrder: i + 1 })) });
    return tx.customerOnboardingRequirement.findMany({ where: { orgId, party }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
  }

  async settings(org: OnboardingOrg) {
    return this.prisma.$transaction(async (tx) => {
      const [s, reqs] = await Promise.all([tx.customerOnboardingSettings.findUnique({ where: { orgId_party: { orgId: org.id, party: org.party } } }), this.requirements(tx, org.id, org.party)]);
      return {
        required: !!s?.required,
        requirements: reqs.filter((r) => r.isActive).map((r) => ({ id: r.id, label: r.label, needsFile: r.needsFile })),
        can: this.can(org),
      };
    });
  }

  /**
   * Turn onboarding on or off for customers added from now on, and set the checklist. Items left
   * out are retired (onboardings already started keep their copy).
   */
  async saveSettings(org: OnboardingOrg, actor: Actor, input: { required: boolean; requirements: { id?: string | null; label: string; needsFile: boolean }[] }) {
    const labels = input.requirements.map((r) => r.label.trim());
    if (labels.some((l) => !l)) this.invalid('Every checklist item needs a description');
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) this.invalid('Two checklist items have the same description');
    await this.prisma.$transaction(async (tx) => {
      const existing = await this.requirements(tx, org.id, org.party);
      const keep: string[] = [];
      for (const [i, r] of input.requirements.entries()) {
        const found = r.id ? existing.find((e) => e.id === r.id) : undefined;
        if (r.id && !found) this.invalid('A checklist item is not one of this organisation\'s');
        if (found) {
          keep.push(found.id);
          await tx.customerOnboardingRequirement.update({ where: { id: found.id }, data: { label: r.label.trim(), needsFile: r.needsFile, sortOrder: i + 1, isActive: true } });
        } else {
          keep.push((await tx.customerOnboardingRequirement.create({ data: { orgId: org.id, party: org.party, label: r.label.trim(), needsFile: r.needsFile, sortOrder: i + 1 } })).id);
        }
      }
      await tx.customerOnboardingRequirement.updateMany({ where: { orgId: org.id, party: org.party, id: { notIn: keep }, isActive: true }, data: { isActive: false } });
      await tx.customerOnboardingSettings.upsert({ where: { orgId_party: { orgId: org.id, party: org.party } }, create: { orgId: org.id, party: org.party, required: input.required, updatedById: actor.id }, update: { required: input.required, updatedById: actor.id, updatedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.settings_saved`, entityType: 'organization', entityId: org.id, data: { party: org.party, required: input.required, requirements: labels } });
    });
    return this.settings(org);
  }

  // ---------------------------------------------------------------------------------- onboardings

  /** Every onboarding, newest first, with where it stands. */
  async list(org: OnboardingOrg, f: { status?: OnboardingStatus }) {
    const [rows, country] = await Promise.all([
      this.prisma.customerOnboarding.findMany({ where: { orgId: org.id, party: org.party, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 }),
      this.country(org.id),
    ]);
    const [contacts, checks, files, banks] = await Promise.all([
      this.prisma.contact.findMany({ where: { orgId: org.id, id: { in: rows.map((r) => r.contactId) } } }),
      this.prisma.customerOnboardingCheck.findMany({ where: { orgId: org.id, onboardingId: { in: rows.map((r) => r.id) } } }),
      this.liveFiles(org.id, rows.map((r) => r.id)),
      org.party === 'VENDOR' ? this.prisma.vendorBankDetails.findMany({ where: { orgId: org.id, contactId: { in: rows.map((r) => r.contactId) }, verifiedAt: { not: null } }, select: { contactId: true } }) : Promise.resolve([]),
    ]);
    const verified = new Set(banks.map((b) => b.contactId));
    const s = await this.prisma.customerOnboardingSettings.findUnique({ where: { orgId_party: { orgId: org.id, party: org.party } } });
    const counts = { OPEN: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0 } as Record<OnboardingStatus, number>;
    for (const r of rows) counts[r.status as OnboardingStatus]++;
    return {
      required: !!s?.required,
      onboardings: rows.map((o) => {
        const c = contacts.find((x) => x.id === o.contactId)!;
        const { details, items } = this.state(o, c, checks.filter((k) => k.onboardingId === o.id), files, country, verified.has(o.contactId));
        return { id: o.id, status: o.status, contact: { id: c.id, name: c.name }, progress: onboardingProgress(details, items), creditLimit: o.creditLimit ? new D(o.creditLimit.toString()).toFixed(2) : null, paymentTermsDays: o.paymentTermsDays, submittedAt: o.submittedAt?.toISOString() ?? null, decidedAt: o.decidedAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString() };
      }),
      counts,
      can: this.can(org),
    };
  }

  private async country(orgId: string) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { countryCode: true } });
    return o.countryCode;
  }

  private async liveFiles(orgId: string, onboardingIds: string[]) {
    if (!onboardingIds.length) return new Set<string>();
    const rows = await this.prisma.attachment.findMany({ where: { orgId, entityType: 'CUSTOMER_ONBOARDING', entityId: { in: onboardingIds }, removedAt: null }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  private state(o: CustomerOnboarding, c: { email: string | null; address: string | null; pincode: string | null; gstin: string | null; pan: string | null; taxId: string | null }, checks: CustomerOnboardingCheck[], files: Set<string>, country: string, bankVerified = false) {
    const details = o.party === 'VENDOR' ? vendorDetailChecks(c, { bankVerified, paymentTermsDays: o.paymentTermsDays }, country) : detailChecks(c, { creditLimit: o.creditLimit?.toString() ?? null, paymentTermsDays: o.paymentTermsDays }, country);
    const items = checks.sort((a, b) => a.sortOrder - b.sortOrder).map((k) => ({ label: k.label, needsFile: k.needsFile, done: k.done, hasFile: !!k.attachmentId && files.has(k.attachmentId) }));
    return { details, items };
  }

  /** A customer's onboarding (null when there is none), with its checklist and what stops it moving on. */
  async forContact(org: OnboardingOrg, contactId: string) {
    const c = await this.prisma.contact.findFirst({ where: { id: contactId, orgId: org.id } });
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: `${WHO[org.party].one} not found` });
    const o = await this.prisma.customerOnboarding.findFirst({ where: { orgId: org.id, contactId, party: org.party } });
    if (!o) return { onboarding: null, can: { ...this.can(org), start: this.can(org).manage && (org.party === 'VENDOR' ? c.isVendor : c.isCustomer) } };
    return { onboarding: await this.detail(org, o.id), can: this.can(org) };
  }

  async detail(org: OnboardingOrg, id: string) {
    const o = await this.prisma.customerOnboarding.findFirst({ where: { id, orgId: org.id, party: org.party } });
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: `${WHO[org.party].one} onboarding not found` });
    // Onboardings started on their own (a customer added while onboarding is required) get the checklist when first opened.
    if (o.status === 'OPEN') await this.prisma.$transaction((tx) => this.ensureChecks(tx, org.id, o.id, org.party));
    const [c, checks, country, files] = await Promise.all([
      this.prisma.contact.findUniqueOrThrow({ where: { id: o.contactId } }),
      this.prisma.customerOnboardingCheck.findMany({ where: { orgId: org.id, onboardingId: o.id }, orderBy: { sortOrder: 'asc' } }),
      this.country(org.id),
      this.prisma.attachment.findMany({ where: { orgId: org.id, entityType: 'CUSTOMER_ONBOARDING', entityId: o.id, removedAt: null }, select: { id: true, fileName: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    const live = new Set(files.map((f) => f.id));
    const bank = o.party === 'VENDOR' ? await this.prisma.vendorBankDetails.findFirst({ where: { orgId: org.id, contactId: o.contactId }, select: { verifiedAt: true } }) : null;
    const { details, items } = this.state(o, c, checks, live, country, !!bank?.verifiedAt);
    const people = await this.prisma.user.findMany({ where: { id: { in: [o.submittedById, o.decidedById, ...checks.map((k) => k.doneById)].filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    const who = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
    const others = o.status === 'SUBMITTED' && o.submittedById ? await this.otherApprovers(this.prisma, org.id, o.submittedById) : 0;
    return {
      id: o.id,
      party: o.party as OnboardingParty,
      status: o.status as OnboardingStatus,
      contact: { id: c.id, name: c.name, creditLimit: c.creditLimit ? new D(c.creditLimit.toString()).toFixed(2) : null, paymentTermsDays: c.paymentTermsDays },
      creditLimit: o.creditLimit ? new D(o.creditLimit.toString()).toFixed(2) : null,
      paymentTermsDays: o.paymentTermsDays,
      notes: o.notes,
      details,
      checks: checks.map((k) => ({ id: k.id, label: k.label, needsFile: k.needsFile, done: k.done, doneBy: who(k.doneById), doneAt: k.doneAt?.toISOString() ?? null, note: k.note, file: k.attachmentId ? (files.find((f) => f.id === k.attachmentId) ?? { id: k.attachmentId, fileName: 'Removed file' }) : null, fileRemoved: !!k.attachmentId && !live.has(k.attachmentId) })),
      files,
      progress: onboardingProgress(details, items),
      issues: submitIssues(details, items),
      submittedBy: who(o.submittedById),
      submittedAt: o.submittedAt?.toISOString() ?? null,
      decidedBy: who(o.decidedById),
      decidedAt: o.decidedAt?.toISOString() ?? null,
      decisionNote: o.decisionNote,
      selfApproved: o.selfApproved,
      // Whether whoever submitted it could decide alone (nobody else can approve).
      submitterMayDecide: others === 0,
      createdAt: o.createdAt.toISOString(),
    };
  }

  private async otherApprovers(db: Db, orgId: string, userId: string) {
    const members = await db.membership.findMany({ where: { orgId, userId: { not: userId } }, select: { role: true } });
    return members.filter((m) => hasPermission(m.role as RoleName, 'approvals.decide')).length;
  }

  private async lock(tx: Tx, org: OnboardingOrg, id: string) {
    await lockRow(tx, 'customer_onboardings', id, org.id);
    const o = await tx.customerOnboarding.findFirst({ where: { id, orgId: org.id, party: org.party } });
    if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Onboarding not found' });
    return o;
  }

  /** Copy the organisation's current checklist into an onboarding that has no items yet. */
  private async ensureChecks(tx: Tx, orgId: string, onboardingId: string, party: OnboardingParty) {
    if (await tx.customerOnboardingCheck.count({ where: { onboardingId } })) return;
    const reqs = (await this.requirements(tx, orgId, party)).filter((r) => r.isActive);
    if (reqs.length) await tx.customerOnboardingCheck.createMany({ data: reqs.map((r) => ({ orgId, onboardingId, requirementId: r.id, label: r.label, needsFile: r.needsFile, sortOrder: r.sortOrder })) });
  }

  /** Start onboarding a customer by hand (customers added while it is required start on their own). */
  async start(org: OnboardingOrg, actor: Actor, contactId: string) {
    const id = await this.prisma.$transaction(async (tx) => {
      const c = await tx.contact.findFirst({ where: { id: contactId, orgId: org.id } });
      const vendor = org.party === 'VENDOR';
      if (!c || !(vendor ? c.isVendor : c.isCustomer)) throw new NotFoundException({ error: 'NOT_FOUND', message: `${WHO[org.party].one} not found` });
      const existing = await tx.customerOnboarding.findFirst({ where: { orgId: org.id, contactId, party: org.party } });
      if (existing) this.invalid(`${c.name} already has a ${vendor ? 'vendor' : 'customer'} onboarding`, 'ONBOARDING_EXISTS', HttpStatus.CONFLICT);
      const o = await tx.customerOnboarding.create({ data: { orgId: org.id, contactId, party: org.party, createdById: actor.id, creditLimit: vendor ? null : c.creditLimit, paymentTermsDays: c.paymentTermsDays } });
      await this.ensureChecks(tx, org.id, o.id, org.party);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.started`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: o.id, data: { contactId, name: c.name } });
      return o.id;
    });
    return this.detail(org, id);
  }

  /** Propose credit terms and notes while it is in progress. */
  async update(org: OnboardingOrg, actor: Actor, id: string, input: { creditLimit?: string | null; paymentTermsDays?: number | null; notes?: string | null }) {
    if (org.party === 'VENDOR' && input.creditLimit != null) this.invalid('A vendor onboarding agrees payment terms only, not a credit limit');
    const issues = termsIssues(input.creditLimit ?? null, input.paymentTermsDays ?? null);
    if (issues.length) this.invalid(issues[0]!, 'ONBOARDING_INVALID', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'OPEN') this.invalid('This onboarding is not in progress', 'ONBOARDING_NOT_OPEN', HttpStatus.CONFLICT);
      await this.ensureChecks(tx, org.id, id, org.party);
      const data = {
        ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit === null ? null : new D(input.creditLimit).toFixed() } : {}),
        ...(input.paymentTermsDays !== undefined ? { paymentTermsDays: input.paymentTermsDays } : {}),
        ...(input.notes !== undefined ? { notes: clean(input.notes) } : {}),
      };
      await tx.customerOnboarding.update({ where: { id }, data });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.updated`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: id, data });
    });
    return this.detail(org, id);
  }

  /** Tick or untick a checklist item; an item that needs a file names one attached to the onboarding. */
  async setCheck(org: OnboardingOrg, actor: Actor, id: string, checkId: string, input: { done: boolean; attachmentId?: string | null; note?: string | null }) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'OPEN') this.invalid('This onboarding is not in progress; take it back to change it', 'ONBOARDING_NOT_OPEN', HttpStatus.CONFLICT);
      const k = await tx.customerOnboardingCheck.findFirst({ where: { id: checkId, onboardingId: id, orgId: org.id } });
      if (!k) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Checklist item not found' });
      const attachmentId = input.attachmentId === undefined ? k.attachmentId : input.attachmentId;
      if (attachmentId) {
        const a = await tx.attachment.findFirst({ where: { id: attachmentId, orgId: org.id, entityType: 'CUSTOMER_ONBOARDING', entityId: id, removedAt: null } });
        if (!a) this.invalid('Choose a file attached to this onboarding');
      }
      if (input.done && k.needsFile && !attachmentId) this.invalid(`${k.label}: attach the file first`);
      await tx.customerOnboardingCheck.update({
        where: { id: checkId },
        data: { done: input.done, doneById: input.done ? actor.id : null, doneAt: input.done ? new Date() : null, attachmentId: attachmentId ?? null, ...(input.note !== undefined ? { note: clean(input.note) } : {}) },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.${input.done ? 'check_done' : 'check_undone'}`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: id, data: { check: k.label, attachmentId: attachmentId ?? null } });
    });
    return this.detail(org, id);
  }

  /** Submit for approval once everything is in. */
  async submit(org: OnboardingOrg, actor: Actor, id: string) {
    const d = await this.detail(org, id);
    if (d.status !== 'OPEN') this.invalid('This onboarding is not in progress', 'ONBOARDING_NOT_OPEN', HttpStatus.CONFLICT);
    if (d.issues.length) this.invalid(d.issues[0]!, 'ONBOARDING_INCOMPLETE', HttpStatus.UNPROCESSABLE_ENTITY, { issues: d.issues });
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'OPEN') this.invalid('This onboarding is not in progress', 'ONBOARDING_NOT_OPEN', HttpStatus.CONFLICT);
      await tx.customerOnboarding.update({ where: { id }, data: { status: 'SUBMITTED', submittedById: actor.id, submittedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.submitted`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: id, data: { name: d.contact.name, creditLimit: d.creditLimit, paymentTermsDays: d.paymentTermsDays } });
    });
    return this.detail(org, id);
  }

  /** Take a submitted onboarding back to change it (before it is decided). */
  async withdraw(org: OnboardingOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'SUBMITTED') this.invalid('Only an onboarding waiting for approval can be taken back', 'ONBOARDING_NOT_SUBMITTED', HttpStatus.CONFLICT);
      await tx.customerOnboarding.update({ where: { id }, data: { status: 'OPEN', submittedById: null, submittedAt: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.withdrawn`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: id, data: {} });
    });
    return this.detail(org, id);
  }

  /**
   * Approve (setting the customer's credit limit and payment terms) or reject with a reason. Needs
   * approvals.decide and someone other than who submitted it, unless nobody else can approve.
   */
  async decide(org: OnboardingOrg, actor: Actor, id: string, input: { approve: boolean; note?: string | null }) {
    if (!this.can(org).decide) throw new DomainError('FORBIDDEN', 'Deciding on a customer onboarding needs approvals.decide', HttpStatus.FORBIDDEN);
    const note = clean(input.note);
    if (!input.approve && !note) this.invalid('Give the reason for rejecting it');
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'SUBMITTED') this.invalid('Only an onboarding waiting for approval can be decided', 'ONBOARDING_NOT_SUBMITTED', HttpStatus.CONFLICT);
      const rule = decisionAllowed(o.submittedById!, actor.id, await this.otherApprovers(tx, org.id, actor.id));
      if (!rule.allowed) this.invalid(rule.reason!, 'SAME_PERSON', HttpStatus.CONFLICT);
      const c = await tx.contact.findUniqueOrThrow({ where: { id: o.contactId } });
      await tx.customerOnboarding.update({ where: { id }, data: { status: input.approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: note, selfApproved: input.approve && rule.selfApproved } });
      if (input.approve) await this.moved.update(tx, CONTACTS, org.id, c.id, { ...(o.party === 'VENDOR' ? {} : { creditLimit: o.creditLimit }), paymentTermsDays: o.paymentTermsDays!, updatedAt: new Date() });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: `${org.party.toLowerCase()}_onboarding.${input.approve ? 'approved' : 'rejected'}`,
        entityType: `${org.party.toLowerCase()}_onboarding`,
        entityId: id,
        data: { name: c.name, note, ...(input.approve ? { creditLimit: o.creditLimit?.toString() ?? null, paymentTermsDays: o.paymentTermsDays, selfApproved: rule.selfApproved, before: { creditLimit: c.creditLimit?.toString() ?? null, paymentTermsDays: c.paymentTermsDays } } : {}) },
      });
    });
    return this.detail(org, id);
  }

  /** Reopen a rejected onboarding to fix what was missing. */
  async reopen(org: OnboardingOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const o = await this.lock(tx, org, id);
      if (o.status !== 'REJECTED') this.invalid('Only a rejected onboarding can be reopened', 'ONBOARDING_NOT_REJECTED', HttpStatus.CONFLICT);
      await tx.customerOnboarding.update({ where: { id }, data: { status: 'OPEN', submittedById: null, submittedAt: null, decidedById: null, decidedAt: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `${org.party.toLowerCase()}_onboarding.reopened`, entityType: `${org.party.toLowerCase()}_onboarding`, entityId: id, data: { rejectedFor: o.decisionNote } });
    });
    return this.detail(org, id);
  }
}
