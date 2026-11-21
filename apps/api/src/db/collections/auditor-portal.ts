import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * External auditor portal links (AUDIT-002): a private, read-only link to one internal audit
 * engagement for a named external auditor. Only the SHA-256 of the secret is stored. A link
 * always expires; once withdrawn it stays withdrawn; links are kept as a record.
 */
export interface AuditorPortalLinkDoc {
  id: string;
  orgId: string;
  engagementId: string;
  auditorName: string;
  firm: string | null;
  prefix: string;
  tokenHash: string;
  expiresAt: Date;
  createdById: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedById: string | null;
  lastSeenAt: Date | null;
  viewCount: number;
  filesOpened: number;
}

const FIXED = ['engagementId', 'auditorName', 'firm', 'prefix', 'tokenHash', 'expiresAt', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const auditorPortalLinks = defineCollection<AuditorPortalLinkDoc>({
  name: 'auditor_portal_links',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'engagementId', 'auditorName', 'prefix', 'tokenHash', 'expiresAt', 'createdById', 'createdAt', 'viewCount', 'filesOpened'],
    properties: {
      auditorName: { bsonType: 'string', minLength: 1, maxLength: 120 },
      firm: { bsonType: ['string', 'null'], maxLength: 120 },
      prefix: { bsonType: 'string', minLength: 8, maxLength: 8 },
      tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      expiresAt: { bsonType: 'date' },
      viewCount: { bsonType: ['int', 'long'], minimum: 0 },
      filesOpened: { bsonType: ['int', 'long'], minimum: 0 },
    },
  },
  indexes: [
    // Looked up by the token's hash across organisations, so unique on its own.
    { key: { tokenHash: 1 }, name: 'one_token', unique: true },
    { key: { orgId: 1, engagementId: 1 }, name: 'by_engagement' },
  ],
  guards: {
    afterUpdate(before, after) {
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('An auditor link keeps who it is for, what it opens and when it ends');
      if (before.revokedAt && (!same(before.revokedAt, after.revokedAt) || before.revokedById !== after.revokedById)) throw new GuardViolation('A withdrawn auditor link stays withdrawn');
      if (after.viewCount < before.viewCount || after.filesOpened < before.filesOpened) throw new GuardViolation('Auditor link counts only go up');
    },
    beforeDelete() {
      throw new GuardViolation('Auditor links are kept as a record');
    },
  },
});
