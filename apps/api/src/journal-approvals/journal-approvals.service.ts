import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, minorUnits } from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { hasPermission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { fromDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { users } from '../db/collections/identity';
import { JournalApprovalDoc, journalApprovalPolicies, journalApprovals } from '../db/collections/journal-approvals';
import { JournalEntryDoc, journalEntries } from '../db/collections/ledger';

type EntryLike = Pick<JournalEntryDoc, 'id' | 'date' | 'type' | 'source' | 'status' | 'totalDebit' | 'createdById' | 'lines'>;

/** What the approval covers: the date, type and every line as drafted. */
export function journalFingerprint(e: Pick<JournalEntryDoc, 'date' | 'type' | 'lines'>): string {
  const lines = [...e.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => [l.accountId, l.currency, new D(l.exchangeRate).toFixed(), new D(l.debit).toFixed(), new D(l.credit).toFixed(), l.departmentId, l.projectId, l.dimensions ? Object.entries(l.dimensions).sort() : null, l.description]);
  return createHash('sha256').update(JSON.stringify([fromDbDate(e.date), e.type, lines])).digest('hex');
}

/**
 * Human approval of manual journals (SEC-036). MongoDB only. Above the organisation's amount a
 * manual journal posts only with an approval, from someone other than who drafted or asked, of
 * the draft exactly as it is. Changing or deleting the draft withdraws its open request.
 */
@Injectable()
export class JournalApprovalsService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async policy(org: { id: string; functionalCurrency: string }) {
    const p = await this.store.collection(journalApprovalPolicies).findOne({});
    return { currency: org.functionalCurrency, isActive: p?.isActive ?? false, minAmount: p ? new D(p.minAmount).toFixed(minorUnits(org.functionalCurrency)) : null, updatedAt: p?.updatedAt.toISOString() ?? null };
  }

  async setPolicy(org: OrgContext, actorId: string, input: { minAmount: string; isActive: boolean }) {
    let min: InstanceType<typeof D>;
    try {
      min = new D(input.minAmount);
    } catch {
      throw new DomainError('INVALID_AMOUNT', 'The amount is not a number', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (!min.isFinite() || min.isNeg() || min.decimalPlaces() > minorUnits(org.functionalCurrency)) throw new DomainError('INVALID_AMOUNT', 'The amount is zero or more, in the currency\'s decimals', HttpStatus.UNPROCESSABLE_ENTITY);
    const col = this.store.collection(journalApprovalPolicies);
    const before = await col.findOne({});
    const now = new Date();
    if (before) await col.updateOne({ id: before.id }, { $set: { minAmount: min.toFixed(), isActive: input.isActive, updatedById: actorId, updatedAt: now } });
    else await col.insertOne({ orgId: org.id, minAmount: min.toFixed(), isActive: input.isActive, updatedById: actorId, createdAt: now, updatedAt: now });
    await this.log(org.id, actorId, 'journal_approval_policy.updated', org.id, { before: before ? { minAmount: before.minAmount, isActive: before.isActive } : null, after: { minAmount: min.toFixed(), isActive: input.isActive } });
    return this.policy(org);
  }

  /** The active policy, if a manual journal of this functional total needs approval. */
  private async needed(total: string) {
    const p = await this.store.collection(journalApprovalPolicies).findOne({ isActive: true });
    return p && new D(total).gte(p.minAmount) ? p : null;
  }

  /** Posting straight away is refused above the amount: save a draft and ask for approval. */
  async assertMayCreatePosted(totalDebit: string) {
    const p = await this.needed(totalDebit);
    if (p) throw new DomainError('JOURNAL_APPROVAL_REQUIRED', `Manual journals of ${new D(p.minAmount).toFixed()} or more need someone else's approval: save it as a draft and ask for approval`, HttpStatus.CONFLICT);
  }

  /** A draft posts above the amount only with an approval of it exactly as it is now. */
  async assertMayPost(entry: EntryLike) {
    if (entry.source !== 'MANUAL') return;
    const p = await this.needed(entry.totalDebit);
    if (!p) return;
    const ok = await this.store.collection(journalApprovals).findOne({ entryId: entry.id, status: 'APPROVED', fingerprint: journalFingerprint(entry) });
    if (!ok) throw new DomainError('JOURNAL_APPROVAL_REQUIRED', `This journal is ${new D(entry.totalDebit).toFixed()}, at or above the approval amount of ${new D(p.minAmount).toFixed()}: it needs someone else's approval before it posts`, HttpStatus.CONFLICT);
  }

  /** Called when a draft changes or is deleted: its open request no longer covers it. */
  async draftChanged(orgId: string, entryId: string, actorId: string) {
    const open = await this.store.collection(journalApprovals).find({ entryId, open: true });
    for (const r of open) {
      await this.store.collection(journalApprovals).updateOne({ id: r.id }, { $set: { status: 'CANCELLED', open: false, decisionNote: 'The draft was changed', decidedAt: r.decidedAt ?? new Date(), decidedById: r.decidedById } });
      await this.log(orgId, actorId, 'journal_approval.cancelled', r.id, { entryId, reason: 'draft changed' });
    }
  }

  private async entry(id: string) {
    const e = await this.store.collection(journalEntries).findById(id);
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    return e;
  }

  async request(org: OrgContext, actorId: string, entryId: string, note: string | null) {
    const e = await this.entry(entryId);
    if (e.status !== 'DRAFT' || e.source !== 'MANUAL') throw new DomainError('NOT_A_DRAFT', 'Approval is asked for a manual journal still in draft', HttpStatus.CONFLICT);
    if (!(await this.needed(e.totalDebit))) throw new DomainError('APPROVAL_NOT_NEEDED', 'This journal is below the approval amount and can be posted directly', HttpStatus.UNPROCESSABLE_ENTITY);
    try {
      const r = await this.store.collection(journalApprovals).insertOne({ orgId: org.id, entryId, fingerprint: journalFingerprint(e), total: e.totalDebit, status: 'PENDING', open: true, note: note?.trim() || null, requestedById: actorId, requestedAt: new Date(), decidedById: null, decidedAt: null, decisionNote: null });
      await this.log(org.id, actorId, 'journal_approval.requested', r.id, { entryId, total: e.totalDebit });
      return this.forEntry(org, entryId, actorId);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new DomainError('ALREADY_REQUESTED', 'Approval has already been asked for this journal', HttpStatus.CONFLICT);
      throw err;
    }
  }

  private async pending(id: string) {
    const r = await this.store.collection(journalApprovals).findById(id);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Approval request not found' });
    if (r.status !== 'PENDING') throw new DomainError('NOT_PENDING', `This request is already ${r.status.toLowerCase()}`, HttpStatus.CONFLICT);
    return r;
  }

  async decide(org: OrgContext, actorId: string, id: string, decision: 'APPROVED' | 'REJECTED', note: string | null) {
    const r = await this.pending(id);
    const e = await this.entry(r.entryId);
    if (actorId === r.requestedById || actorId === e.createdById) throw new DomainError('SAME_PERSON', 'Someone other than who drafted the journal or asked for approval decides on it', HttpStatus.FORBIDDEN);
    if (decision === 'REJECTED' && !note?.trim()) throw new DomainError('NOTE_REQUIRED', 'Say why the journal is rejected', HttpStatus.UNPROCESSABLE_ENTITY);
    if (e.status !== 'DRAFT' || journalFingerprint(e) !== r.fingerprint) {
      await this.draftChanged(org.id, e.id, actorId);
      throw new DomainError('DRAFT_CHANGED', 'The journal changed after approval was asked for; ask again', HttpStatus.CONFLICT);
    }
    await this.store.collection(journalApprovals).updateOne({ id }, { $set: { status: decision, open: decision === 'APPROVED', decidedById: actorId, decidedAt: new Date(), decisionNote: note?.trim() || null } });
    await this.log(org.id, actorId, decision === 'APPROVED' ? 'journal_approval.approved' : 'journal_approval.rejected', id, { entryId: e.id, total: r.total, note: note?.trim() || null });
    return this.forEntry(org, e.id, actorId);
  }

  async withdraw(org: OrgContext, actorId: string, id: string) {
    const r = await this.pending(id);
    if (r.requestedById !== actorId) throw new DomainError('NOT_YOURS', 'Only who asked can withdraw the request', HttpStatus.FORBIDDEN);
    await this.store.collection(journalApprovals).updateOne({ id }, { $set: { status: 'CANCELLED', open: false, decidedById: actorId, decidedAt: new Date(), decisionNote: 'Withdrawn' } });
    await this.log(org.id, actorId, 'journal_approval.withdrawn', id, { entryId: r.entryId });
    return this.forEntry(org, r.entryId, actorId);
  }

  /** Whether a journal needs approval and where its latest request stands. */
  async forEntry(org: OrgContext, entryId: string, actorId: string) {
    const e = await this.entry(entryId);
    const p = e.source === 'MANUAL' ? await this.needed(e.totalDebit) : null;
    const rows = await this.store.collection(journalApprovals).find({ entryId }, { sort: { requestedAt: -1 } });
    const names = await this.names(rows.flatMap((r) => [r.requestedById, r.decidedById]));
    const fp = journalFingerprint(e);
    const show = (r: JournalApprovalDoc) => ({
      id: r.id,
      status: r.status,
      total: r.total,
      note: r.note,
      requestedBy: names.get(r.requestedById) ?? null,
      requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decidedById ? (names.get(r.decidedById) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      coversCurrentDraft: r.fingerprint === fp,
      canDecide: r.status === 'PENDING' && actorId !== r.requestedById && actorId !== e.createdById && hasPermission(org.role, 'approvals.decide'),
      canWithdraw: r.status === 'PENDING' && actorId === r.requestedById,
    });
    return {
      entryId,
      required: !!p && e.status === 'DRAFT',
      minAmount: p ? new D(p.minAmount).toFixed() : null,
      approved: rows.some((r) => r.status === 'APPROVED' && r.fingerprint === fp),
      current: rows[0] && rows[0].status !== 'CANCELLED' ? show(rows[0]) : null,
      history: rows.map(show),
    };
  }

  /** Requests to decide, newest first, with what each journal is. */
  async list(org: OrgContext, actorId: string, status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED') {
    const rows = await this.store.collection(journalApprovals).find({ status }, { sort: { requestedAt: -1 }, limit: 200 });
    const entries = rows.length ? await this.store.collection(journalEntries).find({ id: { $in: rows.map((r) => r.entryId) } }) : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const names = await this.names(rows.flatMap((r) => [r.requestedById, r.decidedById]));
    return rows.map((r) => {
      const e = byId.get(r.entryId);
      return {
        id: r.id,
        entryId: r.entryId,
        date: e ? fromDbDate(e.date) : null,
        memo: e?.memo ?? null,
        total: new D(r.total).toFixed(minorUnits(org.functionalCurrency)),
        currency: org.functionalCurrency,
        status: r.status,
        note: r.note,
        requestedBy: names.get(r.requestedById) ?? null,
        requestedAt: r.requestedAt.toISOString(),
        decidedBy: r.decidedById ? (names.get(r.decidedById) ?? null) : null,
        canDecide: r.status === 'PENDING' && actorId !== r.requestedById && actorId !== e?.createdById && hasPermission(org.role, 'approvals.decide'),
      };
    });
  }

  private async names(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length ? await this.store.collection(users).find({ id: { $in: unique } }) : [];
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'journal_approval', entityId, data }));
  }
}
