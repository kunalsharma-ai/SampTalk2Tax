import { currentTenantContext } from '../common/tenant-context';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@talk2tax/database';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { lockName } from '../db/locks';
import { allowedInTx } from '../db/guards/allow';

export interface AuditInput {
  orgId: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
}

/**
 * Records evidence files can be attached to (AttachmentEntity), by their audit entity type. An
 * event about one of them carries a reference to each file attached at that moment: its id, name
 * and SHA-256. The reference is part of the hashed event, so the trail shows which receipts a bill
 * had when it was posted, and a file swapped later no longer matches its recorded checksum.
 */
export const EVIDENCE_ENTITIES: Record<string, 'DOCUMENT' | 'PAYMENT' | 'JOURNAL_ENTRY' | 'BANK_STATEMENT_LINE' | 'EXPENSE_CLAIM' | 'CUSTOMER_ONBOARDING'> = {
  document: 'DOCUMENT',
  payment: 'PAYMENT',
  journal_entry: 'JOURNAL_ENTRY',
  bank_statement_line: 'BANK_STATEMENT_LINE',
  expense_claim: 'EXPENSE_CLAIM',
  customer_onboarding: 'CUSTOMER_ONBOARDING',
};
export const MAX_EVIDENCE_REFS = 20;
export interface EvidenceRef {
  attachmentId: string;
  fileName: string;
  sha256: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function auditHash(prevHash: string | null, e: { orgId: string | null; actorId: string | null; action: string; entityType: string; entityId: string | null; data: unknown; createdAt: string }): string {
  return createHash('sha256').update(`${prevHash ?? ''}|${canonical(e)}`).digest('hex');
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append a hash-chained event inside the caller's transaction. A transaction-scoped
   * advisory lock serialises appends per organisation so the chain cannot fork.
   */
  async append(tx: Tx, input: AuditInput): Promise<void> {
    // A trial run (a check made by doing the work and undoing it) leaves no trail.
    if (allowedInTx('trial_run')) return;
    // Events with no organisation form one global chain shared by every user; reading its
    // last link crosses tenants, so it is done with system access for this step only.
    if (input.orgId === null) return withSystemAccess(tx, () => this.appendRow(tx, input));
    return this.appendRow(tx, input);
  }

  private async appendRow(tx: Tx, input: AuditInput): Promise<void> {
    const chainKey = input.orgId ?? 'global';
    await lockName(tx, 'audit:' + chainKey);
    const prev = await tx.auditEvent.findFirst({
      where: { orgId: input.orgId },
      orderBy: { id: 'desc' },
      select: { hash: true },
    });
    const createdAt = new Date();
    // A change made through the CRM API records the key it came with, next to the key's creator.
    const apiKey = currentTenantContext().apiKey;
    let data = (input.data ?? null) as Record<string, unknown> | null;
    if (apiKey) data = { ...(data ?? {}), viaApiKey: { id: apiKey.id, prefix: apiKey.prefix } };
    const evidence = await this.evidence(tx, input);
    if (evidence.length) data = { ...(data ?? {}), evidence };
    const hash = auditHash(prev?.hash ?? null, {
      orgId: input.orgId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      data: data as Prisma.InputJsonValue | null,
      createdAt: createdAt.toISOString(),
    });
    await tx.auditEvent.create({
      data: {
        orgId: input.orgId,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        data: (data as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
        prevHash: prev?.hash ?? null,
        hash,
        createdAt,
      },
    });
  }

  /** The files attached to the event's record as the event happens (none for other records). */
  private async evidence(tx: Tx, input: AuditInput): Promise<EvidenceRef[]> {
    const kind = EVIDENCE_ENTITIES[input.entityType];
    if (!kind || !input.orgId || !input.entityId || (input.data && 'evidence' in input.data)) return [];
    const files = await tx.attachment.findMany({
      where: { orgId: input.orgId, entityType: kind, entityId: input.entityId, removedAt: null },
      select: { id: true, fileName: true, sha256: true },
      orderBy: { createdAt: 'asc' },
      take: MAX_EVIDENCE_REFS,
    });
    return files.map((f) => ({ attachmentId: f.id, fileName: f.fileName, sha256: f.sha256 }));
  }

  async list(orgId: string, opts: { entityType?: string; entityId?: string; limit: number; beforeId?: bigint }) {
    const rows = await this.prisma.auditEvent.findMany({
      where: { orgId, entityType: opts.entityType, entityId: opts.entityId, ...(opts.beforeId ? { id: { lt: opts.beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: opts.limit,
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      actorId: r.actorId,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      data: r.data,
      hash: r.hash,
      prevHash: r.prevHash,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Recompute the whole chain for an organisation and report the first break, if any. */
  async verify(orgId: string): Promise<{ valid: boolean; checked: number; brokenAtId?: string }> {
    let prevHash: string | null = null;
    let checked = 0;
    let cursor: bigint | undefined;
    for (;;) {
      const batch = await this.prisma.auditEvent.findMany({
        where: { orgId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      if (batch.length === 0) break;
      for (const e of batch) {
        const expected = auditHash(prevHash, {
          orgId: e.orgId,
          actorId: e.actorId,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          data: e.data,
          createdAt: e.createdAt.toISOString(),
        });
        if (e.prevHash !== prevHash || e.hash !== expected) return { valid: false, checked, brokenAtId: e.id.toString() };
        prevHash = e.hash;
        checked++;
      }
      cursor = batch[batch.length - 1].id;
    }
    return { valid: true, checked };
  }
}
