import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_COMMUNICATION_POLICY, externalEmailDecision, type CommunicationDecision, type CommunicationPolicy, type MessageSource } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { OrgContext } from '../auth/decorators';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { communicationPolicies, contactEmailConsents } from '../db/collections/communication';
import { users } from '../db/collections/identity';
import { contacts } from '../db/collections/sales';

type Actor = { id: string };

/** How a message came to be sent, for the policy check. */
export interface MessageContext {
  source: MessageSource;
  aiDrafted?: boolean;
  approvedByPerson?: boolean;
  /** Addressed to a customer or vendor rather than to members. */
  toContact?: boolean;
}

/**
 * External communication policy (AR-043): contacts' email consent, the organisation's policy, and
 * the check every email the organisation sends goes through (MailerService.send). A refused email
 * is not sent and is recorded in the audit trail.
 */
@Injectable()
export class CommunicationPolicyService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private require(org: OrgContext, permission: Permission, what: string) {
    if (!hasPermission(org.role, permission)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
  }

  private inOrg<T>(orgId: string, fn: () => Promise<T>) {
    return tenantStorage.run({ orgId }, fn);
  }

  private log(orgId: string, actorId: string | null, action: string, entityType: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType, entityId, data }));
  }

  async policy(orgId: string): Promise<CommunicationPolicy & { updatedAt: string | null; updatedBy: string | null }> {
    const p = await this.inOrg(orgId, () => this.store.collection(communicationPolicies).findOne({}));
    if (!p) return { ...DEFAULT_COMMUNICATION_POLICY, updatedAt: null, updatedBy: null };
    const u = await this.inOrg(orgId, () => this.store.collection(users).findById(p.updatedById));
    return { automationsToContacts: p.automationsToContacts, updatedAt: p.updatedAt.toISOString(), updatedBy: u?.name ?? 'Former member' };
  }

  async setPolicy(org: OrgContext, actor: Actor, input: CommunicationPolicy) {
    this.require(org, 'org.manage', 'change the communication policy');
    const before = await this.policy(org.id);
    const fields = { automationsToContacts: input.automationsToContacts, updatedById: actor.id, updatedAt: new Date() };
    const existing = await this.store.collection(communicationPolicies).findOne({});
    if (existing) await this.store.collection(communicationPolicies).updateOne({ id: existing.id }, { $set: fields });
    else await this.store.collection(communicationPolicies).insertOne(fields);
    await this.log(org.id, actor.id, 'communication_policy.updated', 'communication_policy', org.id, { automationsToContacts: { from: before.automationsToContacts, to: input.automationsToContacts } });
    return this.overview(org);
  }

  /** The policy, and every contact who has opted out, for the settings page. */
  async overview(org: OrgContext) {
    this.require(org, 'contacts.read', 'see the communication policy');
    const [policy, optedOut] = await Promise.all([this.policy(org.id), this.optedOutContacts(org.id)]);
    return { policy, optedOut, canManage: hasPermission(org.role, 'org.manage') };
  }

  /** Each contact's latest consent record. */
  private async latest(orgId: string, contactIds?: string[]) {
    const rows = await this.inOrg(orgId, () => this.store.collection(contactEmailConsents).find(contactIds ? { contactId: { $in: contactIds } } : {}, { sort: { recordedAt: -1 } }));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.contactId)) latest.set(r.contactId, r);
    return latest;
  }

  async optedOutContacts(orgId: string) {
    const out = [...(await this.latest(orgId)).values()].filter((r) => r.status === 'OPTED_OUT');
    const cs = new Map((await this.inOrg(orgId, () => this.store.collection(contacts).find({ id: { $in: out.map((r) => r.contactId) } }, { projection: { id: 1, name: 1, email: 1, isCustomer: 1 } }))).map((c) => [c.id, c]));
    return out
      .map((r) => ({ contactId: r.contactId, name: cs.get(r.contactId)?.name ?? 'Deleted contact', email: cs.get(r.contactId)?.email ?? null, ledger: cs.get(r.contactId)?.isCustomer === false ? ('PURCHASES' as const) : ('SALES' as const), reason: r.reason, since: r.recordedAt.toISOString() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Addresses of contacts who opted out, with their names. */
  async optedOutEmails(orgId: string) {
    return new Map((await this.optedOutContacts(orgId)).filter((c) => c.email?.trim()).map((c) => [c.email!.trim().toLowerCase(), c.name]));
  }

  async contactOptedOut(orgId: string, contactId: string) {
    return (await this.latest(orgId, [contactId])).get(contactId)?.status === 'OPTED_OUT';
  }

  async consent(org: OrgContext, contactId: string) {
    this.require(org, 'contacts.read', 'see contacts');
    const c = await this.store.collection(contacts).findById(contactId);
    if (!c) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Contact not found' });
    const history = await this.store.collection(contactEmailConsents).find({ contactId }, { sort: { recordedAt: -1 } });
    const people = new Map((await this.store.collection(users).find({ id: { $in: [...new Set(history.map((h) => h.recordedById))] } }, { projection: { id: 1, name: 1 } })).map((u) => [u.id, u.name]));
    return {
      contactId,
      status: history[0]?.status ?? 'OPTED_IN',
      history: history.map((h) => ({ status: h.status, reason: h.reason, recordedBy: people.get(h.recordedById) ?? 'Former member', recordedAt: h.recordedAt.toISOString() })),
      canManage: hasPermission(org.role, 'contacts.manage'),
    };
  }

  async recordConsent(org: OrgContext, actor: Actor, contactId: string, input: { status: 'OPTED_OUT' | 'OPTED_IN'; reason: string }) {
    this.require(org, 'contacts.manage', 'change email consent');
    const now = await this.consent(org, contactId);
    if (now.status === input.status) throw new DomainError('NO_CHANGE', input.status === 'OPTED_OUT' ? 'This contact has already opted out of email' : 'This contact already receives email', HttpStatus.CONFLICT);
    const doc = await this.store.collection(contactEmailConsents).insertOne({ contactId, status: input.status, reason: input.reason.trim(), recordedById: actor.id, recordedAt: new Date() });
    await this.log(org.id, actor.id, input.status === 'OPTED_OUT' ? 'contact.email_opted_out' : 'contact.email_opted_in', 'contact', contactId, { consentId: doc.id, reason: input.reason.trim() });
    return this.consent(org, contactId);
  }

  /** Whether an email may go, without recording anything (safe inside another transaction). */
  async decide(orgId: string, recipients: string[], m: MessageContext): Promise<CommunicationDecision> {
    const [policy, optedOut] = await Promise.all([this.policy(orgId), this.optedOutEmails(orgId)]);
    return externalEmailDecision({ source: m.source, recipients, optedOut, policy, aiDrafted: !!m.aiDrafted, approvedByPerson: !!m.approvedByPerson, toContact: !!m.toContact });
  }

  /** Whether an email may go; a refusal is recorded in the audit trail. Call outside a transaction. */
  async check(orgId: string, recipients: string[], m: MessageContext, actorId: string | null = null): Promise<CommunicationDecision> {
    const d = await this.decide(orgId, recipients, m);
    if (!d.allowed) await this.log(orgId, actorId, 'communication.blocked', 'communication', orgId, { source: m.source, code: d.code, reason: d.reason, recipients: recipients.length });
    return d;
  }
}
