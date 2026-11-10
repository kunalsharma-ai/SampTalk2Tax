import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { errorFingerprintParts, routePattern } from '@talk2tax/accounting-engine';
import { createHash, randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { lockName } from '../db/locks';

/** Occurrences older than this are removed (the group and its counts stay). */
export const ERROR_RETENTION_DAYS = 30;

export interface ErrorReport {
  error: unknown;
  status: number;
  requestId: string;
  method: string;
  path: string;
  orgId: string | null;
  userId: string | null;
}

/**
 * Error tracking (ADMIN-017). Every unexpected server error (a 5xx) is kept with the request id
 * the person was shown, grouped with the same problem from other requests and organisations.
 * A resolved group that happens again is opened again. Recording never fails the request.
 */
@Injectable()
export class ErrorsService {
  private readonly logger = new Logger('Errors');
  private recorded = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async record(r: ErrorReport): Promise<void> {
    try {
      const e = r.error instanceof Error ? r.error : new Error(String(r.error));
      const parts = errorFingerprintParts({ name: e.name, stack: e.stack, message: e.message }, r.method, r.path);
      const fingerprint = createHash('sha256').update(parts.key).digest('hex');
      const message = (e.message || 'No message').slice(0, 2000);
      const now = new Date();
      // Platform records, outside any organisation's row-level security.
      await tenantStorage.run({ bypass: true }, async () =>
        await this.prisma.$transaction(async (tx) => {
          await lockName(tx, 'error-group:' + fingerprint);
          const existing = await tx.errorGroup.findUnique({ where: { fingerprint } });
          const group = existing
            ? await tx.errorGroup.update({ where: { id: existing.id }, data: { occurrences: { increment: 1 }, lastSeenAt: now, message, resolvedAt: null, resolvedBy: null } })
            : await tx.errorGroup.create({ data: { id: randomUUID(), fingerprint, name: parts.name, message, method: r.method.toUpperCase().slice(0, 8), route: parts.route, frame: parts.frame, occurrences: 1, firstSeenAt: now, lastSeenAt: now } });
          await tx.errorEvent.create({
            data: { groupId: group.id, requestId: r.requestId, status: r.status, method: r.method.toUpperCase().slice(0, 8), path: routePattern(r.path).slice(0, 500), orgId: r.orgId, userId: r.userId, message, stack: e.stack?.slice(0, 8000) ?? null },
          });
        }),
      );
      if (++this.recorded % 100 === 1) await this.prune();
    } catch (failure) {
      this.logger.warn(`Could not record an error: ${(failure as Error).message}`);
    }
  }

  async prune(now = new Date()) {
    const before = new Date(now.getTime() - ERROR_RETENTION_DAYS * 86_400_000);
    await tenantStorage.run({ bypass: true }, async () => await this.prisma.errorEvent.deleteMany({ where: { createdAt: { lt: before } } }));
  }

  /** Occurrences are under row-level security (they can name an organisation); the platform reads them as the system. */
  private system<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => withSystemAccess(tx, () => fn(tx)));
  }

  async groups(status: 'open' | 'resolved' | 'all') {
    return this.system((tx) => this.groupsIn(tx, status));
  }

  private async groupsIn(tx: Tx, status: 'open' | 'resolved' | 'all') {
    const since24h = new Date(Date.now() - 86_400_000);
    const rows = await tx.errorGroup.findMany({
      where: status === 'all' ? {} : status === 'open' ? { resolvedAt: null } : { resolvedAt: { not: null } },
      orderBy: { lastSeenAt: 'desc' },
      take: 200,
      include: { _count: { select: { events: { where: { createdAt: { gte: since24h } } } } } },
    });
    const [open, last24h] = await Promise.all([tx.errorGroup.count({ where: { resolvedAt: null } }), tx.errorEvent.count({ where: { createdAt: { gte: since24h } } })]);
    return {
      totals: { open, last24h },
      groups: rows.map((g) => ({ id: g.id, name: g.name, message: g.message, method: g.method, route: g.route, frame: g.frame, occurrences: g.occurrences, last24h: g._count.events, firstSeenAt: g.firstSeenAt, lastSeenAt: g.lastSeenAt, resolvedAt: g.resolvedAt })),
    };
  }

  async group(id: string) {
    return this.system((tx) => this.groupIn(tx, id));
  }

  /** Counts for System health. */
  async counts() {
    return this.system(async (tx) => ({
      open: await tx.errorGroup.count({ where: { resolvedAt: null } }),
      lastHour: await tx.errorEvent.count({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) } } }),
    }));
  }

  private async groupIn(tx: Tx, id: string) {
    const g = await tx.errorGroup.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: 'desc' }, take: 25 } } });
    if (!g) throw new DomainError('NOT_FOUND', 'Error group not found', HttpStatus.NOT_FOUND);
    const resolver = g.resolvedBy ? await tx.user.findUnique({ where: { id: g.resolvedBy }, select: { name: true } }) : null;
    return {
      id: g.id,
      name: g.name,
      message: g.message,
      method: g.method,
      route: g.route,
      frame: g.frame,
      occurrences: g.occurrences,
      firstSeenAt: g.firstSeenAt,
      lastSeenAt: g.lastSeenAt,
      resolvedAt: g.resolvedAt,
      resolvedBy: resolver?.name ?? null,
      events: g.events.map((e) => ({ id: e.id.toString(), requestId: e.requestId, status: e.status, method: e.method, path: e.path, orgId: e.orgId, userId: e.userId, message: e.message, stack: e.stack, at: e.createdAt })),
    };
  }

  /** Find the occurrence behind a request id a person quoted. */
  async byRequestId(requestId: string) {
    return this.system(async (tx) => {
      const e = await tx.errorEvent.findFirst({ where: { requestId }, select: { groupId: true } });
      if (!e) throw new DomainError('NOT_FOUND', 'No server error was recorded for this request id', HttpStatus.NOT_FOUND);
      return this.groupIn(tx, e.groupId);
    });
  }

  async resolve(actor: AuthUser, id: string, resolved: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const g = await tx.errorGroup.findUnique({ where: { id } });
      if (!g) throw new DomainError('NOT_FOUND', 'Error group not found', HttpStatus.NOT_FOUND);
      await tx.errorGroup.update({ where: { id }, data: resolved ? { resolvedAt: new Date(), resolvedBy: actor.id } : { resolvedAt: null, resolvedBy: null } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: resolved ? 'platform.error_resolved' : 'platform.error_reopened', entityType: 'error_group', entityId: id, data: { name: g.name, route: `${g.method} ${g.route}` } });
    });
    return this.group(id);
  }
}
