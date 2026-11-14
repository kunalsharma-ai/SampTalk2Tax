import { Injectable, Logger } from '@nestjs/common';
import { DocumentStoreService } from '../common/document-store.service';
import { PrismaService, Tx, withSystemAccess } from '../common/prisma.service';
import { runAsSystem } from '../common/tenant-context';
import { users } from './collections/identity';
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

  /** Copies these organisations into PostgreSQL `organizations`. */
  async organizations(ids: readonly string[], tx?: Tx): Promise<void> {
    if (!ids.length) return;
    const rows = await this.store.collection(organizations).find({ id: { $in: [...new Set(ids)] } });
    await this.inPostgres(tx, async (t) => {
      for (const { id, ownerChanges: _ignored, ...o } of rows) {
        await t.organization.upsert({ where: { id }, create: { id, ...o }, update: o });
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
