import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { engagementMoveIssue, engagementProgress, sampleProgress, stepDoneIssue, stepReviewIssue, type EngagementStatus } from '@talk2tax/accounting-engine';
import { hasPermission, type Permission, type RoleName } from '@talk2tax/security';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { auditEngagements, type AuditEngagementDoc } from '../db/collections/audit-engagements';
import { auditFindings } from '../db/collections/audit-findings';
import { auditSamples } from '../db/collections/audit-samples';
import { users } from '../db/collections/identity';
import { memberships } from '../db/collections/tenancy';

export interface CreateInput {
  name: string;
  objective: string;
  scopeFrom: string;
  scopeTo: string;
  leadId: string;
  reviewerId: string;
}

const ref = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;
const MAX_STEPS = 100;

/**
 * Internal audit workspace (AUDIT-001). Anyone with audit.read sees engagements and starts one,
 * naming a lead and a reviewer (who can approve, and is not the lead). The lead plans the work
 * programme and moves the engagement on; each step is done by its assignee or the lead; the
 * reviewer signs steps off, sends work back, and closes the engagement with its conclusion.
 * Every change is kept on the engagement and audited.
 */
@Injectable()
export class AuditEngagementsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  private async engagement(id: string) {
    const e = await this.store.collection(auditEngagements).findById(id);
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Engagement not found' });
    return e;
  }

  private async member(userId: string, permission: Permission, message: string) {
    const m = await this.store.collection(memberships).findOne({ userId });
    if (!m || !hasPermission(m.role as RoleName, permission)) throw new DomainError('NOT_ELIGIBLE', message, HttpStatus.UNPROCESSABLE_ENTITY);
  }

  private async openSamples(e: AuditEngagementDoc) {
    return e.sampleIds.length ? this.store.collection(auditSamples).count({ id: { $in: e.sampleIds }, status: 'OPEN' }) : 0;
  }

  private async view(e: AuditEngagementDoc, user: AuthUser) {
    const [samples, findings] = await Promise.all([
      e.sampleIds.length ? this.store.collection(auditSamples).find({ id: { $in: e.sampleIds } }) : [],
      e.findingIds.length ? this.store.collection(auditFindings).find({ id: { $in: e.findingIds } }) : [],
    ]);
    const names = await this.names([e.leadId, e.reviewerId, e.createdById, ...e.steps.flatMap((s) => [s.assigneeId, s.doneById, s.signedOffById].filter((x): x is string => !!x)), ...e.history.map((h) => h.byId)]);
    const person = (id: string) => ({ id, name: names.get(id) ?? 'A former member' });
    const bySample = new Map(samples.map((s) => [s.id, s]));
    const byFinding = new Map(findings.map((f) => [f.id, f]));
    const isLead = user.id === e.leadId;
    const isReviewer = user.id === e.reviewerId;
    return {
      id: e.id,
      reference: ref('IA', e.number),
      name: e.name,
      objective: e.objective,
      scopeFrom: fromDbDate(e.scopeFrom),
      scopeTo: fromDbDate(e.scopeTo),
      lead: person(e.leadId),
      reviewer: person(e.reviewerId),
      status: e.status,
      progress: engagementProgress(e.steps),
      steps: e.steps.map((s) => ({
        id: s.id,
        title: s.title,
        assignee: person(s.assigneeId),
        status: s.status,
        work: s.work,
        doneBy: s.doneById ? person(s.doneById) : null,
        doneAt: s.doneAt?.toISOString() ?? null,
        signedOffBy: s.signedOffById ? person(s.signedOffById) : null,
        signedOffAt: s.signedOffAt?.toISOString() ?? null,
        canDo: !stepDoneIssue(e, s, user.id, 'x'.repeat(10)),
        canReview: !stepReviewIssue(e, s, user.id, 'SIGN_OFF', ''),
      })),
      samples: e.sampleIds.map((id) => bySample.get(id)).filter((s) => !!s).map((s) => ({ id: s.id, reference: ref('S', s.number), name: s.name, status: s.status, progress: sampleProgress(s.items) })),
      findings: e.findingIds.map((id) => byFinding.get(id)).filter((f) => !!f).map((f) => ({ id: f.id, reference: ref('F', f.number), title: f.title, severity: f.severity, status: f.status })),
      conclusion: e.conclusion,
      history: e.history.map((h) => ({ at: h.at.toISOString(), by: person(h.byId), action: h.action, note: h.note })),
      createdBy: person(e.createdById),
      createdAt: e.createdAt.toISOString(),
      closedAt: e.closedAt?.toISOString() ?? null,
      canPlan: isLead && (e.status === 'PLANNING' || e.status === 'FIELDWORK'),
      canLink: isLead && e.status !== 'CLOSED',
      isLead,
      isReviewer,
    };
  }

  /** Every engagement, newest first, with who can be lead, reviewer or assignee. */
  async list(user: AuthUser) {
    const all = await this.store.collection(auditEngagements).find({}, { sort: { number: -1 } });
    const members = await this.store.collection(memberships).find({});
    const names = await this.names([...members.map((m) => m.userId), ...all.flatMap((e) => [e.leadId, e.reviewerId])]);
    const people = (p: Permission) => members.filter((m) => hasPermission(m.role as RoleName, p)).map((m) => ({ id: m.userId, name: names.get(m.userId) ?? 'A member' })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      engagements: all.map((e) => ({
        id: e.id,
        reference: ref('IA', e.number),
        name: e.name,
        scopeFrom: fromDbDate(e.scopeFrom),
        scopeTo: fromDbDate(e.scopeTo),
        lead: { id: e.leadId, name: names.get(e.leadId) ?? 'A former member' },
        reviewer: { id: e.reviewerId, name: names.get(e.reviewerId) ?? 'A former member' },
        status: e.status,
        progress: engagementProgress(e.steps),
        mine: e.leadId === user.id || e.reviewerId === user.id || e.steps.some((s) => s.assigneeId === user.id && s.status === 'OPEN'),
      })),
      members: people('audit.read'),
      reviewers: people('approvals.decide'),
    };
  }

  async get(user: AuthUser, id: string) {
    return this.view(await this.engagement(id), user);
  }

  /** The samples and findings the lead can link: every one not linked yet. */
  async linkable(id: string) {
    const e = await this.engagement(id);
    const [samples, findings] = await Promise.all([this.store.collection(auditSamples).find({}, { sort: { number: -1 } }), this.store.collection(auditFindings).find({}, { sort: { number: -1 } })]);
    return {
      samples: samples.filter((s) => !e.sampleIds.includes(s.id)).map((s) => ({ id: s.id, label: `${ref('S', s.number)} ${s.name}` })),
      findings: findings.filter((f) => !e.findingIds.includes(f.id)).map((f) => ({ id: f.id, label: `${ref('F', f.number)} ${f.title}` })),
    };
  }

  async create(org: OrgContext, user: AuthUser, input: CreateInput) {
    if (input.scopeTo < input.scopeFrom) throw new DomainError('INVALID_SCOPE', 'The scope ends before it starts', HttpStatus.UNPROCESSABLE_ENTITY);
    if (input.leadId === input.reviewerId) throw new DomainError('SAME_PERSON', 'The reviewer must be someone other than the lead', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.member(input.leadId, 'audit.read', 'The lead must be a member who works on the books');
    await this.member(input.reviewerId, 'approvals.decide', 'The reviewer must be a member who can approve');
    const now = new Date();
    const number = await this.store.nextTenantSequence('audit_engagement');
    const doc = await this.store.collection(auditEngagements).insertOne({
      number,
      name: input.name.trim(),
      objective: input.objective.trim(),
      scopeFrom: toDbDate(input.scopeFrom),
      scopeTo: toDbDate(input.scopeTo),
      leadId: input.leadId,
      reviewerId: input.reviewerId,
      status: 'PLANNING',
      steps: [],
      sampleIds: [],
      findingIds: [],
      conclusion: null,
      history: [{ at: now, byId: user.id, action: 'Started', note: '' }],
      createdById: user.id,
      createdAt: now,
      closedAt: null,
    });
    await this.log(org, user, 'audit_engagement.created', doc.id, { number, name: doc.name, scopeFrom: input.scopeFrom, scopeTo: input.scopeTo, leadId: input.leadId, reviewerId: input.reviewerId });
    return this.get(user, doc.id);
  }

  /** The lead adds a step to the work programme, during planning or fieldwork. */
  async addStep(org: OrgContext, user: AuthUser, id: string, input: { title: string; assigneeId: string }) {
    const e = await this.engagement(id);
    if (user.id !== e.leadId) throw new DomainError('NOT_LEAD', 'Only the engagement lead plans the work', HttpStatus.FORBIDDEN);
    if (e.status !== 'PLANNING' && e.status !== 'FIELDWORK') throw new DomainError('NOT_PLANNING', 'Steps are added during planning or fieldwork', HttpStatus.CONFLICT);
    if (e.steps.length >= MAX_STEPS) throw new DomainError('TOO_MANY_STEPS', `An engagement has at most ${MAX_STEPS} steps`, HttpStatus.CONFLICT);
    if (input.assigneeId === e.reviewerId) throw new DomainError('REVIEWER_ASSIGNED', 'The reviewer signs off the work, so assign the step to someone else', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.member(input.assigneeId, 'audit.read', 'Assign the step to a member who works on the books');
    const step = { id: randomUUID(), title: input.title.trim(), assigneeId: input.assigneeId, status: 'OPEN' as const, work: null, doneById: null, doneAt: null, signedOffById: null, signedOffAt: null };
    const r = await this.store.collection(auditEngagements).updateOne({ id, status: e.status, steps: { $size: e.steps.length } }, { $push: { steps: step, history: { at: new Date(), byId: user.id, action: 'Step added', note: step.title } } });
    if (!r.matched) throw changed();
    await this.log(org, user, 'audit_engagement.step_added', id, { stepId: step.id, title: step.title, assigneeId: step.assigneeId });
    return this.get(user, id);
  }

  /** The assignee or lead records the work done on a step. */
  async doStep(org: OrgContext, user: AuthUser, id: string, stepId: string, work: string) {
    const e = await this.engagement(id);
    const i = e.steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Step not found' });
    const issue = stepDoneIssue(e, e.steps[i]!, user.id, work);
    if (issue) throw new DomainError('CANNOT_DO_STEP', issue, user.id !== e.steps[i]!.assigneeId && user.id !== e.leadId ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
    const now = new Date();
    const r = await this.store
      .collection(auditEngagements)
      .updateOne({ id, status: 'FIELDWORK', [`steps.${i}.id`]: stepId, [`steps.${i}.status`]: 'OPEN' }, { $set: { [`steps.${i}.status`]: 'DONE', [`steps.${i}.work`]: work.trim(), [`steps.${i}.doneById`]: user.id, [`steps.${i}.doneAt`]: now }, $push: { history: { at: now, byId: user.id, action: 'Step done', note: e.steps[i]!.title } } });
    if (!r.matched) throw changed();
    await this.log(org, user, 'audit_engagement.step_done', id, { stepId, work: work.trim() });
    return this.get(user, id);
  }

  /** The reviewer signs off a done step, or sends it back with a note. */
  async reviewStep(org: OrgContext, user: AuthUser, id: string, stepId: string, decision: 'SIGN_OFF' | 'REOPEN', note: string) {
    const e = await this.engagement(id);
    const i = e.steps.findIndex((s) => s.id === stepId);
    if (i < 0) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Step not found' });
    const s = e.steps[i]!;
    const issue = stepReviewIssue(e, s, user.id, decision, note);
    if (issue) throw new DomainError('CANNOT_REVIEW_STEP', issue, user.id !== e.reviewerId || s.doneById === user.id ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
    const now = new Date();
    const p = `steps.${i}`;
    const set = decision === 'SIGN_OFF' ? { [`${p}.status`]: 'SIGNED_OFF', [`${p}.signedOffById`]: user.id, [`${p}.signedOffAt`]: now } : { [`${p}.status`]: 'OPEN', [`${p}.doneById`]: null, [`${p}.doneAt`]: null };
    const event = { at: now, byId: user.id, action: decision === 'SIGN_OFF' ? 'Step signed off' : 'Step sent back', note: decision === 'SIGN_OFF' ? s.title : `${s.title}: ${note.trim()}` };
    const r = await this.store.collection(auditEngagements).updateOne({ id, status: e.status, [`${p}.id`]: stepId, [`${p}.status`]: 'DONE' }, { $set: set, $push: { history: event } });
    if (!r.matched) throw changed();
    await this.log(org, user, decision === 'SIGN_OFF' ? 'audit_engagement.step_signed_off' : 'audit_engagement.step_reopened', id, { stepId, note: note.trim() });
    return this.get(user, id);
  }

  /** The lead links a sample or finding the engagement uses. */
  async link(org: OrgContext, user: AuthUser, id: string, input: { kind: 'SAMPLE' | 'FINDING'; id: string }) {
    const e = await this.engagement(id);
    if (user.id !== e.leadId) throw new DomainError('NOT_LEAD', 'Only the engagement lead links samples and findings', HttpStatus.FORBIDDEN);
    if (e.status === 'CLOSED') throw new DomainError('CLOSED', 'This engagement is closed', HttpStatus.CONFLICT);
    const found = input.kind === 'SAMPLE' ? await this.store.collection(auditSamples).findById(input.id) : await this.store.collection(auditFindings).findById(input.id);
    if (!found) throw new DomainError('NOT_FOUND', input.kind === 'SAMPLE' ? 'Sample not found' : 'Finding not found', HttpStatus.NOT_FOUND);
    const field = input.kind === 'SAMPLE' ? 'sampleIds' : 'findingIds';
    if (e[field].includes(input.id)) throw new DomainError('ALREADY_LINKED', 'This is already linked to the engagement', HttpStatus.CONFLICT);
    const label = 'name' in found ? `${ref('S', found.number)} ${found.name}` : `${ref('F', found.number)} ${found.title}`;
    const r = await this.store.collection(auditEngagements).updateOne({ id, status: e.status, [field]: { $ne: input.id } }, { $push: { [field]: input.id, history: { at: new Date(), byId: user.id, action: input.kind === 'SAMPLE' ? 'Sample linked' : 'Finding linked', note: label } } });
    if (!r.matched) throw changed();
    await this.log(org, user, 'audit_engagement.linked', id, { kind: input.kind, id: input.id });
    return this.get(user, id);
  }

  /** The lead moves it to fieldwork or review; the reviewer sends it back or closes it with the conclusion. */
  async move(org: OrgContext, user: AuthUser, id: string, input: { status: EngagementStatus; note: string }) {
    const e = await this.engagement(id);
    const issue = engagementMoveIssue({ ...e, openSamples: await this.openSamples(e) }, input.status, user.id, input.note);
    if (issue) {
      const notYou = e.status !== 'CLOSED' && (e.status === 'REVIEW' ? user.id !== e.reviewerId : user.id !== e.leadId);
      throw new DomainError(notYou ? 'NOT_ALLOWED' : 'CANNOT_MOVE', issue, notYou ? HttpStatus.FORBIDDEN : HttpStatus.CONFLICT);
    }
    const now = new Date();
    const closing = input.status === 'CLOSED';
    const action = closing ? 'Closed' : input.status === 'FIELDWORK' ? (e.status === 'REVIEW' ? 'Sent back to fieldwork' : 'Fieldwork started') : 'Sent for review';
    const r = await this.store
      .collection(auditEngagements)
      .updateOne({ id, status: e.status, steps: { $size: e.steps.length } }, { $set: { status: input.status, ...(closing ? { conclusion: input.note.trim(), closedAt: now } : {}) }, $push: { history: { at: now, byId: user.id, action, note: input.note.trim() } } });
    if (!r.matched) throw changed();
    await this.log(org, user, closing ? 'audit_engagement.closed' : 'audit_engagement.moved', id, { from: e.status, to: input.status, note: input.note.trim() });
    return this.get(user, id);
  }

  private log(org: OrgContext, user: AuthUser, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action, entityType: 'audit_engagement', entityId, data }));
  }
}

const changed = () => new DomainError('ENGAGEMENT_CHANGED', 'The engagement changed while saving. Open it again.', HttpStatus.CONFLICT);
