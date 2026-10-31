import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AttachmentEntity } from '@talk2tax/database';
import { hasPermission, Permission } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { OrgContext } from '../auth/decorators';
import { ExpensesService } from '../expenses/expenses.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

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
  ) {}

  async list(org: Org, actor: { id: string }, entityType: AttachmentEntity, entityId: string, includeRemoved: boolean) {
    await this.entity(org, actor, entityType, entityId, 'read');
    const rows = await this.prisma.attachment.findMany({
      where: { orgId: org.id, entityType, entityId, ...(includeRemoved ? {} : { removedAt: null }) },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, uploadedById: true, createdAt: true, removedAt: true, removedReason: true },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.uploadedById))] } }, select: { id: true, name: true } });
    return rows.map((r) => ({
      ...r,
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
    return this.prisma.$transaction(async (tx) => {
      const count = await tx.attachment.count({ where: { orgId: org.id, entityType: input.entityType, entityId: input.entityId, removedAt: null } });
      if (count >= MAX_PER_RECORD) throw new DomainError('TOO_MANY_FILES', `A record can have at most ${MAX_PER_RECORD} files`, HttpStatus.CONFLICT);
      const same = await tx.attachment.findFirst({ where: { orgId: org.id, entityType: input.entityType, entityId: input.entityId, sha256, removedAt: null }, select: { id: true } });
      if (same) throw new DomainError('DUPLICATE_FILE', 'This file is already attached to this record', HttpStatus.CONFLICT, { attachmentId: same.id });
      const a = await tx.attachment.create({
        data: {
          orgId: org.id,
          entityType: input.entityType,
          entityId: input.entityId,
          fileName: cleanFileName(input.fileName),
          contentType,
          sizeBytes: input.content.length,
          sha256,
          content: new Uint8Array(input.content),
          uploadedById: actor.id,
        },
        select: { id: true, fileName: true, contentType: true, sizeBytes: true, sha256: true, createdAt: true },
      });
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
      await tx.attachment.update({ where: { id }, data: { removedAt: new Date(), removedById: actor.id, removedReason: reason } });
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
