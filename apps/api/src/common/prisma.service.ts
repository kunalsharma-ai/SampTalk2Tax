import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Provider } from '@nestjs/common';
import { PrismaClient } from '@talk2tax/database';
import { isTransientTransactionError, type DocumentStore } from '@talk2tax/document-db';
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
export function createTenantAwarePrisma(base: PrismaService, store?: Pick<DocumentStore, 'hold'>): PrismaService {
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
          return (arg as (tx: unknown) => Promise<unknown>)(tx);
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
        if (attempt < 5 && isTransientTransactionError(e)) continue;
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

  return new Proxy(extended as object, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return transaction;
      if (prop === 'onModuleInit') return () => connectAndCheckRole(base);
      if (prop === 'onModuleDestroy') return () => base.$disconnect();
      return Reflect.get(target, prop, receiver);
    },
  }) as PrismaService;
}

/**
 * Points an open transaction at one organisation. Only for creating a new organisation,
 * whose id does not exist yet when the request's context is set.
 */
export async function useOrgInTx(tx: Tx, orgId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config('t2t.org_id', ${orgId}, true)`;
}

/**
 * Lets one transaction cross tenants for system bookkeeping (the global audit chain), then
 * turns it off again. Never wrap request-driven reads or writes of tenant data in this.
 */
export async function withSystemAccess<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  // Restores what the transaction had before, so a nested call leaves an outer bypass on.
  const [{ before }] = await tx.$queryRaw<{ before: string | null }[]>`SELECT current_setting('t2t.bypass', true) AS before`;
  await tx.$executeRaw`SELECT set_config('t2t.bypass', 'on', true)`;
  try {
    return await fn();
  } finally {
    const ctx = currentTenantContext();
    await tx.$executeRaw`SELECT set_config('t2t.bypass', ${before === 'on' || ctx.bypass ? 'on' : ''}, true)`;
  }
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
  useFactory: (store: DocumentStoreService) => createTenantAwarePrisma(new PrismaService(), store),
};
