import { mirrorClient, mirrorRowsWhere, POSTGRES_OFF, useLockStore } from '../db/mirror-writes';
import '../db/readable-models';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Provider } from '@nestjs/common';
import { PrismaClient } from '@talk2tax/database';
import { isTransientTransactionError, type DocumentStore } from '@talk2tax/document-db';
import { useCounterStore } from '../db/counters';
import { DocumentStoreService } from './document-store.service';
import { currentTenantContext, TenantContext, tenantStorage } from './tenant-context';

/**
 * The application's database client. Its type is the plain Prisma client; at runtime it is
 * wrapped (see createTenantAwarePrisma) so that every statement runs with the tenant
 * settings that PostgreSQL row-level security policies read.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

function settings(ctx: TenantContext): [string, string, string] {
  return [ctx.orgId ?? '', ctx.userId ?? '', ctx.bypass ? 'on' : ''];
}

/**
 * Wraps a Prisma client so that:
 *  - a statement outside a transaction runs in a two-statement batch transaction that first
 *    sets t2t.org_id / t2t.user_id / t2t.bypass (transaction-local, so pooled connections
 *    never carry one tenant's settings into another's work);
 *  - an interactive transaction sets them once, at its start.
 * A statement issued on the root client from inside a transaction callback (instead of on
 * `tx`) is not given settings, so it sees no tenant rows: that bug fails closed.
 */
/** Runs of a transaction callback before a MongoDB write conflict is given up on. */
const MAX_ATTEMPTS = 40;

export function createTenantAwarePrisma(base: PrismaService, store?: Pick<DocumentStore, 'hold' | 'collection'>): PrismaService {
  const apply = (ctx: TenantContext) => {
    const [org, user, bypass] = settings(ctx);
    return base.$executeRaw`SELECT set_config('t2t.org_id', ${org}, true), set_config('t2t.user_id', ${user}, true), set_config('t2t.bypass', ${bypass}, true)`;
  };
  const extended = base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const ctx = currentTenantContext();
        if (ctx.inTx) return query(args);
        const [, result] = await base.$transaction([apply(ctx), query(args) as never]);
        return result;
      },
    },
  });

  const runOnce = (arg: unknown, options: unknown, ctx: TenantContext) =>
    (extended.$transaction as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
      (tx) =>
        tenantStorage.run({ ...ctx, inTx: true }, async () => {
          const [org, user, bypass] = settings(ctx);
          await (tx as Tx).$executeRaw`SELECT set_config('t2t.org_id', ${org}, true), set_config('t2t.user_id', ${user}, true), set_config('t2t.bypass', ${bypass}, true)`;
          // Writes to tables kept in step also go to MongoDB (db/mirror-writes.ts).
          return (arg as (tx: unknown) => Promise<unknown>)(store ? mirrorClient(tx as object, store) : tx);
        }),
      options,
    );

  /**
   * While both databases run (docs/MONGODB.md), each PostgreSQL transaction owns a MongoDB
   * transaction: MongoDB work done inside the callback joins it, and it commits right after
   * PostgreSQL commits (or is abandoned if PostgreSQL fails). A MongoDB write conflict runs
   * the whole callback again, as the MongoDB driver does for its own transactions.
   */
  const transaction = async (arg: unknown, options?: unknown) => {
    if (typeof arg !== 'function') throw new Error('Batch transactions are not supported; use an interactive transaction');
    const ctx = currentTenantContext();
    if (!store) return runOnce(arg, options, ctx);
    for (let attempt = 1; ; attempt++) {
      const held = store.hold();
      let result: unknown;
      try {
        result = await held.run(() => runOnce(arg, options, ctx));
      } catch (e) {
        await held.abort().catch(() => undefined);
        // Concurrent postings meet on the same counter or lock document; each conflict waits a
        // little (growing, with jitter) and runs again, as MongoDB's own retry loop does.
        if (attempt < MAX_ATTEMPTS && isTransientTransactionError(e)) {
          await new Promise((r) => setTimeout(r, Math.random() * Math.min(5 * 2 ** attempt, 200)));
          continue;
        }
        throw e;
      }
      try {
        await held.commit();
      } catch (e) {
        new Logger('Database').error(`PostgreSQL committed but MongoDB did not; run db:copy-to-mongo to repair the copy: ${String(e)}`);
        throw e;
      }
      return result;
    }
  };

  const outer = store ? mirrorClient(extended as object, store, (fn) => transaction(fn)) : (extended as object);
  return new Proxy(outer, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return transaction;
      if (prop === '$mirrorRows') return (model: string, where: Record<string, unknown>) => (store ? transaction((tx: unknown) => mirrorRowsWhere(tx, store, model, where)) : Promise.resolve());
      if (prop === 'onModuleInit') return () => connectAndCheckRole(base);
      if (prop === 'onModuleDestroy') return () => base.$disconnect();
      return Reflect.get(target, prop, receiver);
    },
  }) as PrismaService;
}

/**
 * Copies rows that raw SQL changed (outside the Prisma model API) into MongoDB
 * (db/mirror-writes.ts). Inside a transaction, use mirrorRowsWhere with the transaction.
 */
export function mirrorRows(prisma: PrismaService, model: string, where: Record<string, unknown>): Promise<unknown> {
  // With PostgreSQL off there is nothing to copy: the write went to MongoDB.
  if (POSTGRES_OFF()) return Promise.resolve();
  return (prisma as unknown as { $mirrorRows(m: string, w: Record<string, unknown>): Promise<unknown> }).$mirrorRows(model, where);
}

/**
 * Points an open transaction at one organisation. Only for creating a new organisation,
 * whose id does not exist yet when the request's context is set.
 */
export async function useOrgInTx(tx: Tx, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('t2t.org_id', ${orgId}, true)`;
  // MongoDB reads in this transaction follow it to the same organisation.
  const ctx = tenantStorage.getStore();
  if (ctx?.inTx) ctx.orgId = orgId;
}

/**
 * Lets one transaction cross tenants for system bookkeeping (the global audit chain), then
 * turns it off again. Never wrap request-driven reads or writes of tenant data in this.
 */
export async function withSystemAccess<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  // Restores what the transaction had before, so a nested call leaves an outer bypass on.
  const [{ before }] = await tx.$queryRaw<{ before: string | null }[]>`SELECT current_setting('t2t.bypass', true) AS before`;
  await tx.$executeRaw`SELECT set_config('t2t.bypass', 'on', true)`;
  // No reset when fn fails: the transaction is aborted and rolls back, bypass and all, and a
  // reset would fail too and hide what went wrong.
  // MongoDB reads see what the PostgreSQL bypass lets this work see: every organisation.
  const out = await tenantStorage.run({ ...currentTenantContext(), bypass: true }, fn);
  const ctx = currentTenantContext();
  await tx.$executeRaw`SELECT set_config('t2t.bypass', ${before === 'on' || ctx.bypass ? 'on' : ''}, true)`;
  return out;
}

/**
 * A superuser or BYPASSRLS role ignores row-level security entirely. Refuse to start in
 * production with such a role; warn elsewhere.
 */
async function connectAndCheckRole(base: PrismaService): Promise<void> {
  await base.$connect();
  const [role] = await base.$queryRaw<{ name: string; superuser: boolean; bypass: boolean }[]>`
    SELECT rolname AS name, rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (role && (role.superuser || role.bypass)) {
    const message = `Database role "${role.name}" is a superuser or has BYPASSRLS, so row-level security does not apply. Connect as an ordinary role.`;
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    new Logger('Database').warn(message);
  }
}

export const prismaProvider: Provider = {
  provide: PrismaService,
  inject: [DocumentStoreService],
  useFactory: (store: DocumentStoreService) => {
    useCounterStore(store);
    useLockStore(store);
    return createTenantAwarePrisma(new PrismaService(), store);
  },
};
