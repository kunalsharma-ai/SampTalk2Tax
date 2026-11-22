import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays } from '@talk2tax/accounting-engine';
import { hasPermission } from '@talk2tax/security';
import { COMPLIANCE_DOC_KIND_LABEL, complianceDocumentGaps, complianceRetainUntil, expectedComplianceDocument, type ComplianceDocKind } from '@talk2tax/tax-engine';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { ComplianceService } from '../compliance/compliance.service';
import { complianceDocuments, type ComplianceDocumentDoc } from '../db/collections/compliance-documents';
import { users } from '../db/collections/identity';
import { attachments } from '../db/collections/sales';

export interface ComplianceDocumentInput {
  kind: ComplianceDocKind;
  obligationKey?: string | null;
  title: string;
  reference?: string | null;
  note?: string | null;
}

const ref = (n: number) => `CD-${String(n).padStart(3, '0')}`;
/** How far back and ahead an obligation can be linked (the calendar reads at most 400 days). */
const LINK_BACK_DAYS = 365;
const LINK_AHEAD_DAYS = 30;

/**
 * Compliance document management (TAX-025): the acknowledgements, challans, copies of returns,
 * working papers, registration certificates and notices behind the compliance calendar, each
 * linked to its obligation (or kept for the organisation), with files attached and a date to keep
 * them until; and the returns marked filed and payments made in the last year that do not have
 * their acknowledgement or challan on file. Reading needs reports.read; adding, attaching and
 * voiding need accounts.manage (as marking a return filed does). Indian organisations only.
 */
@Injectable()
export class ComplianceDocumentsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly compliance: ComplianceService,
  ) {}

  private async india(org: OrgContext) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'Compliance documents follow the Indian compliance calendar', HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async files(ids: string[]) {
    const list = ids.length ? await this.store.collection(attachments).find({ entityType: 'COMPLIANCE_DOCUMENT', entityId: { $in: ids }, removedAt: null, replacedById: null }, { projection: { content: 0 }, sort: { createdAt: 1 } }) : [];
    const out = new Map<string, { id: string; fileName: string }[]>();
    for (const a of list) out.set(a.entityId, [...(out.get(a.entityId) ?? []), { id: a.id, fileName: a.fileName }]);
    return out;
  }

  private async views(list: ComplianceDocumentDoc[]) {
    const [files, people] = await Promise.all([
      this.files(list.map((d) => d.id)),
      (async () => {
        const ids = [...new Set(list.flatMap((d) => [d.createdById, ...(d.voidedById ? [d.voidedById] : [])]))];
        const us = ids.length ? await this.store.collection(users).find({ id: { $in: ids } }) : [];
        return new Map(us.map((u) => [u.id, u.name ?? u.email]));
      })(),
    ]);
    const name = (id: string) => people.get(id) ?? 'A former member';
    return list.map((d) => ({
      id: d.id,
      reference: ref(d.number),
      kind: d.kind,
      kindLabel: COMPLIANCE_DOC_KIND_LABEL[d.kind],
      obligation: d.obligationKey ? { key: d.obligationKey, name: d.obligationName, periodLabel: d.periodLabel } : null,
      title: d.title,
      documentReference: d.reference,
      note: d.note,
      retainUntil: d.retainUntil,
      status: d.status,
      voidReason: d.voidReason,
      voidedBy: d.voidedById ? name(d.voidedById) : null,
      voidedAt: d.voidedAt?.toISOString() ?? null,
      files: files.get(d.id) ?? [],
      addedBy: name(d.createdById),
      addedAt: d.createdAt.toISOString(),
    }));
  }

  async list(org: OrgContext, filter: { kind?: ComplianceDocKind; key?: string; includeVoid?: boolean }) {
    await this.india(org);
    const list = await this.store.collection(complianceDocuments).find({ ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.key ? { obligationKey: filter.key } : {}), ...(filter.includeVoid ? {} : { status: 'ACTIVE' }) }, { sort: { createdAt: -1, number: -1 } });
    return { canManage: hasPermission(org.role, 'accounts.manage'), items: await this.views(list) };
  }

  async get(org: OrgContext, id: string) {
    await this.india(org);
    const d = await this.store.collection(complianceDocuments).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Compliance document not found' });
    return { canManage: hasPermission(org.role, 'accounts.manage') && d.status === 'ACTIVE', ...(await this.views([d]))[0]! };
  }

  /** Obligations that can be linked: due in the last year or the next 30 days. */
  async obligations(org: OrgContext, today = todayIso()) {
    await this.india(org);
    const cal = await this.compliance.calendar(org.id, addDays(today, -LINK_BACK_DAYS), addDays(today, LINK_AHEAD_DAYS));
    return cal.items
      .filter((i) => i.status !== 'NOTHING_DUE')
      .sort((a, b) => b.dueDate.localeCompare(a.dueDate) || a.name.localeCompare(b.name))
      .map((i) => ({ key: i.key, name: i.name, periodLabel: i.periodLabel, periodTo: i.periodTo, dueDate: i.dueDate, nature: i.nature, status: i.status, expects: expectedComplianceDocument(i.nature) }));
  }

  async create(org: OrgContext, user: AuthUser, input: ComplianceDocumentInput, today = todayIso()) {
    await this.india(org);
    if (input.kind === 'REGISTRATION' && input.obligationKey) throw new DomainError('REGISTRATION_NOT_LINKED', 'A registration certificate belongs to the organisation, not to one return or payment', HttpStatus.UNPROCESSABLE_ENTITY);
    const ob = input.obligationKey ? (await this.obligations(org, today)).find((o) => o.key === input.obligationKey) : undefined;
    if (input.obligationKey && !ob) throw new DomainError('UNKNOWN_OBLIGATION', `No return or payment ${input.obligationKey} was due in the last year or is due in the next ${LINK_AHEAD_DAYS} days`, HttpStatus.UNPROCESSABLE_ENTITY);
    const number = await this.store.nextTenantSequence('compliance_document');
    const doc = await this.store.collection(complianceDocuments).insertOne({
      number,
      kind: input.kind,
      obligationKey: ob?.key ?? null,
      obligationName: ob?.name ?? null,
      periodLabel: ob?.periodLabel ?? null,
      title: input.title.trim(),
      reference: input.reference?.trim() || null,
      note: input.note?.trim() || null,
      retainUntil: input.kind === 'REGISTRATION' ? null : complianceRetainUntil(ob?.periodTo ?? today),
      status: 'ACTIVE',
      voidReason: null,
      voidedById: null,
      voidedAt: null,
      createdById: user.id,
      createdAt: new Date(),
    });
    await this.log(org, user, 'compliance_document.added', doc.id, { reference: ref(number), kind: doc.kind, obligationKey: doc.obligationKey, title: doc.title });
    return this.get(org, doc.id);
  }

  async void(org: OrgContext, user: AuthUser, id: string, reason: string) {
    const d = await this.store.collection(complianceDocuments).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Compliance document not found' });
    if (d.status === 'VOID') throw new DomainError('ALREADY_VOID', 'This document record is already void', HttpStatus.CONFLICT);
    const r = await this.store.collection(complianceDocuments).updateOne({ id, status: 'ACTIVE' }, { $set: { status: 'VOID', voidReason: reason.trim(), voidedById: user.id, voidedAt: new Date() } });
    if (!r.matched) throw new DomainError('CHANGED', 'The document changed meanwhile; reload and try again', HttpStatus.CONFLICT);
    await this.log(org, user, 'compliance_document.voided', id, { reference: ref(d.number), reason: reason.trim() });
    return this.get(org, id);
  }

  /** Returns marked filed and payments made, due in the last `days` days, without their acknowledgement or challan. */
  async gaps(org: OrgContext, days: number, today = todayIso()) {
    await this.india(org);
    const cal = await this.compliance.calendar(org.id, addDays(today, -days), today);
    const done = cal.items.filter((i) => i.status === 'DONE' && i.dueDate >= addDays(today, -days));
    const docs = done.length ? await this.store.collection(complianceDocuments).find({ status: 'ACTIVE', obligationKey: { $in: done.map((i) => i.key) } }) : [];
    const files = await this.files(docs.map((d) => d.id));
    const gaps = complianceDocumentGaps(
      done.map((i) => ({ key: i.key, name: i.name, periodLabel: i.periodLabel, dueDate: i.dueDate, nature: i.nature })),
      docs.map((d) => ({ obligationKey: d.obligationKey, kind: d.kind, files: files.get(d.id)?.length ?? 0 })),
    );
    return { configured: cal.configured, days, done: done.length, complete: done.length - gaps.length, items: gaps.map((g) => ({ ...g, needsLabel: COMPLIANCE_DOC_KIND_LABEL[g.needs] })) };
  }

  /** Who may see or change the files on a compliance document; see AttachmentsService. */
  async attachmentAccess(org: OrgContext, id: string, access: 'read' | 'manage') {
    const d = await this.store.collection(complianceDocuments).findById(id);
    if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Compliance document not found' });
    const permission = access === 'read' ? 'reports.read' : 'accounts.manage';
    if (!hasPermission(org.role, permission)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${access === 'read' ? 'see' : 'change'} compliance documents; it needs ${permission}`, HttpStatus.FORBIDDEN);
    if (access === 'manage' && d.status !== 'ACTIVE') throw new DomainError('DOCUMENT_VOID', 'Files cannot change on a void compliance document', HttpStatus.CONFLICT);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'compliance_document', entityId, data }));
  }
}
