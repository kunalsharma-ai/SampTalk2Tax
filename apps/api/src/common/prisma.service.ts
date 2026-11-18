import { useLockStore } from '../db/mirror-writes';
import '../db/readable-models';
import { createDataClient } from '../db/data-client';
import { Provider } from '@nestjs/common';
import type { PrismaClient } from '@talk2tax/database';
import { useCounterStore } from '../db/counters';
import { DocumentStoreService } from './document-store.service';
import { currentTenantContext, tenantStorage } from './tenant-context';

/**
 * The application's database client (db/data-client.ts), on MongoDB alone. Its type is the
 * model API of the Prisma schema, which the services were written against and which the schema
 * still generates as types only; no Prisma query engine or SQL database runs.
 */
export abstract class PrismaService {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface PrismaService extends Omit<PrismaClient, '$on' | '$extends' | '$use'> {}

export type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * Points an open transaction at one organisation. Only for creating a new organisation,
 * whose id does not exist yet when the request's context is set.
 */
export async function useOrgInTx(_tx: Tx, orgId: string): Promise<void> {
  // Reads and writes in this transaction follow it to the same organisation.
  const ctx = tenantStorage.getStore();
  if (ctx?.inTx) ctx.orgId = orgId;
}

/**
 * Lets one transaction cross tenants for system bookkeeping (the global audit chain). Never
 * wrap request-driven reads or writes of tenant data in this.
 */
export async function withSystemAccess<T>(_tx: Tx, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ ...currentTenantContext(), bypass: true }, fn);
}

export const prismaProvider: Provider = {
  provide: PrismaService,
  inject: [DocumentStoreService],
  useFactory: (store: DocumentStoreService) => {
    useCounterStore(store);
    useLockStore(store);
    return createDataClient(store) as PrismaService;
  },
};
