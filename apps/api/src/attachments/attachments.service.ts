import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { compareDuplicates, duplicateFileRisk, type FileUse } from '@talk2tax/accounting-engine';
import { AttachmentEntity } from '@talk2tax/database';
import { hasPermission, Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { ExpensesService } from '../expenses/expenses.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { DocumentStoreService } from '../common/document-store.service';
import { ATTACHMENTS, attachments } from '../db/collections/sales';
import { MovedTables } from '../db/moved-table';
import { UsageService } from '../usage/usage.service';

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_PER_RECORD = 20;

type Org = OrgContext;

/** File type from the first bytes. The type the browser claims is never trusted. */
export function sniffContentType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** Keeps a readable name without path separators, control characters or leading dots. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned || 'file';
}

/**
 * Evidence files attached to documents, payments, journals and bank lines
 * (Directive Part 25). Stored in PostgreSQL for now; the bytes are immutable and a
 * file is removed by marking it, never by deleting it.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly expenses: ExpensesService,
    private readonly usage: UsageService,
    private readonly moved: MovedTables,
    private readonly store: DocumentStoreService,
  ) {}

  async list(org: Org, actor: { id: string }, entityType: AttachmentEntity, entityId: string, includeRemoved: boolean) {
    await this.entity(org, actor, entityType, entityId, 'read');
    const rows = await this.prisma.attachment.findMany({
      where: { orgId: org.id, entityType, entityId, ...(includeRemoved ? {} : { removedAt: null }) },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, uploadedById: true, createdAt: true, removedAt: true, removedReason: true },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.uploadedById))] } }, select: { id: true, name: true } });
    const elsewhere = await this.elsewhere(org, actor, rows.filter((r) => !r.removedAt).map((r) => r.sha256), { entityType, entityId });
    return rows.map((r) => ({
      ...r,
      alsoOn: r.removedAt ? [] : (elsewhere.get(r.sha256) ?? []),
      uploadedBy: users.find((u) => u.id === r.uploadedById)?.name ?? null,
      createdAt: r.createdAt.toISOString(),
      removedAt: r.removedAt?.toISOString() ?? null,
    }));
  }

  async upload(org: Org, actor: { id: string }, input: { entityType: AttachmentEntity; entityId: string; fileName: string; content: Buffer }) {
    await this.entity(org, actor, input.entityType, input.entityId, 'manage');
    if (!Buffer.isBuffer(input.content) || input.content.length === 0) throw new DomainError('EMPTY_FILE', 'The file is empty');
    if (input.content.length > MAX_ATTACHMENT_BYTES) throw new DomainError('FILE_TOO_LARGE', 'Files can be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    const contentType = sniffContentType(input.content);
    if (!contentType) throw new DomainError('UNSUPPORTED_FILE', 'Only PDF, PNG, JPEG and WebP files can be attached', HttpStatus.UNSUPPORTED_MEDIA_TYPE);
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const saved = await this.prisma.$transaction(async (tx) => {
      const count = await tx.attachment.count({ where: { orgId: org.id, entityType: input.entityType, entityId: input.entityId, removedAt: null } });
      if (count >= MAX_PER_RECORD) throw new DomainError('TOO_MANY_FILES', `A record can have at most ${MAX_PER_RECORD} files`, HttpStatus.CONFLICT);
      const same = await tx.attachment.findFirst({ where: { orgId: org.id, entityType: input.entityType, entityId: input.entityId, sha256, removedAt: null }, select: { id: true } });
      if (same) throw new DomainError('DUPLICATE_FILE', 'This file is already attached to this record', HttpStatus.CONFLICT, { attachmentId: same.id });
      // Counted against the plan's uploads for the month (refused past it).
      await this.usage.takeUpload(tx, org.id, input.content.length);
      const row = await this.moved.create<{ id: string; fileName: string; contentType: string; sizeBytes: number; sha256: string; createdAt: Date }>(tx, ATTACHMENTS, org.id, {
        entityType: input.entityType,
        entityId: input.entityId,
        fileName: cleanFileName(input.fileName),
        contentType,
        sizeBytes: input.content.length,
        sha256,
        content: input.content,
        uploadedById: actor.id,
        createdAt: new Date(),
        removedAt: null,
        removedById: null,
        removedReason: null,
      });
      const a = { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes, sha256: row.sha256, createdAt: row.createdAt };
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'attachment.added',
        entityType: 'attachment',
        entityId: a.id,
        data: { on: input.entityType, entityId: input.entityId, fileName: a.fileName, sha256, sizeBytes: a.sizeBytes },
      });
      return { ...a, createdAt: a.createdAt.toISOString() };
    });
    const elsewhere = await this.elsewhere(org, actor, [saved.sha256], { entityType: input.entityType, entityId: input.entityId });
    return { ...saved, alsoOn: elsewhere.get(saved.sha256) ?? [] };
  }

  /**
   * Duplicate files across records (DOC-018): files with the same SHA-256 on more than one record
   * the caller may see, most serious first. One receipt on two claims, or one vendor invoice on two
   * bills, may mean spending counted twice.
   */
  async duplicates(org: Org, actor: { id: string }) {
    const groups = await this.store.collection(attachments).aggregate<{ _id: string; files: { id: string; fileName: string; createdAt: Date; uploadedById: string; entityType: AttachmentEntity; entityId: string }[]; records: number }>([
      { $match: { removedAt: null } },
      { $group: { _id: '$sha256', files: { $push: { id: '$_id', fileName: '$fileName', createdAt: '$createdAt', uploadedById: '$uploadedById', entityType: '$entityType', entityId: '$entityId' } }, refs: { $addToSet: { t: '$entityType', i: '$entityId' } }, latest: { $max: '$createdAt' } } },
      { $project: { files: 1, latest: 1, records: { $size: '$refs' } } },
      { $match: { records: { $gt: 1 } } },
      { $sort: { latest: -1 } },
      { $limit: 300 },
    ]);
    const refs = await this.describe(org, actor, groups.flatMap((g) => g.files.map((f) => ({ entityType: f.entityType, entityId: f.entityId }))));
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(groups.flatMap((g) => g.files.map((f) => f.uploadedById)))] } }, select: { id: true, name: true } });
    const name = new Map(users.map((u) => [u.id, u.name]));
    const out = [];
    for (const g of groups) {
      const seen = g.files.filter((f) => refs.has(`${f.entityType}:${f.entityId}`));
      const records = new Set(seen.map((f) => `${f.entityType}:${f.entityId}`));
      if (records.size < 2) continue;
      const verdict = duplicateFileRisk([...records].map((k) => refs.get(k)!.use));
      out.push({
        sha256: g._id,
        ...verdict,
        latest: seen.reduce((m, f) => (f.createdAt > m ? f.createdAt : m), seen[0]!.createdAt).toISOString(),
        files: seen
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((f) => {
            const r = refs.get(`${f.entityType}:${f.entityId}`)!;
            return { attachmentId: f.id, fileName: f.fileName, uploadedAt: f.createdAt.toISOString(), uploadedBy: name.get(f.uploadedById) ?? null, entityType: f.entityType, entityId: f.entityId, label: r.label, path: r.path };
          }),
      });
    }
    out.sort(compareDuplicates);
    return { summary: { groups: out.length, high: out.filter((g) => g.risk === 'HIGH').length, medium: out.filter((g) => g.risk === 'MEDIUM').length }, items: out };
  }

  /** For each hash, the other records (that the caller may see) holding the same file. */
  private async elsewhere(org: Org, actor: { id: string }, hashes: string[], self: { entityType: AttachmentEntity; entityId: string }) {
    const out = new Map<string, { entityType: AttachmentEntity; entityId: string; label: string; path: string | null; fileName: string }[]>();
    if (!hashes.length) return out;
    const rows = await this.store.collection(attachments).find({ sha256: { $in: [...new Set(hashes)] }, removedAt: null }, { projection: { content: 0 } });
    const others = rows.filter((r) => !(r.entityType === self.entityType && r.entityId === self.entityId));
    if (!others.length) return out;
    const refs = await this.describe(org, actor, others.map((r) => ({ entityType: r.entityType as AttachmentEntity, entityId: r.entityId })));
    for (const r of others) {
      const d = refs.get(`${r.entityType}:${r.entityId}`);
      if (!d) continue;
      const list = out.get(r.sha256) ?? [];
      if (!list.some((x) => x.entityType === r.entityType && x.entityId === r.entityId)) list.push({ entityType: r.entityType as AttachmentEntity, entityId: r.entityId, label: d.label, path: d.path, fileName: r.fileName });
      out.set(r.sha256, list);
    }
    return out;
  }

  /** Names and screen paths of records, keeping only those the caller may see. */
  private async describe(org: Org, actor: { id: string }, list: { entityType: AttachmentEntity; entityId: string }[]) {
    const out = new Map<string, { label: string; path: string | null; use: FileUse }>();
    const ids = (t: AttachmentEntity) => [...new Set(list.filter((l) => l.entityType === t).map((l) => l.entityId))];
    const [docs, pays, journals, claims, lines] = await Promise.all([
      ids('DOCUMENT').length ? this.prisma.document.findMany({ where: { orgId: org.id, id: { in: ids('DOCUMENT') } }, select: { id: true, kind: true, number: true } }) : [],
      ids('PAYMENT').length ? this.prisma.payment.findMany({ where: { orgId: org.id, id: { in: ids('PAYMENT') } }, select: { id: true, kind: true, number: true } }) : [],
      ids('JOURNAL_ENTRY').length ? this.prisma.journalEntry.findMany({ where: { orgId: org.id, id: { in: ids('JOURNAL_ENTRY') } }, select: { id: true, entryNumber: true } }) : [],
      ids('EXPENSE_CLAIM').length ? this.prisma.expenseClaim.findMany({ where: { orgId: org.id, id: { in: ids('EXPENSE_CLAIM') } }, select: { id: true, number: true, title: true } }) : [],
      ids('BANK_STATEMENT_LINE').length ? this.prisma.bankStatementLine.findMany({ where: { orgId: org.id, id: { in: ids('BANK_STATEMENT_LINE') } }, select: { id: true, accountId: true, description: true } }) : [],
    ]);
    const DOC: Record<string, { label: string; path: string }> = { INVOICE: { label: 'Invoice', path: 'sales/invoices' }, CREDIT_NOTE: { label: 'Credit note', path: 'sales/invoices' }, BILL: { label: 'Bill', path: 'purchases/bills' }, VENDOR_CREDIT: { label: 'Vendor credit', path: 'purchases/bills' } };
    const found: [AttachmentEntity, string, { label: string; path: string | null; use: FileUse }][] = [
      ...docs.map((d) => ['DOCUMENT', d.id, { label: `${DOC[d.kind]?.label ?? d.kind} ${d.number ?? '(draft)'}`, path: `${DOC[d.kind]?.path ?? 'sales/invoices'}/${d.id}`, use: d.kind === 'BILL' ? 'BILL' : 'OTHER' }] as const),
      ...pays.map((p) => ['PAYMENT', p.id, { label: `${p.kind === 'RECEIPT' ? 'Receipt' : 'Payment'} ${p.number}`, path: `${p.kind === 'RECEIPT' ? 'sales/receipts' : 'purchases/payments'}/${p.id}`, use: 'OTHER' }] as const),
      ...journals.map((j) => ['JOURNAL_ENTRY', j.id, { label: `Journal ${j.entryNumber ?? '(draft)'}`, path: `journals/${j.id}`, use: 'OTHER' }] as const),
      ...claims.map((c) => ['EXPENSE_CLAIM', c.id, { label: `Expense claim ${c.number}: ${c.title}`, path: `expenses/${c.id}`, use: 'EXPENSE_CLAIM' }] as const),
      ...lines.map((l) => ['BANK_STATEMENT_LINE', l.id, { label: `Bank line: ${l.description}`, path: `banking/${l.accountId}/reconcile`, use: 'OTHER' }] as const),
      ...ids('CUSTOMER_ONBOARDING').map((id) => ['CUSTOMER_ONBOARDING', id, { label: 'Onboarding documents', path: null, use: 'OTHER' }] as const),
    ] as never;
    for (const [type, id, d] of found) {
      try {
        await this.entity(org, actor, type, id, 'read');
        out.set(`${type}:${id}`, d);
      } catch {
        // Not the caller's to see: left out rather than named.
      }
    }
    return out;
  }

  async content(org: Org, actor: { id: string }, id: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id, orgId: org.id } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Attachment not found' });
    await this.entity(org, actor, a.entityType, a.entityId, 'read');
    if (a.removedAt) throw new DomainError('REMOVED', 'This file was removed', HttpStatus.GONE);
    return a;
  }

  async remove(org: Org, actor: { id: string }, id: string, reason: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id, orgId: org.id }, select: { entityType: true, entityId: true, removedAt: true, fileName: true } });
    if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Attachment not found' });
    await this.entity(org, actor, a.entityType, a.entityId, 'manage');
    if (a.removedAt) throw new DomainError('ALREADY_REMOVED', 'This file was already removed', HttpStatus.CONFLICT);
    return this.prisma.$transaction(async (tx) => {
      await this.moved.update(tx, ATTACHMENTS, org.id, id, { removedAt: new Date(), removedById: actor.id, removedReason: reason });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'attachment.removed', entityType: 'attachment', entityId: id, data: { fileName: a.fileName, reason } });
      return { id, removed: true };
    });
  }

  /** The record must exist in this organisation, and the caller needs read or manage rights on it. */
  private async entity(org: Org, actor: { id: string }, type: AttachmentEntity, id: string, access: 'read' | 'manage') {
    let permission: Permission;
    switch (type) {
      case 'DOCUMENT': {
        const d = await this.prisma.document.findFirst({ where: { id, orgId: org.id }, select: { kind: true } });
        if (!d) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Document not found' });
        const area = d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE' ? 'sales' : 'purchases';
        permission = `${area}.${access}`;
        break;
      }
      case 'PAYMENT': {
        const p = await this.prisma.payment.findFirst({ where: { id, orgId: org.id }, select: { kind: true } });
        if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Payment not found' });
        permission = `${p.kind === 'RECEIPT' ? 'sales' : 'purchases'}.${access}`;
        break;
      }
      case 'JOURNAL_ENTRY': {
        const j = await this.prisma.journalEntry.findFirst({ where: { id, orgId: org.id }, select: { id: true } });
        if (!j) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
        permission = access === 'read' ? 'journals.read' : 'journals.create';
        break;
      }
      case 'BANK_STATEMENT_LINE': {
        const l = await this.prisma.bankStatementLine.findFirst({ where: { id, orgId: org.id }, select: { id: true } });
        if (!l) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Statement line not found' });
        permission = `banking.${access}`;
        break;
      }
      case 'CUSTOMER_ONBOARDING': {
        const o = await this.prisma.customerOnboarding.findFirst({ where: { id, orgId: org.id }, select: { status: true, party: true } });
        if (!o) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Onboarding not found' });
        // The files behind an onboarding stay as they were once it is submitted.
        if (access === 'manage' && o.status !== 'OPEN') throw new DomainError('ONBOARDING_NOT_OPEN', 'Files can be added or removed only while the onboarding is in progress', HttpStatus.CONFLICT);
        permission = `${o.party === 'VENDOR' ? 'purchases' : 'sales'}.${access}`;
        break;
      }
      case 'EXPENSE_CLAIM':
        // Claimants see and add receipts on their own claims; see ExpensesService.
        return this.expenses.attachmentAccess(org, actor.id, id, access);
      default:
        throw new DomainError('INVALID_ENTITY', 'Unknown record type');
    }
    if (!hasPermission(org.role, permission)) {
      throw new DomainError('FORBIDDEN', `Your role (${org.role}) cannot ${access === 'read' ? 'see' : 'change'} files on this record; it needs ${permission}`, HttpStatus.FORBIDDEN);
    }
  }
}
