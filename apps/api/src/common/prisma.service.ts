import { Injectable, OnModuleDestroy, OnModuleInit, Provider } from '@nestjs/common';
import { PrismaClient } from '@talk2tax/database';
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
export function createTenantAwarePrisma(base: PrismaService): PrismaService {
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

  const transaction = (arg: unknown, options?: unknown) => {
    if (typeof arg !== 'function') throw new Error('Batch transactions are not supported; use an interactive transaction');
    const ctx = currentTenantContext();
    return (extended.$transaction as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
      (tx) =>
        tenantStorage.run({ ...ctx, inTx: true }, async () => {
          const [org, user, bypass] = settings(ctx);
          await (tx as Tx).$executeRaw`SELECT set_config('t2t.org_id', ${org}, true), set_config('t2t.user_id', ${user}, true), set_config('t2t.bypass', ${bypass}, true)`;
          return (arg as (tx: unknown) => Promise<unknown>)(tx);
        }),
      options,
    );
  };

  return new Proxy(extended as object, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return transaction;
      if (prop === 'onModuleInit') return () => base.$connect();
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
  await tx.$executeRaw`SELECT set_config('t2t.bypass', 'on', true)`;
  try {
    return await fn();
  } finally {
    const ctx = currentTenantContext();
    await tx.$executeRaw`SELECT set_config('t2t.bypass', ${ctx.bypass ? 'on' : ''}, true)`;
  }
}

export const prismaProvider: Provider = {
  provide: PrismaService,
  useFactory: () => createTenantAwarePrisma(new PrismaService()),
};
