import { Injectable, Logger } from '@nestjs/common';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { runAsSystem } from '../common/tenant-context';
import { accounts, fiscalPeriods } from './collections/chart';
import { journalEntries } from './collections/ledger';
import { users } from './collections/identity';
import { mirrorParentDeleted, pgOf } from './mirror-writes';
import { memberships, organizations } from './collections/tenancy';

/**
 * Transitional, for the move to MongoDB (docs/MONGODB.md › While both databases run).
 *
 * MongoDB is the record for a moved collection. Modules still on PostgreSQL point at some
 * of those records with foreign keys (memberships.user_id, …) and read them in joins, so a
 * copy of each moved row is kept in its old PostgreSQL table. Only the moved module writes
 * the copy, right after its MongoDB transaction commits, from what MongoDB now holds.
 * The copies go away with the last step of the move.
 */
@Injectable()
export class PostgresMirrorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: DocumentStoreService,
  ) {}

  /** Copies these users, as MongoDB has them now, into PostgreSQL `users`. */
  async users(ids: readonly string[], tx?: Tx): Promise<void> {
    if (!ids.length) return;
    const rows = await this.store.collection(users).find({ id: { $in: [...new Set(ids)] } });
    const write = async (t: Tx) => {
      for (const u of rows) {
        const data = {
          email: u.email,
          name: u.name,
          passwordHash: u.passwordHash,
          isActive: u.isActive,
          platformRole: u.platformRole,
          language: u.language,
          numberFormat: u.numberFormat,
          dateFormat: u.dateFormat,
          timeZone: u.timeZone,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        };
        await t.user.upsert({ where: { id: u.id }, create: { id: u.id, ...data }, update: data });
      }
    };
    await (tx ? write(tx) : this.prisma.$transaction(write));
  }

  /**
   * Copies these organisations into PostgreSQL `organizations`. A new organisation and its
   * control accounts point at each other there, so it is first copied `withoutAccounts`,
   * then its accounts, then the organisation again.
   */
  async organizations(ids: readonly string[], tx?: Tx, opts: { withoutAccounts?: boolean } = {}): Promise<void> {
    if (!ids.length) return;
    const rows = await this.store.collection(organizations).find({ id: { $in: [...new Set(ids)] } });
    await this.inPostgres(tx, async (t) => {
      for (const { id, ownerChanges: _o, periodChanges: _p, ...o } of rows) {
        const data = opts.withoutAccounts ? { ...o, arAccountId: null, apAccountId: null, claimsAccountId: null } : o;
        await t.organization.upsert({ where: { id }, create: { id, ...data }, update: opts.withoutAccounts ? {} : data });
      }
    });
  }

  /** Copies these accounts into PostgreSQL `accounts`, parents before their children. */
  async accounts(ids: readonly string[], tx?: Tx): Promise<void> {
    if (!ids.length) return;
    const rows = await runAsSystem(() => this.store.collection(accounts).find({ id: { $in: [...new Set(ids)] } }));
    const byId = new Map(rows.map((a) => [a.id, a]));
    const ordered: typeof rows = [];
    const placed = new Set<string>();
    const place = (a: (typeof rows)[number]) => {
      if (placed.has(a.id)) return;
      placed.add(a.id);
      const parent = a.parentId ? byId.get(a.parentId) : undefined;
      if (parent) place(parent);
      ordered.push(a);
    };
    rows.forEach(place);
    await this.inPostgres(tx, async (t) => {
      for (const { id, ...a } of ordered) {
        await t.account.upsert({ where: { id }, create: { id, ...a }, update: a });
      }
    });
  }

  /** Copies these fiscal periods into PostgreSQL `fiscal_periods`. */
  async fiscalPeriods(ids: readonly string[], tx?: Tx): Promise<void> {
    if (!ids.length) return;
    const rows = await runAsSystem(() => this.store.collection(fiscalPeriods).find({ id: { $in: [...new Set(ids)] } }));
    await this.inPostgres(tx, async (t) => {
      for (const { id, ...p } of rows) {
        await t.fiscalPeriod.upsert({ where: { id }, create: { id, ...p }, update: { status: p.status, lockedAt: p.lockedAt, lockedById: p.lockedById, name: p.name } });
      }
    });
  }

  /** Copies these memberships into PostgreSQL `memberships`, and removes the ones MongoDB no longer has. */
  async memberships(ids: readonly string[], tx?: Tx): Promise<void> {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    const rows = await runAsSystem(() => this.store.collection(memberships).find({ id: { $in: unique } }));
    const present = new Set(rows.map((m) => m.id));
    await this.inPostgres(tx, async (t) => {
      // Removals first, then upserts: an owner handover keeps one owner in PostgreSQL throughout.
      for (const id of unique.filter((i) => !present.has(i))) await t.membership.deleteMany({ where: { id } });
      for (const { id, ...m } of rows) {
        const data = { orgId: m.orgId, userId: m.userId, role: m.role, createdAt: m.createdAt };
        await t.membership.upsert({ where: { id }, create: { id, ...data }, update: { role: m.role } });
      }
    });
  }

  /**
   * Copies these journal entries, with their lines, into PostgreSQL. Only into `tx`: postings
   * must reach PostgreSQL in the caller's transaction, where documents point at them and the
   * period's copy is held FOR SHARE. A posted copy is never rewritten (it is immutable there
   * too). Lines go in while the copy is a draft, because PostgreSQL refuses lines on a posted
   * entry; the deferred balance check then runs at commit.
   */
  async journalEntries(ids: readonly string[], tx: Tx): Promise<void> {
    if (!ids.length) return;
    const rows = await runAsSystem(() => this.store.collection(journalEntries).find({ id: { $in: [...new Set(ids)] } }));
    for (const { id, lines, orgId, ...e } of rows) {
      const existing = (await pgOf(tx.journalEntry as never).findFirst({ where: { id, orgId }, select: { status: true } })) as { status: string } | null;
      if (existing?.status === 'POSTED') continue;
      const header = { ...e, status: 'DRAFT' as const, entryNumber: null, postedAt: null, postedById: null, type: e.type as never, source: e.source as never };
      if (existing) {
        await tx.journalLine.deleteMany({ where: { entryId: id, orgId } });
        await tx.journalEntry.update({ where: { id }, data: header });
      } else {
        await tx.journalEntry.create({ data: { id, orgId, ...header } });
      }
      await tx.journalLine.createMany({ data: lines.map((l) => ({ ...l, orgId, entryId: id, dimensions: l.dimensions ?? undefined })) });
      if (e.status === 'POSTED') await tx.journalEntry.update({ where: { id }, data: { status: 'POSTED', entryNumber: e.entryNumber, postedAt: e.postedAt, postedById: e.postedById } });
    }
  }

  /** Removes a draft's copy. */
  async removeJournalEntry(id: string, orgId: string, tx: Tx): Promise<void> {
    await tx.journalLine.deleteMany({ where: { entryId: id, orgId } });
    await tx.journalEntry.deleteMany({ where: { id, orgId } });
    await mirrorParentDeleted(tx, this.store, 'journal_entries', orgId, [id]);
  }

  /** Tenant tables in PostgreSQL sit behind row-level security; the copy is system work. */
  private async inPostgres(tx: Tx | undefined, fn: (t: Tx) => Promise<void>) {
    if (tx) return withSystemAccess(tx, () => fn(tx));
    await this.prisma.$transaction((t) => withSystemAccess(t, () => fn(t)));
  }
}

/**
 * Runs the PostgreSQL half of a change after its MongoDB half has committed. If the
 * PostgreSQL half fails, `undo` reverses the MongoDB half, so neither database keeps a change
 * the other refused. Only for the transition; it goes away with PostgreSQL.
 */
export async function thenInPostgres<T>(mongoResult: T, postgres: () => Promise<void>, undo: () => Promise<void>): Promise<T> {
  try {
    await postgres();
    return mongoResult;
  } catch (e) {
    try {
      await undo();
    } catch (undoError) {
      new Logger('PostgresMirror').error(`Could not undo the MongoDB half of a change after PostgreSQL refused it: ${String(undoError)}`);
    }
    throw e;
  }
}

/**
 * A PostgreSQL transaction that makes MongoDB changes part-way through, for work that must
 * hold PostgreSQL row locks while MongoDB changes (locking a period waits for postings in
 * progress). Each MongoDB change registers how to reverse it with `undoLater`; if the
 * PostgreSQL transaction fails, the reversals run, newest first. Only for the transition.
 */
export async function postgresWithMongo<T>(
  prisma: PrismaService,
  fn: (tx: Tx, undoLater: (undo: () => Promise<unknown>) => void) => Promise<T>,
  opts?: { timeout?: number },
): Promise<T> {
  const undos: (() => Promise<unknown>)[] = [];
  try {
    return await prisma.$transaction((tx) => fn(tx, (u) => void undos.push(u)), opts);
  } catch (e) {
    for (const undo of undos.reverse()) {
      try {
        await undo();
      } catch (undoError) {
        new Logger('PostgresMirror').error(`Could not undo a MongoDB change after PostgreSQL refused it: ${String(undoError)}`);
      }
    }
    throw e;
  }
}
