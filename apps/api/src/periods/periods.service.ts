import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { fromDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';
import { OrganizationsService } from '../organizations/organizations.service';

@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly orgs: OrganizationsService,
  ) {}

  async list(orgId: string, fiscalYear?: number) {
    const rows = await this.prisma.fiscalPeriod.findMany({ where: { orgId, fiscalYear }, orderBy: [{ startDate: 'asc' }] });
    return rows.map(serialize);
  }

  async createFiscalYear(orgId: string, actorId: string, fiscalYear: number, startMonth: number) {
    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.fiscalPeriod.count({ where: { orgId, fiscalYear } });
      if (exists) throw new ConflictException({ error: 'FISCAL_YEAR_EXISTS', message: `FY${fiscalYear} already exists` });
      const periods = await this.orgs.createFiscalYear(tx, orgId, fiscalYear, startMonth);
      await this.audit.append(tx, { orgId, actorId, action: 'fiscal_year.created', entityType: 'fiscal_year', entityId: String(fiscalYear), data: { fiscalYear, periods: periods.length } });
      return (await tx.fiscalPeriod.findMany({ where: { orgId, fiscalYear }, orderBy: { periodNo: 'asc' } })).map(serialize);
    });
  }

  /**
   * Lock or unlock a period. Takes a row lock (FOR UPDATE) so it waits for any posting
   * that holds the period FOR SHARE, and no new posting can slip in after the lock.
   */
  async setLocked(orgId: string, periodId: string, actorId: string, locked: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status FROM fiscal_periods WHERE id = ${periodId}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
      const p = rows[0];
      if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Period not found' });
      if (p.status === 'CLOSED') throw new ConflictException({ error: 'PERIOD_CLOSED', message: 'Closed periods cannot be changed' });
      if (!locked) {
        const close = await tx.periodClose.findUnique({ where: { periodId }, select: { status: true } });
        if (close?.status === 'CLOSED') throw new ConflictException({ error: 'PERIOD_CLOSE_CERTIFIED', message: 'This month was closed at month end. Reopen the month-end close instead, which records why.' });
      }
      const target = locked ? 'LOCKED' : 'OPEN';
      if (p.status === target) throw new ConflictException({ error: 'NO_CHANGE', message: `Period is already ${target}` });
      const updated = await tx.fiscalPeriod.update({
        where: { id: periodId },
        data: { status: target, lockedAt: locked ? new Date() : null, lockedById: locked ? actorId : null },
      });
      await this.audit.append(tx, { orgId, actorId, action: locked ? 'period.locked' : 'period.unlocked', entityType: 'fiscal_period', entityId: periodId, data: { name: updated.name } });
      return serialize(updated);
    });
  }
}

function serialize(p: { id: string; fiscalYear: number; periodNo: number; name: string; startDate: Date; endDate: Date; status: string; lockedAt: Date | null }) {
  return {
    id: p.id,
    fiscalYear: p.fiscalYear,
    periodNo: p.periodNo,
    name: p.name,
    startDate: fromDbDate(p.startDate),
    endDate: fromDbDate(p.endDate),
    status: p.status,
    lockedAt: p.lockedAt?.toISOString() ?? null,
  };
}
