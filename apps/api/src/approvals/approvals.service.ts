import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { D, ledgerOf, minorUnits } from '@talk2tax/accounting-engine';
import { ApprovalStatus, DocumentKind, Prisma } from '@talk2tax/database';
import { hasPermission, Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { DocumentsService } from '../ledgers/documents.service';
import { currentApproval, policyFor } from './approval-rules';

interface Actor {
  id: string;
}

const KINDS: DocumentKind[] = ['INVOICE', 'CREDIT_NOTE', 'BILL', 'VENDOR_CREDIT'];

export interface PolicyInput {
  minAmount: string;
  requireDifferentApprover: boolean;
  isActive: boolean;
}

type RequestRow = Prisma.ApprovalRequestGetPayload<{ include: { document: { select: { id: true; number: true; status: true; kind: true; createdById: true } } } }>;

/**
 * Approval rules for sales and purchase documents (Directive Part 26). A policy says
 * which documents need an approval (by type and amount); a request is one ask to
 * approve one draft. The database enforces the same rules (see the
 * 20261031190000_attachments_approvals migration), so they hold for any writer.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  // ------------------------------------------------------------------ policies

  async policies(org: OrgContext) {
    const rows = await this.prisma.approvalPolicy.findMany({ where: { orgId: org.id } });
    const scale = minorUnits(org.functionalCurrency);
    return KINDS.map((kind) => {
      const p = rows.find((r) => r.documentKind === kind);
      return {
        documentKind: kind,
        configured: !!p,
        isActive: p?.isActive ?? false,
        minAmount: p ? p.minAmount.toFixed(scale) : null,
        requireDifferentApprover: p?.requireDifferentApprover ?? true,
        updatedAt: p?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async setPolicy(org: OrgContext, actor: Actor, kind: DocumentKind, input: PolicyInput) {
    const min = new D(input.minAmount);
    if (min.isNegative()) throw new DomainError('INVALID_AMOUNT', 'The minimum amount cannot be negative');
    if (min.decimalPlaces() > minorUnits(org.functionalCurrency)) throw new DomainError('INVALID_AMOUNT', `Use at most ${minorUnits(org.functionalCurrency)} decimal places`);
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.approvalPolicy.findUnique({ where: { orgId_documentKind: { orgId: org.id, documentKind: kind } } });
      const data = { minAmount: min.toFixed(), requireDifferentApprover: input.requireDifferentApprover, isActive: input.isActive, updatedById: actor.id };
      await tx.approvalPolicy.upsert({ where: { orgId_documentKind: { orgId: org.id, documentKind: kind } }, create: { orgId: org.id, documentKind: kind, ...data }, update: data });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'approval_policy.updated',
        entityType: 'approval_policy',
        entityId: kind,
        data: {
          kind,
          before: before ? { minAmount: before.minAmount.toFixed(), requireDifferentApprover: before.requireDifferentApprover, isActive: before.isActive } : null,
          after: { minAmount: min.toFixed(), requireDifferentApprover: input.requireDifferentApprover, isActive: input.isActive },
        },
      });
    });
    return (await this.policies(org)).find((p) => p.documentKind === kind);
  }

  // ------------------------------------------------------------------ requests

  async list(org: OrgContext, actor: Actor, q: { status?: ApprovalStatus; documentId?: string; limit: number; offset: number }) {
    const where: Prisma.ApprovalRequestWhereInput = { orgId: org.id, ...(q.status ? { status: q.status } : {}), ...(q.documentId ? { documentId: q.documentId } : {}) };
    // People only see requests for the ledgers they can read.
    const kinds = KINDS.filter((k) => hasPermission(org.role, readPermission(k)));
    where.documentKind = { in: kinds };
    const [total, rows] = await Promise.all([
      this.prisma.approvalRequest.count({ where }),
      this.prisma.approvalRequest.findMany({ where, include: REQ_INCLUDE, orderBy: { requestedAt: 'desc' }, take: q.limit, skip: q.offset }),
    ]);
    return { total, items: await this.serialize(org, actor, rows) };
  }

  /** What the document page needs: does a policy apply, and where is the approval now. */
  async forDocument(org: OrgContext, actor: Actor, documentId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id }, select: { id: true, kind: true, status: true, total: true, createdById: true } });
    if (!doc) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
    this.require(org, readPermission(doc.kind), 'see this document');
    const policy = doc.status === 'DRAFT' ? await policyFor(this.prisma, org.id, doc.kind, doc.total.toFixed()) : null;
    const approved = doc.status === 'DRAFT' ? await currentApproval(this.prisma, doc.id, doc.total.toFixed()) : null;
    const history = await this.prisma.approvalRequest.findMany({ where: { documentId: doc.id, orgId: org.id }, include: REQ_INCLUDE, orderBy: { requestedAt: 'desc' } });
    const scale = minorUnits(org.functionalCurrency);
    return {
      required: !!policy,
      policy: policy ? { minAmount: policy.minAmount.toFixed(scale), requireDifferentApprover: policy.requireDifferentApprover } : null,
      readyToPost: !policy || !!approved,
      requests: await this.serialize(org, actor, history),
    };
  }

  async submit(org: OrgContext, actor: Actor, input: { documentId: string; note?: string | null }) {
    return this.prisma.$transaction(async (tx) => {
      const doc = await this.lockDraft(tx, org, input.documentId);
      this.require(org, managePermission(doc.kind), 'submit this document for approval');
      const policy = await policyFor(tx, org.id, doc.kind, doc.total.toFixed());
      if (!policy) throw new DomainError('NO_APPROVAL_NEEDED', 'No approval rule applies to this document; it can be posted directly');
      const open = await tx.approvalRequest.findFirst({ where: { documentId: doc.id, status: { in: ['PENDING', 'APPROVED'] } } });
      if (open) throw new DomainError('ALREADY_SUBMITTED', open.status === 'PENDING' ? 'This document is already waiting for approval' : 'This document is already approved', HttpStatus.CONFLICT);
      const r = await tx.approvalRequest.create({
        data: { orgId: org.id, documentId: doc.id, documentKind: doc.kind, contactName: doc.contact.name, total: doc.total.toFixed(), note: input.note || null, requestedById: actor.id },
        include: REQ_INCLUDE,
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'approval.requested', entityType: 'approval_request', entityId: r.id, data: { documentId: doc.id, kind: doc.kind, total: doc.total.toFixed() } });
      return (await this.serialize(org, actor, [r], tx))[0];
    });
  }

  /**
   * Approves a pending request. With post: true the document is posted straight after,
   * in its own transaction, so a posting problem (a credit limit, a locked period) leaves
   * the approval in place and is reported back instead of undoing the decision.
   */
  async approve(org: OrgContext, actor: Actor, id: string, input: { note?: string | null; post: boolean; overrideCreditLimit: boolean }) {
    this.require(org, 'approvals.decide', 'approve documents');
    if (input.post) this.require(org, 'journals.post', 'post documents');
    const approved = await this.decide(org, actor, id, 'APPROVED', input.note ?? null);
    if (!input.post) return { approval: approved, posted: false, postError: null };
    try {
      const doc = await this.documents.post(org, actor, ledgerOf(approved.documentKind), approved.documentId!, input.overrideCreditLimit);
      return { approval: approved, posted: true, postError: null, document: { id: doc.id, number: doc.number, status: doc.status } };
    } catch (e) {
      if (e instanceof DomainError) return { approval: approved, posted: false, postError: { error: e.code, message: e.message, details: e.details ?? null } };
      throw e;
    }
  }

  async reject(org: OrgContext, actor: Actor, id: string, note: string) {
    this.require(org, 'approvals.decide', 'reject documents');
    return this.decide(org, actor, id, 'REJECTED', note);
  }

  /** The requester (or anyone who can prepare the document) takes a pending request back. */
  async withdraw(org: OrgContext, actor: Actor, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockRequest(tx, org, id);
      this.require(org, managePermission(r.documentKind), 'withdraw this request');
      if (r.status !== 'PENDING') throw new DomainError('NOT_PENDING', `This request is already ${r.status.toLowerCase()}`, HttpStatus.CONFLICT);
      const out = await tx.approvalRequest.update({ where: { id }, data: { status: 'CANCELLED', decidedById: actor.id, decidedAt: new Date(), decisionNote: 'Withdrawn' }, include: REQ_INCLUDE });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'approval.withdrawn', entityType: 'approval_request', entityId: id, data: { documentId: r.documentId } });
      return (await this.serialize(org, actor, [out], tx))[0];
    });
  }

  // ------------------------------------------------------------------ internals

  private async decide(org: OrgContext, actor: Actor, id: string, status: 'APPROVED' | 'REJECTED', note: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const r = await this.lockRequest(tx, org, id);
      if (r.status !== 'PENDING') throw new DomainError('NOT_PENDING', `This request is already ${r.status.toLowerCase()}`, HttpStatus.CONFLICT);
      if (!r.document || r.document.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', 'The document is no longer a draft', HttpStatus.CONFLICT);
      if (status === 'APPROVED') {
        const p = await tx.approvalPolicy.findUnique({ where: { orgId_documentKind: { orgId: org.id, documentKind: r.documentKind } } });
        if ((p?.requireDifferentApprover ?? true) && (actor.id === r.requestedById || actor.id === r.document.createdById)) {
          throw new DomainError('SAME_PERSON', 'Someone other than the person who prepared or submitted this document must approve it', HttpStatus.FORBIDDEN);
        }
      }
      const out = await tx.approvalRequest.update({ where: { id }, data: { status, decidedById: actor.id, decidedAt: new Date(), decisionNote: note || null }, include: REQ_INCLUDE });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: status === 'APPROVED' ? 'approval.approved' : 'approval.rejected',
        entityType: 'approval_request',
        entityId: id,
        data: { documentId: r.documentId, total: r.total.toFixed(), note },
      });
      return (await this.serialize(org, actor, [out], tx))[0];
    });
  }

  private async lockRequest(tx: Tx, org: OrgContext, id: string) {
    await tx.$queryRaw`SELECT id FROM approval_requests WHERE id = ${id}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
    const r = await tx.approvalRequest.findFirst({ where: { id, orgId: org.id }, include: REQ_INCLUDE });
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Approval request not found' });
    this.require(org, readPermission(r.documentKind), 'see this request');
    if (r.documentId) await tx.$queryRaw`SELECT id FROM documents WHERE id = ${r.documentId}::uuid FOR UPDATE`;
    return r;
  }

  private async lockDraft(tx: Tx, org: OrgContext, documentId: string) {
    await tx.$queryRaw`SELECT id FROM documents WHERE id = ${documentId}::uuid AND org_id = ${org.id}::uuid FOR UPDATE`;
    const doc = await tx.document.findFirst({ where: { id: documentId, orgId: org.id }, include: { contact: { select: { name: true } } } });
    if (!doc) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
    if (doc.status !== 'DRAFT') throw new DomainError('NOT_DRAFT', 'Only drafts can be submitted for approval', HttpStatus.CONFLICT);
    return doc;
  }

  private require(org: OrgContext, permission: Permission, what: string) {
    if (!hasPermission(org.role, permission)) throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${what}; it needs ${permission}`, HttpStatus.FORBIDDEN);
  }

  private async serialize(org: OrgContext, actor: Actor, rows: RequestRow[], db: Pick<Tx, 'user' | 'approvalPolicy'> = this.prisma) {
    const policies = await db.approvalPolicy.findMany({ where: { orgId: org.id }, select: { documentKind: true, requireDifferentApprover: true } });
    const separate = (kind: DocumentKind) => policies.find((p) => p.documentKind === kind)?.requireDifferentApprover ?? true;
    const ids = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById].filter((x): x is string => !!x)))];
    const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    const name = (id: string | null) => (id ? (users.find((u) => u.id === id)?.name ?? null) : null);
    const scale = minorUnits(org.functionalCurrency);
    const canDecide = hasPermission(org.role, 'approvals.decide');
    return rows.map((r) => {
      const ownWork = actor.id === r.requestedById || actor.id === r.document?.createdById;
      return {
        id: r.id,
        status: r.status,
        documentId: r.documentId,
        documentKind: r.documentKind,
        documentNumber: r.document?.number ?? null,
        documentStatus: r.document?.status ?? null,
        contactName: r.contactName,
        total: r.total.toFixed(scale),
        note: r.note,
        requestedBy: name(r.requestedById),
        requestedById: r.requestedById,
        requestedAt: r.requestedAt.toISOString(),
        decidedBy: name(r.decidedById),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        /** Whether the caller may approve: a hint for the UI; the server checks again. */
        canApprove: r.status === 'PENDING' && canDecide && r.document?.status === 'DRAFT' && !(ownWork && separate(r.documentKind)),
        ownWork,
      };
    });
  }
}

const REQ_INCLUDE = { document: { select: { id: true, number: true, status: true, kind: true, createdById: true } } } as const;

function readPermission(kind: DocumentKind): Permission {
  return ledgerOf(kind) === 'SALES' ? 'sales.read' : 'purchases.read';
}

function managePermission(kind: DocumentKind): Permission {
  return ledgerOf(kind) === 'SALES' ? 'sales.manage' : 'purchases.manage';
}
