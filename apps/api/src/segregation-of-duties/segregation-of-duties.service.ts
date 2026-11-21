import { HttpStatus, Injectable } from '@nestjs/common';
import { addAmounts, addDays, dutyConflicts, fmt, SOD_RULE_KEYS, SOD_RULES, sodFindings, sodReviewIssue, type SodFacts, type SodFinding } from '@talk2tax/accounting-engine';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import type { AuthUser, OrgContext } from '../auth/decorators';
import { fromDbDate, toDbDate, todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { bankReconciliations } from '../db/collections/banking';
import { users } from '../db/collections/identity';
import { journalEntries } from '../db/collections/ledger';
import { documents, payments } from '../db/collections/sales';
import { sodReviews, type SodReviewDoc } from '../db/collections/sod-reviews';
import { memberships } from '../db/collections/tenancy';
import { batchRef } from '../payment-batches/payment-batches.service';

/** The longest period one check reads, so it stays quick. */
export const MAX_SOD_DAYS = 400;
const money = (v: unknown) => fmt(addAmounts([String(v)]));

/**
 * Segregation-of-duties checks (AUDIT-014): who did two jobs that should be split, over a period,
 * and which members' roles hold conflicting duties. Reading needs audit.read; clearing a finding
 * needs approvals.decide and someone who was not involved, and is audited.
 */
@Injectable()
export class SegregationOfDutiesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private period(from?: string, to?: string) {
    const end = to ?? todayIso();
    const start = from ?? addDays(end, -89);
    if (start > end) throw new DomainError('INVALID_PERIOD', 'The start date must be on or before the end date', HttpStatus.UNPROCESSABLE_ENTITY);
    if (addDays(start, MAX_SOD_DAYS) < end) throw new DomainError('PERIOD_TOO_LONG', `Check at most ${MAX_SOD_DAYS} days at a time`, HttpStatus.UNPROCESSABLE_ENTITY);
    return { from: start, to: end };
  }

  /** The facts the checks read. Bank detail changes are read from a year before the period, as a change may come well before the payment. */
  private async facts(orgId: string, from: string, to: string): Promise<SodFacts> {
    const range = { $gte: toDbDate(from), $lte: toDbDate(to) };
    const [journals, bills, pays, recs, batches, changes] = await Promise.all([
      this.store.collection(journalEntries).find({ status: 'POSTED', source: 'MANUAL', date: range }),
      this.store.collection(documents).find({ kind: 'BILL', postedById: { $ne: null }, issueDate: range }),
      this.store.collection(payments).find({ kind: 'PAYMENT', date: range }),
      this.store.collection(bankReconciliations).find({ statementDate: range }),
      this.prisma.paymentBatch.findMany({ where: { orgId, approvedById: { not: null }, paymentDate: { gte: toDbDate(from), lte: toDbDate(to) } }, include: { items: true } }),
      this.prisma.vendorBankDetailChange.findMany({ where: { orgId, changedAt: { gte: toDbDate(addDays(from, -366)), lte: new Date(`${to}T23:59:59.999Z`) } } }),
    ]);
    return {
      journals: journals.map((j) => ({ id: j.id, number: j.entryNumber === null ? null : `Journal #${j.entryNumber}`, date: fromDbDate(j.date), source: j.source, createdById: j.createdById, postedById: j.postedById, amount: money(j.totalDebit) })),
      bills: bills.map((b) => ({ id: b.id, number: b.number, date: fromDbDate(b.issueDate), contactId: b.contactId, createdById: b.createdById, postedById: b.postedById, amount: money(b.total) })),
      batches: batches.map((b) => ({ id: b.id, reference: batchRef(b.number), date: fromDbDate(b.paymentDate), createdById: b.createdById, approvedById: b.approvedById, selfApproved: b.selfApproved, amount: fmt(addAmounts(b.items.map((i) => i.amount.toFixed()))) })),
      bankDetailChanges: changes.map((c) => ({ contactId: c.contactId, changedById: c.changedById, changedAt: c.changedAt.toISOString() })),
      payments: pays.map((p) => ({ id: p.id, number: p.number, date: fromDbDate(p.date), contactId: p.contactId, bankAccountId: p.bankAccountId, createdById: p.createdById, amount: money(p.amount), status: p.status })),
      reconciliations: recs.map((r) => ({ id: r.id, accountId: r.accountId, startDate: fromDbDate(r.startDate), statementDate: fromDbDate(r.statementDate), completedById: r.completedById, completedAt: r.completedAt.toISOString(), status: r.status })),
    };
  }

  private async findingsFor(orgId: string, from: string, to: string) {
    return sodFindings(await this.facts(orgId, from, to));
  }

  /** The findings over a period that no one has reviewed yet (for the control tests that rely on them). */
  async unreviewedFindings(orgId: string, from: string, to: string) {
    const findings = await this.findingsFor(orgId, from, to);
    if (!findings.length) return [];
    const reviewed = new Set((await this.store.collection(sodReviews).find({ findingKey: { $in: findings.map((f) => f.key) } })).map((r) => r.findingKey));
    return findings.filter((f) => !reviewed.has(f.key));
  }

  /** The findings over a period with their reviews, the rules, and the duties each member's role holds. */
  async overview(org: OrgContext, user: AuthUser, q: { from?: string; to?: string }) {
    const { from, to } = this.period(q.from, q.to);
    const findings = await this.findingsFor(org.id, from, to);
    const reviews = new Map((findings.length ? await this.store.collection(sodReviews).find({ findingKey: { $in: findings.map((f) => f.key) } }) : []).map((r) => [r.findingKey, r]));
    const members = await this.store.collection(memberships).find({});
    const ids = new Set<string>([...members.map((m) => m.userId), ...findings.flatMap((f) => f.people), ...[...reviews.values()].map((r) => r.reviewedById)]);
    const names = new Map((await this.store.collection(users).find({ id: { $in: [...ids] } })).map((u) => [u.id, u.name ?? u.email]));
    const person = (id: string) => ({ id, name: names.get(id) ?? 'A former member' });
    const holders = (permission: string) => members.filter((m) => hasPermission(m.role as RoleName, permission as never));
    const rows = findings.map((f) => this.row(f, reviews.get(f.key), person, user));
    return {
      from,
      to,
      findings: rows,
      rules: SOD_RULE_KEYS.map((id) => ({ id, ...SOD_RULES[id], open: rows.filter((r) => r.rule === id && !r.review).length, reviewed: rows.filter((r) => r.rule === id && r.review).length })),
      members: members
        .filter((m) => m.role !== 'VIEWER' && m.role !== 'EMPLOYEE')
        .map((m) => ({ ...person(m.userId), role: m.role, conflicts: dutyConflicts((p) => hasPermission(m.role as RoleName, p as never)) }))
        .sort((a, b) => b.conflicts.length - a.conflicts.length || a.name.localeCompare(b.name)),
      /** How many members can clear findings (approvals.decide); none of them may clear one they were involved in. */
      reviewers: holders('approvals.decide').length,
      canReview: hasPermission(org.role, 'approvals.decide'),
    };
  }

  private row(f: SodFinding, review: SodReviewDoc | undefined, person: (id: string) => { id: string; name: string }, user: AuthUser) {
    return {
      ...f,
      ruleTitle: SOD_RULES[f.rule].title,
      people: f.people.map(person),
      involvesMe: f.people.includes(user.id),
      review: review ? { reason: review.reason, by: person(review.reviewedById), at: review.reviewedAt.toISOString() } : null,
    };
  }

  /** Clears one finding with a reason, by someone who was not involved. The finding is looked up again, so only a real one is reviewed. */
  async review(org: OrgContext, user: AuthUser, input: { key: string; date: string; reason: string }) {
    const { from, to } = this.period(input.date, input.date);
    const finding = (await this.findingsFor(org.id, from, to)).find((f) => f.key === input.key);
    if (!finding) throw new DomainError('NOT_FOUND', 'There is no such finding on that date', HttpStatus.NOT_FOUND);
    const issue = sodReviewIssue(finding, user.id, input.reason);
    if (issue) throw new DomainError(finding.people.includes(user.id) ? 'INVOLVED' : 'REASON_REQUIRED', issue, finding.people.includes(user.id) ? HttpStatus.FORBIDDEN : HttpStatus.UNPROCESSABLE_ENTITY);
    if (await this.store.collection(sodReviews).findOne({ findingKey: finding.key })) throw new DomainError('ALREADY_REVIEWED', 'This finding was already reviewed', HttpStatus.CONFLICT);
    const now = new Date();
    const doc = await this.store
      .collection(sodReviews)
      .insertOne({ findingKey: finding.key, rule: finding.rule, people: finding.people, reason: input.reason.trim(), reviewedById: user.id, reviewedAt: now })
      .catch((e: { code?: number }) => {
        if (e?.code === 11000) throw new DomainError('ALREADY_REVIEWED', 'This finding was already reviewed', HttpStatus.CONFLICT);
        throw e;
      });
    await this.prisma.$transaction((tx) =>
      this.audit.append(tx, { orgId: org.id, actorId: user.id, action: 'sod.finding_reviewed', entityType: 'sod_review', entityId: doc.id, data: { finding: finding.key, rule: finding.rule, subject: finding.subject, people: finding.people, reason: input.reason.trim() } }),
    );
    return doc;
  }
}
