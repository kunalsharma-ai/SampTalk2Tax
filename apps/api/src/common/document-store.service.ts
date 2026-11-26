import { Injectable, OnModuleDestroy, OnModuleInit, Provider } from '@nestjs/common';
import { DocumentStore } from '@talk2tax/document-db';
import { AppConfig, CONFIG } from '../config';
import { COLLECTIONS } from '../db/collections';
import { currentTenantContext } from './tenant-context';

/**
 * The API's MongoDB store. Tenant collections are scoped by the same request context the
 * auth guard fills in (organisation after the membership check, or system bypass), so a
 * query that escapes its request sees nothing and is refused. See docs/MONGODB.md.
 */
@Injectable()
export class DocumentStoreService extends DocumentStore implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/**
 * What the read cache may hold (PERF-010): the membership, organisation, plan and sign-in rules
 * the auth guard reads on every request. See docs/READ_CACHE.md.
 */
export const READ_CACHE_COLLECTIONS = ['memberships', 'organizations', 'subscriptions', 'plans', 'org_security_settings', 'user_mfa', 'access_rules'] as const;

export const documentStoreProvider: Provider = {
  provide: DocumentStoreService,
  inject: [CONFIG],
  useFactory: (config: AppConfig) =>
    new DocumentStoreService({
      url: config.MONGODB_URL,
      collections: COLLECTIONS,
      cache: config.READ_CACHE === 'on' ? { collections: READ_CACHE_COLLECTIONS } : undefined,
      context: () => {
        const ctx = currentTenantContext();
        return { orgId: ctx.orgId, bypass: ctx.bypass };
      },
    }),
};
