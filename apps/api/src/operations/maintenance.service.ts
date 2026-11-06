import { HttpStatus, Injectable } from '@nestjs/common';
import { maintenanceState } from '@talk2tax/accounting-engine';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/decorators';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/** How long the answer to "is maintenance on?" is reused, so the check costs nothing per request. */
const CACHE_MS = 5_000;

type Window = { id: string; message: string; startsAt: Date; expectedEndAt: Date | null; createdAt: Date; endedAt: Date | null };
const view = (w: Window, now = new Date()) => ({ id: w.id, message: w.message, startsAt: w.startsAt, expectedEndAt: w.expectedEndAt, createdAt: w.createdAt, endedAt: w.endedAt, state: maintenanceState(w, now) });

/**
 * Maintenance windows (ADMIN-020). While one is in progress, nothing can be changed by anyone
 * except the people who run Talk2Tax: reading, exporting and signing in keep working, payment
 * webhooks are still received, and the background runners pause. Everyone sees a banner, and a
 * scheduled window is announced before it starts.
 */
@Injectable()
export class MaintenanceService {
  private cache: { at: number; open: Window | null } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async open(): Promise<Window | null> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.open;
    const open = await this.prisma.maintenanceWindow.findFirst({ where: { endedAt: null } });
    this.cache = { at: Date.now(), open };
    return open;
  }

  /** The open window (scheduled or in progress), for the banner everyone sees. */
  async current() {
    const w = await this.open();
    return w ? view(w) : null;
  }

  async paused(): Promise<boolean> {
    const w = await this.open();
    return w !== null && maintenanceState(w, new Date()) === 'IN_PROGRESS';
  }

  async list() {
    const rows = await this.prisma.maintenanceWindow.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    const people = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.createdBy, r.endedBy].filter((x): x is string => !!x)))] } }, select: { id: true, name: true } });
    const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
    return rows.map((r) => ({ ...view(r), createdBy: name(r.createdBy), endedBy: name(r.endedBy) }));
  }

  async start(actor: AuthUser, input: { message: string; startsAt?: string; expectedEndAt?: string | null }) {
    const now = new Date();
    const startsAt = input.startsAt ? new Date(input.startsAt) : now;
    const expectedEndAt = input.expectedEndAt ? new Date(input.expectedEndAt) : null;
    if (startsAt.getTime() < now.getTime() - 60_000) throw new DomainError('INVALID_WINDOW', 'A maintenance window cannot start in the past', HttpStatus.BAD_REQUEST);
    if (expectedEndAt && expectedEndAt <= startsAt) throw new DomainError('INVALID_WINDOW', 'The expected end must be after the start', HttpStatus.BAD_REQUEST);
    const w = await this.prisma.$transaction(async (tx) => {
      const open = await tx.maintenanceWindow.findFirst({ where: { endedAt: null } });
      if (open) throw new DomainError('MAINTENANCE_ALREADY_OPEN', 'A maintenance window is already scheduled or in progress; end it first', HttpStatus.CONFLICT);
      const created = await tx.maintenanceWindow.create({ data: { id: randomUUID(), message: input.message.trim(), startsAt, expectedEndAt, createdBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.maintenance_started', entityType: 'maintenance', entityId: created.id, data: { message: created.message, startsAt: startsAt.toISOString(), expectedEndAt: expectedEndAt?.toISOString() ?? null } });
      return created;
    });
    this.cache = null;
    return view(w);
  }

  async end(actor: AuthUser, id: string) {
    const w = await this.prisma.$transaction(async (tx) => {
      const open = await tx.maintenanceWindow.findUnique({ where: { id } });
      if (!open) throw new DomainError('NOT_FOUND', 'Maintenance window not found', HttpStatus.NOT_FOUND);
      if (open.endedAt) throw new DomainError('MAINTENANCE_ENDED', 'This maintenance window has already ended', HttpStatus.CONFLICT);
      const ended = await tx.maintenanceWindow.update({ where: { id }, data: { endedAt: new Date(), endedBy: actor.id } });
      await this.audit.append(tx, { orgId: null, actorId: actor.id, action: 'platform.maintenance_ended', entityType: 'maintenance', entityId: id, data: { wasInProgress: open.startsAt <= new Date() } });
      return ended;
    });
    this.cache = null;
    return view(w);
  }

  /** The refusal for a change while maintenance is in progress. */
  async refusal(): Promise<{ message: string; retryAfterSeconds: number | null } | null> {
    const w = await this.open();
    if (!w || maintenanceState(w, new Date()) !== 'IN_PROGRESS') return null;
    const retry = w.expectedEndAt ? Math.max(60, Math.ceil((w.expectedEndAt.getTime() - Date.now()) / 1000)) : null;
    return { message: `Talk2Tax is under maintenance: ${w.message} Your records can be read and exported; changes are paused until it ends.`, retryAfterSeconds: retry };
  }
}
