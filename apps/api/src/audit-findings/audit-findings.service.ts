import { ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { addDays, FINDING_DAYS_TO_FIX, findingCloseIssue, findingMoveIssue, findingOverdue, passClearsFailure, type FindingSeverity, type FindingStatus } from '@talk2tax/accounting-engine';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { auditFindings, type AuditFindingDoc } from '../db/collections/audit-findings';
import { users } from '../db/collections/identity';
import { controlTests, internalControls } from '../db/collections/internal-controls';
import { memberships } from '../db/collections/tenancy';

export interface RaiseInput {
  title?: string;
  description?: string;
  severity: FindingSeverity;
  ownerId: string;
  plan: string;
  dueDate?: string;
  /** Raise it from a failed control test; the title and description then come from the test. */
  testId?: string;
}

/**
 * Audit findings and remediation (AUDIT-011, AUDIT-012). Reading and raising need audit.read.
 * The remediation owner (or an owner or admin) records progress; someone with approvals.decide
 * who is not the remediation owner closes it, and a finding from a failed control test only once
 * a later test of that control has passed. Every step is kept on the finding and audited.
 */
@Injectable()
export class AuditFindingsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async names(ids: string[]) {
    const list = ids.length ? await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } }) : [];
    return new Map(list.map((u) => [u.id, u.name ?? u.email]));
  }

  private async finding(id: string) {
    const f = await this.store.collection(auditFindings).findById(id);
    if (!f) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Finding not found' });
    return f;
  }

  private view(f: AuditFindingDoc, names: Map<string, string>, org: OrgContext, user: AuthUser, control: { id: string; title: string } | null) {
    const person = (id: string) => ({ id, name: names.get(id) ?? 'A former member' });
    const today = todayIso();
    return {
      id: f.id,
      reference: `F-${String(f.number).padStart(3, '0')}`,
      title: f.title,
      description: f.description,
      severity: f.severity,
      source: f.source,
      control,
      testPeriodKey: f.testPeriodKey,
      owner: person(f.ownerId),
      plan: f.plan,
      dueDate: fromDbDate(f.dueDate),
      overdue: findingOverdue({ status: f.status, dueDate: fromDbDate(f.dueDate) }, today),
      status: f.status,
      updates: f.updates.map((u) => ({ at: u.at.toISOString(), by: person(u.byId), status: u.status, note: u.note })),
      raisedBy: person(f.raisedById),
      raisedAt: f.raisedAt.toISOString(),
      closedBy: f.closedById ? person(f.closedById) : null,
      closedAt: f.closedAt?.toISOString() ?? null,
      canUpdate: f.status !== 'CLOSED' && (f.ownerId === user.id || hasPermission(org.role, 'org.manage')),
      canClose: f.status === 'READY_FOR_REVIEW' && f.ownerId !== user.id && hasPermission(org.role, 'approvals.decide'),
    };
  }

  private async views(org: OrgContext, user: AuthUser, list: AuditFindingDoc[]) {
    const names = await this.names(list.flatMap((f) => [f.ownerId, f.raisedById, ...(f.closedById ? [f.closedById] : []), ...f.updates.map((u) => u.byId)]));
    const ids = [...new Set(list.map((f) => f.controlId).filter((x): x is string => !!x))];
    const controls = new Map((ids.length ? await this.store.collection(internalControls).find({ id: { $in: ids } }) : []).map((c) => [c.id, { id: c.id, title: c.title }]));
    return list.map((f) => this.view(f, names, org, user, f.controlId ? controls.get(f.controlId) ?? null : null));
  }

  /** Every finding, open ones first, with counts. */
  async list(org: OrgContext, user: AuthUser, q: { status?: FindingStatus }) {
    const all = await this.store.collection(auditFindings).find({}, { sort: { number: -1 } });
    const rows = await this.views(org, user, all);
    const order: Record<string, number> = { READY_FOR_REVIEW: 0, IN_PROGRESS: 1, OPEN: 2, CLOSED: 3 };
    const members = await this.store.collection(memberships).find({});
    const names = await this.names(members.map((m) => m.userId));
    return {
      findings: rows.filter((r) => !q.status || r.status === q.status).sort((a, b) => order[a.status]! - order[b.status]! || b.reference.localeCompare(a.reference)),
      summary: {
        open: rows.filter((r) => r.status !== 'CLOSED').length,
        overdue: rows.filter((r) => r.overdue).length,
        high: rows.filter((r) => r.status !== 'CLOSED' && r.severity === 'HIGH').length,
        readyForReview: rows.filter((r) => r.status === 'READY_FOR_REVIEW').length,
      },
      members: members.filter((m) => m.role !== 'EMPLOYEE' && m.role !== 'VIEWER').map((m) => ({ id: m.userId, name: names.get(m.userId) ?? 'A member' })).sort((a, b) => a.name.localeCompare(b.name)),
      daysToFix: FINDING_DAYS_TO_FIX,
    };
  }

  async get(org: OrgContext, user: AuthUser, id: string) {
    return (await this.views(org, user, [await this.finding(id)]))[0]!;
  }

  /** Raises a finding, by hand or from a failed control test (once per test). */
  async raise(org: OrgContext, user: AuthUser, input: RaiseInput) {
    const owner = await this.store.collection(memberships).findOne({ userId: input.ownerId });
    if (!owner || !hasPermission(owner.role as RoleName, 'audit.read')) throw new DomainError('OWNER_NOT_MEMBER', 'The remediation owner must be a member who works on the books', HttpStatus.UNPROCESSABLE_ENTITY);
    let title = input.title?.trim() ?? '';
    let description = input.description?.trim() ?? '';
    let source: AuditFindingDoc['source'] = 'MANUAL';
    let fromTest: { controlId: string; testId: string; periodKey: string } | null = null;
    if (input.testId) {
      const t = await this.store.collection(controlTests).findById(input.testId);
      if (!t) throw new DomainError('NOT_FOUND', 'Control test not found', HttpStatus.NOT_FOUND);
      if (t.result !== 'FAIL') throw new DomainError('TEST_PASSED', 'Findings are raised from failed tests', HttpStatus.CONFLICT);
      if (await this.store.collection(auditFindings).findOne({ testId: t.id })) throw new DomainError('ALREADY_RAISED', 'A finding was already raised from this test', HttpStatus.CONFLICT);
      const c = await this.store.collection(internalControls).findById(t.controlId);
      title = title || `${c?.title ?? 'Control'} failed for ${t.periodKey}`;
      const evidence = t.evidence ? [t.evidence.summary, ...t.evidence.exceptions.map((x) => `- ${x}`)].join('\n') : '';
      description = description || [evidence, t.notes ?? ''].filter(Boolean).join('\n\n') || 'The control test failed.';
      source = 'CONTROL_TEST';
      fromTest = { controlId: t.controlId, testId: t.id, periodKey: t.periodKey };
    }
    if (!title) throw new DomainError('TITLE_REQUIRED', 'Name the finding', HttpStatus.UNPROCESSABLE_ENTITY);
    if (!description) throw new DomainError('DESCRIPTION_REQUIRED', 'Describe what was found', HttpStatus.UNPROCESSABLE_ENTITY);
    const today = todayIso();
    const due = input.dueDate ?? addDays(today, FINDING_DAYS_TO_FIX[input.severity]);
    if (due < today) throw new DomainError('DUE_IN_PAST', 'The due date cannot be in the past', HttpStatus.UNPROCESSABLE_ENTITY);
    const now = new Date();
    const number = await this.store.nextTenantSequence('audit_finding');
    const doc = await this.store
      .collection(auditFindings)
      .insertOne({
        number,
        title: title.slice(0, 140),
        description: description.slice(0, 2000),
        severity: input.severity,
        source,
        controlId: fromTest?.controlId ?? null,
        testId: fromTest?.testId ?? null,
        testPeriodKey: fromTest?.periodKey ?? null,
        ownerId: input.ownerId,
        plan: input.plan.trim(),
        dueDate: toDbDate(due),
        status: 'OPEN',
        updates: [{ at: now, byId: user.id, status: 'OPEN', note: 'Raised' }],
        raisedById: user.id,
        raisedAt: now,
        closedById: null,
        closedAt: null,
        clearedByTestId: null,
      })
      .catch((e: { code?: number }) => {
        if (e?.code === 11000) throw new DomainError('ALREADY_RAISED', 'A finding was already raised from this test', HttpStatus.CONFLICT);
        throw e;
      });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'audit_finding.raised', entityType: 'audit_finding', entityId: doc.id, data: { number, title: doc.title, severity: doc.severity, source, testId: doc.testId, ownerId: doc.ownerId, dueDate: due } }),
    );
    return this.get(org, user, doc.id);
  }

  /** The remediation owner (or an owner or admin) records progress. */
  async progress(org: OrgContext, user: AuthUser, id: string, input: { status: FindingStatus; note: string }) {
    const f = await this.finding(id);
    if (f.ownerId !== user.id && !hasPermission(org.role, 'org.manage')) throw new ForbiddenException({ error: 'NOT_OWNER', message: 'Only the remediation owner, or an owner or admin, updates this finding' });
    const issue = findingMoveIssue(f.status, input.status, input.note);
    if (issue) throw new DomainError(f.status === 'CLOSED' ? 'CLOSED' : 'INVALID_UPDATE', issue, HttpStatus.CONFLICT);
    const update = { at: new Date(), byId: user.id, status: input.status, note: input.note.trim() };
    const r = await this.store.collection(auditFindings).updateOne({ id, status: f.status }, { $set: { status: input.status }, $push: { updates: update } });
    if (!r.matched) throw new DomainError('FINDING_CHANGED', 'The finding changed while saving. Open it again.', HttpStatus.CONFLICT);
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'audit_finding.updated', entityType: 'audit_finding', entityId: id, data: { from: f.status, to: input.status, note: update.note } }));
    return this.get(org, user, id);
  }

  /** Someone other than the remediation owner closes the finding; one from a failed test needs a later passing test. */
  async close(org: OrgContext, user: AuthUser, id: string, note: string) {
    const f = await this.finding(id);
    let pass: { id: string; periodKey: string } | null = null;
    if (f.testId) {
      const failed = await this.store.collection(controlTests).findById(f.testId);
      const passes = await this.store.collection(controlTests).find({ controlId: f.controlId!, result: 'PASS' }, { sort: { testedAt: -1 } });
      const found = failed ? passes.find((p) => passClearsFailure({ periodKey: p.periodKey, testedAt: p.testedAt.toISOString() }, { periodKey: failed.periodKey, testedAt: failed.testedAt.toISOString() })) : undefined;
      pass = found ? { id: found.id, periodKey: found.periodKey } : null;
    }
    const issue = findingCloseIssue({ status: f.status, ownerId: f.ownerId, raisedFromTest: f.testPeriodKey ? { periodKey: f.testPeriodKey } : null }, user.id, pass, note);
    if (issue) {
      const code = f.ownerId === user.id && f.status === 'READY_FOR_REVIEW' ? 'OWNER_CANNOT_CLOSE' : f.testId && !pass && f.status === 'READY_FOR_REVIEW' ? 'NO_PASSING_TEST' : f.status === 'READY_FOR_REVIEW' ? 'NOTE_REQUIRED' : 'NOT_READY';
      throw new DomainError(code, issue, code === 'OWNER_CANNOT_CLOSE' ? HttpStatus.FORBIDDEN : code === 'NOTE_REQUIRED' ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.CONFLICT);
    }
    const now = new Date();
    const r = await this.store
      .collection(auditFindings)
      .updateOne({ id, status: 'READY_FOR_REVIEW' }, { $set: { status: 'CLOSED', closedById: user.id, closedAt: now, clearedByTestId: pass?.id ?? null }, $push: { updates: { at: now, byId: user.id, status: 'CLOSED', note: note.trim() } } });
    if (!r.matched) throw new DomainError('FINDING_CHANGED', 'The finding changed while saving. Open it again.', HttpStatus.CONFLICT);
    await this.prisma.$transaction((tx) => this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'audit_finding.closed', entityType: 'audit_finding', entityId: id, data: { note: note.trim(), clearedByTest: pass?.id ?? null, period: pass?.periodKey ?? null } }));
    return this.get(org, user, id);
  }
}
