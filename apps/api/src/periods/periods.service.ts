import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { generateFiscalYear } from '@talk2tax/accounting-engine';
import type { ScopedCollection } from '@talk2tax/document-db';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, Tx } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { fiscalPeriods, type FiscalPeriodDoc } from '../db/collections/chart';
import { PostgresMirrorService, postgresWithMongo, thenInPostgres } from '../db/postgres-mirror.service';
import { lockRow } from '../db/locks';

/**
 * Fiscal years and their periods. MongoDB holds them; each change is copied to PostgreSQL,
 * where postings (not moved yet) check the period they fall in.
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
    private readonly mirror: PostgresMirrorService,
  ) {}

  private periods<T>(orgId: string, fn: (c: ScopedCollection<FiscalPeriodDoc>) => Promise<T>) {
    return runInOrg(orgId, () => fn(this.store.collection(fiscalPeriods)));
  }

  async list(orgId: string, fiscalYear?: number) {
    const rows = await this.periods(orgId, (c) => c.find(fiscalYear === undefined ? {} : { fiscalYear }, { sort: { startDate: 1 } }));
    return rows.map(serialize);
  }

  /** Adds a fiscal year's periods in MongoDB (one transaction). Returns them, oldest first. */
  async insertFiscalYear(orgId: string, fiscalYear: number, startMonth: number): Promise<FiscalPeriodDoc[]> {
    const periods = generateFiscalYear(fiscalYear, startMonth);
    return this.store.transaction(() =>
      this.periods(orgId, async (c) => {
        const out: FiscalPeriodDoc[] = [];
        // One at a time, so each one's overlap check sees the ones before it.
        for (const p of periods) {
          out.push(await c.insertOne({ fiscalYear: p.fiscalYear, periodNo: p.periodNo, name: p.name, startDate: toDbDate(p.startDate), endDate: toDbDate(p.endDate), status: 'OPEN', lockedAt: null, lockedById: null }));
        }
        return out;
      }),
    );
  }

  /** Undoes insertFiscalYear. */
  async removeFiscalYear(orgId: string, ids: string[]) {
    await this.periods(orgId, (c) => c.deleteMany({ id: { $in: ids } }));
  }

  async createFiscalYear(orgId: string, actorId: string, fiscalYear: number, startMonth: number) {
    const exists = await this.periods(orgId, (c) => c.count({ fiscalYear }));
    if (exists) throw new ConflictException({ error: 'FISCAL_YEAR_EXISTS', message: `FY${fiscalYear} already exists` });
    let created: FiscalPeriodDoc[];
    try {
      created = await this.insertFiscalYear(orgId, fiscalYear, startMonth);
    } catch (e) {
      if ((await this.periods(orgId, (c) => c.count({ fiscalYear }))) > 0) throw new ConflictException({ error: 'FISCAL_YEAR_EXISTS', message: `FY${fiscalYear} already exists` });
      throw e;
    }
    const ids = created.map((p) => p.id);
    return thenInPostgres(
      created.map(serialize),
      () =>
        this.prisma.$transaction(async (tx) => {
          await this.mirror.fiscalPeriods(ids, tx);
          await this.audit.append(tx, { orgId, actorId, action: 'fiscal_year.created', entityType: 'fiscal_year', entityId: String(fiscalYear), data: { fiscalYear, periods: created.length } });
        }),
      () => this.removeFiscalYear(orgId, ids),
    );
  }

  /**
   * Inside a PostgreSQL transaction that holds the period's copy FOR UPDATE (so it has waited
   * for postings in progress and none can start): sets the status in MongoDB, copies it, and
   * registers how to reverse the MongoDB change if the transaction then fails.
   */
  async setStatusInTx(tx: Tx, undoLater: (undo: () => Promise<unknown>) => void, orgId: string, periodId: string, to: 'OPEN' | 'LOCKED', actorId: string) {
    const from = to === 'LOCKED' ? 'OPEN' : 'LOCKED';
    const before = await this.periods(orgId, (c) => c.findOne({ id: periodId }));
    const r = await this.periods(orgId, (c) =>
      c.updateOne({ id: periodId, status: from }, { $set: to === 'LOCKED' ? { status: 'LOCKED', lockedAt: new Date(), lockedById: actorId } : { status: 'OPEN', lockedAt: null, lockedById: null } }),
    );
    if (r.modified === 0) throw new ConflictException({ error: 'NO_CHANGE', message: `Period is already ${to}` });
    undoLater(() => this.periods(orgId, (c) => c.updateOne({ id: periodId, status: to }, { $set: { status: from, lockedAt: before?.lockedAt ?? null, lockedById: before?.lockedById ?? null } })));
    await this.mirror.fiscalPeriods([periodId], tx);
    return (await this.periods(orgId, (c) => c.findOne({ id: periodId })))!;
  }

  /**
   * Lock or unlock a period. Takes a row lock (FOR UPDATE) on the period's PostgreSQL copy so it
   * waits for any posting that holds the period FOR SHARE, and no new posting can slip in.
   */
  async setLocked(orgId: string, periodId: string, actorId: string, locked: boolean) {
    return postgresWithMongo(this.prisma, async (tx, undoLater) => {
      const rows = await lockRow<{ id: string }>(tx, 'fiscal_periods', periodId, orgId);
      const p = rows[0] ? await this.periods(orgId, (c) => c.findOne({ id: periodId })) : null;
      if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Period not found' });
      if (p.status === 'CLOSED') throw new ConflictException({ error: 'PERIOD_CLOSED', message: 'Closed periods cannot be changed' });
      if (!locked) {
        const close = await tx.periodClose.findUnique({ where: { periodId }, select: { status: true } });
        if (close?.status === 'CLOSED') throw new ConflictException({ error: 'PERIOD_CLOSE_CERTIFIED', message: 'This month was closed at month end. Reopen the month-end close instead, which records why.' });
      }
      const target = locked ? 'LOCKED' : 'OPEN';
      if (p.status === target) throw new ConflictException({ error: 'NO_CHANGE', message: `Period is already ${target}` });
      const updated = await this.setStatusInTx(tx, undoLater, orgId, periodId, target, actorId);
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
