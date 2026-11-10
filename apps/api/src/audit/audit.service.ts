import { currentTenantContext } from '../common/tenant-context';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@talk2tax/database';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { lockName } from '../db/locks';

export interface AuditInput {
  orgId: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
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
    const data = (apiKey ? { ...((input.data as Record<string, unknown> | null) ?? {}), viaApiKey: { id: apiKey.id, prefix: apiKey.prefix } } : (input.data ?? null)) as Prisma.InputJsonValue | null;
    const hash = auditHash(prev?.hash ?? null, {
      orgId: input.orgId,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      data,
      createdAt: createdAt.toISOString(),
    });
    await tx.auditEvent.create({
      data: {
        orgId: input.orgId,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        data: data ?? Prisma.JsonNull,
        prevHash: prev?.hash ?? null,
        hash,
        createdAt,
      },
    });
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
