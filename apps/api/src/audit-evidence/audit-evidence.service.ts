import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { evidenceOverdue, evidenceReviewIssue, evidenceSubmitIssue, evidenceSummary, type EvidenceStatus } from '@talk2tax/accounting-engine';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { auditEngagements, type AuditEngagementDoc } from '../db/collections/audit-engagements';
import { auditEvidenceRequests, type AuditEvidenceRequestDoc } from '../db/collections/audit-evidence';
import { users } from '../db/collections/identity';
import { attachments } from '../db/collections/sales';
import { memberships } from '../db/collections/tenancy';

export interface RequestInput {
  engagementId: string;
  title: string;
  details: string;
  ownerId: string;
  dueDate: string;
}

const ref = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

/**
 * Audit evidence management (AUDIT-003). The lead of an engagement asks a member for evidence by a
 * due date; the member (or the lead) attaches files and submits them; the lead or reviewer, not
 * whoever submitted, accepts them or returns them with what is missing. Files on a request can be
 * added or replaced only while it waits for submission (see AttachmentsService), so accepted
 * evidence stays as accepted; the SHA-256 of each file is kept at submission. Needs audit.read.
 */
@Injectable()
export class AuditEvidenceService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  private async request(id: string) {
    const r = await this.store.collection(auditEvidenceRequests).findById(id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Evidence request not found' });
    return r;
  }

  private async engagement(id: string) {
    const e = await this.store.collection(auditEngagements).findById(id);
    if (!e) throw new DomainError('NOT_FOUND', 'Engagement not found', HttpStatus.NOT_FOUND);
    return e;
  }

  private async current(id: string) {
    const list = await this.store.collection(attachments).find({ entityType: 'AUDIT_EVIDENCE', entityId: id, removedAt: null, replacedById: null }, { projection: { content: 0 }, sort: { createdAt: 1 } });
    return list.map((a) => ({ attachmentId: a.id, fileName: a.fileName, sha256: a.sha256 }));
  }

  private async views(user: AuthUser, list: AuditEvidenceRequestDoc[], engagements: Map<string, AuditEngagementDoc>) {
    const names = await this.names(list.flatMap((r) => [r.ownerId, r.requestedById, ...(r.submittedById ? [r.submittedById] : []), ...(r.acceptedById ? [r.acceptedById] : []), ...r.history.map((h) => h.byId)]));
    const person = (id: string) => ({ id, name: names.get(id) ?? 'A former member' });
    const today = todayIso();
    return list.map((r) => {
      const e = engagements.get(r.engagementId)!;
      const dueDate = fromDbDate(r.dueDate);
      return {
        id: r.id,
        reference: ref('ER', r.number),
        engagement: { id: e.id, reference: ref('IA', e.number), name: e.name, status: e.status },
        title: r.title,
        details: r.details,
        owner: person(r.ownerId),
        dueDate,
        overdue: evidenceOverdue({ status: r.status, dueDate }, today),
        status: r.status,
        files: r.files,
        submittedBy: r.submittedById ? person(r.submittedById) : null,
        submittedAt: r.submittedAt?.toISOString() ?? null,
        acceptedBy: r.acceptedById ? person(r.acceptedById) : null,
        acceptedAt: r.acceptedAt?.toISOString() ?? null,
        history: r.history.map((h) => ({ at: h.at.toISOString(), by: person(h.byId), action: h.action, note: h.note })),
        requestedBy: person(r.requestedById),
        requestedAt: r.requestedAt.toISOString(),
        canUpload: e.status !== 'CLOSED' && r.status === 'REQUESTED' && (user.id === r.ownerId || user.id === e.leadId),
        canReview: !evidenceReviewIssue(e, r, user.id, 'ACCEPT', ''),
        mine: r.status === 'REQUESTED' && user.id === r.ownerId,
      };
    });
  }

  private async engagementsFor(list: AuditEvidenceRequestDoc[]) {
    const ids = [...new Set(list.map((r) => r.engagementId))];
    return new Map((ids.length ? await this.store.collection(auditEngagements).find({ id: { $in: ids } }) : []).map((e) => [e.id, e]));
  }

  /** Every request (or one engagement's), open ones first, with counts. */
  async list(user: AuthUser, q: { engagementId?: string; status?: EvidenceStatus }) {
    const all = await this.store.collection(auditEvidenceRequests).find(q.engagementId ? { engagementId: q.engagementId } : {}, { sort: { number: -1 } });
    const rows = await this.views(user, all, await this.engagementsFor(all));
    const order: Record<EvidenceStatus, number> = { SUBMITTED: 0, REQUESTED: 1, ACCEPTED: 2 };
    return {
      requests: rows.filter((r) => !q.status || r.status === q.status).sort((a, b) => order[a.status] - order[b.status] || b.reference.localeCompare(a.reference)),
      summary: { ...evidenceSummary(rows, todayIso()), mine: rows.filter((r) => r.mine).length },
    };
  }

  async get(user: AuthUser, id: string) {
    const r = await this.request(id);
    return (await this.views(user, [r], await this.engagementsFor([r])))[0]!;
  }

  /** The engagement lead asks a member for evidence, during planning or fieldwork. */
  async create(org: OrgContext, user: AuthUser, input: RequestInput) {
    const e = await this.engagement(input.engagementId);
    if (user.id !== e.leadId) throw new DomainError('NOT_LEAD', 'Only the engagement lead asks for evidence', HttpStatus.FORBIDDEN);
    if (e.status !== 'PLANNING' && e.status !== 'FIELDWORK') throw new DomainError('NOT_FIELDWORK', 'Evidence is asked for during planning or fieldwork', HttpStatus.CONFLICT);
    const m = await this.store.collection(memberships).findOne({ userId: input.ownerId });
    if (!m || !hasPermission(m.role as RoleName, 'audit.read')) throw new DomainError('NOT_ELIGIBLE', 'Ask a member who works on the books', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.ownerId === e.reviewerId) throw new DomainError('REVIEWER_ASKED', 'The reviewer accepts evidence, so ask someone else for it', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.dueDate < todayIso()) throw new DomainError('DUE_IN_PAST', 'The due date cannot be in the past', HttpStatus.UNPROCESSABLE_ENTITY);
    const now = new Date();
    const number = await this.store.nextTenantSequence('audit_evidence_request');
    const doc = await this.store.collection(auditEvidenceRequests).insertOne({
      number,
      engagementId: e.id,
      title: input.title.trim(),
      details: input.details.trim(),
      ownerId: input.ownerId,
      dueDate: toDbDate(input.dueDate),
      status: 'REQUESTED',
      files: [],
      submittedById: null,
      submittedAt: null,
      acceptedById: null,
      acceptedAt: null,
      history: [{ at: now, byId: user.id, action: 'Requested', note: '' }],
      requestedById: user.id,
      requestedAt: now,
    });
    await this.log(org, user, 'audit_evidence.requested', doc.id, { number, engagementId: e.id, title: doc.title, ownerId: doc.ownerId, dueDate: input.dueDate });
    return this.get(user, doc.id);
  }

  /** The person asked (or the lead) submits the files attached to the request. */
  async submit(org: OrgContext, user: AuthUser, id: string, note: string) {
    const r = await this.request(id);
    const e = await this.engagement(r.engagementId);
    const files = await this.current(id);
    const issue = evidenceSubmitIssue(e, r, user.id, files.length, note);
    if (issue) throw new DomainError(user.id !== r.ownerId && user.id !== e.leadId ? 'NOT_ALLOWED' : 'CANNOT_SUBMIT', issue, user.id !== r.ownerId && user.id !== e.leadId ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
    const now = new Date();
    const res = await this.store
      .collection(auditEvidenceRequests)
      .updateOne({ id, status: 'REQUESTED' }, { $set: { status: 'SUBMITTED', files, submittedById: user.id, submittedAt: now }, $push: { history: { at: now, byId: user.id, action: 'Submitted', note: note.trim() || files.map((f) => f.fileName).join(', ') } } });
    if (!res.matched) throw changed();
    await this.log(org, user, 'audit_evidence.submitted', id, { files: files.length, note: note.trim() });
    return this.get(user, id);
  }

  /** The lead or reviewer accepts the evidence, or returns it with what is missing. */
  async review(org: OrgContext, user: AuthUser, id: string, decision: 'ACCEPT' | 'RETURN', note: string) {
    const r = await this.request(id);
    const e = await this.engagement(r.engagementId);
    const issue = evidenceReviewIssue(e, r, user.id, decision, note);
    if (issue) {
      const forbidden = (user.id !== e.leadId && user.id !== e.reviewerId) || (r.status === 'SUBMITTED' && r.submittedById === user.id);
      throw new DomainError(forbidden ? 'NOT_ALLOWED' : 'CANNOT_REVIEW', issue, forbidden ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
    }
    const now = new Date();
    const accept = decision === 'ACCEPT';
    const set = accept ? { status: 'ACCEPTED', acceptedById: user.id, acceptedAt: now } : { status: 'REQUESTED', submittedById: null, submittedAt: null };
    const res = await this.store.collection(auditEvidenceRequests).updateOne({ id, status: 'SUBMITTED' }, { $set: set, $push: { history: { at: now, byId: user.id, action: accept ? 'Accepted' : 'Returned', note: note.trim() } } });
    if (!res.matched) throw changed();
    await this.log(org, user, accept ? 'audit_evidence.accepted' : 'audit_evidence.returned', id, { note: note.trim(), files: r.files.map((f) => f.sha256) });
    return this.get(user, id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'audit_evidence_request', entityId, data }));
  }
}

const changed = () => new DomainError('REQUEST_CHANGED', 'The evidence request changed while saving. Open it again.', HttpStatus.CONFLICT);
