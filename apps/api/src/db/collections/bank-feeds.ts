import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Bank feeds (BANK-004). A connection lets one sender post transactions or statement files for
 * one bank account with a secret token; only the token's SHA-256 is stored. At most one live
 * (active or paused) connection per account, so two feeds never add the same money twice. Once
 * disconnected, a connection stays disconnected. Connections and deliveries are kept as a record.
 */
export interface BankFeedConnectionDoc {
  id: string;
  orgId: string;
  accountId: string;
  name: string;
  kind: 'TRANSACTIONS' | 'STATEMENT_FILE';
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED';
  /** True while active or paused: the unique index keeps one per account. */
  live: boolean;
  prefix: string;
  tokenHash: string;
  expectEveryHours: number;
  createdById: string;
  createdAt: Date;
  tokenIssuedAt: Date;
  revokedAt: Date | null;
  revokedById: string | null;
  lastDeliveryAt: Date | null;
  lastOutcome: 'IMPORTED' | 'NOTHING_NEW' | 'REJECTED' | 'FAILED' | null;
  lastAcceptedAt: Date | null;
  deliveryCount: number;
  linesImported: number;
}

const FIXED = ['accountId', 'kind', 'createdById', 'createdAt'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const bankFeedConnections = defineCollection<BankFeedConnectionDoc>({
  name: 'bank_feed_connections',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'accountId', 'name', 'kind', 'status', 'live', 'prefix', 'tokenHash', 'expectEveryHours', 'createdById', 'createdAt', 'tokenIssuedAt', 'deliveryCount', 'linesImported'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 80 },
      kind: { enum: ['TRANSACTIONS', 'STATEMENT_FILE'] },
      status: { enum: ['ACTIVE', 'PAUSED', 'REVOKED'] },
      live: { bsonType: 'bool' },
      prefix: { bsonType: 'string', minLength: 8, maxLength: 8 },
      tokenHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      expectEveryHours: { bsonType: ['int', 'long'], minimum: 1, maximum: 168 },
      lastOutcome: { enum: ['IMPORTED', 'NOTHING_NEW', 'REJECTED', 'FAILED', null] },
      deliveryCount: { bsonType: ['int', 'long'], minimum: 0 },
      linesImported: { bsonType: ['int', 'long'], minimum: 0 },
    },
  },
  indexes: [
    // Looked up by the token's hash across organisations, so unique on its own.
    { key: { tokenHash: 1 }, name: 'one_token', unique: true },
    { key: { orgId: 1, accountId: 1 }, name: 'one_live_feed_per_account', unique: true, partialFilterExpression: { live: true } },
  ],
  guards: {
    beforeInsert(c) {
      if (c.live !== (c.status !== 'REVOKED')) throw new GuardViolation('A feed is live exactly while it is not disconnected');
    },
    afterUpdate(before, after) {
      for (const k of FIXED) if (!same(before[k], after[k])) throw new GuardViolation('A bank feed keeps its account, kind and who set it up');
      if (after.live !== (after.status !== 'REVOKED')) throw new GuardViolation('A feed is live exactly while it is not disconnected');
      if (before.status === 'REVOKED' && (after.status !== 'REVOKED' || after.tokenHash !== before.tokenHash)) throw new GuardViolation('A disconnected bank feed stays disconnected');
      if (after.deliveryCount < before.deliveryCount || after.linesImported < before.linesImported) throw new GuardViolation('Bank feed counts only go up');
    },
    beforeDelete() {
      throw new GuardViolation('Bank feeds are kept as a record');
    },
  },
});

export interface BankFeedDeliveryDoc {
  id: string;
  orgId: string;
  connectionId: string;
  accountId: string;
  receivedAt: Date;
  outcome: 'IMPORTED' | 'NOTHING_NEW' | 'REJECTED' | 'FAILED';
  /** For a statement file, its name; for transactions, null. */
  fileName: string | null;
  payloadHash: string;
  received: number;
  imported: number;
  duplicates: number;
  rejected: number;
  /** The first 50 refusals, with reasons. */
  rejections: { position: number; id: string | null; reasons: string[] }[];
  importId: string | null;
  /** Why a whole delivery failed (a file that could not be read). */
  error: string | null;
}

export const bankFeedDeliveries = defineCollection<BankFeedDeliveryDoc>({
  name: 'bank_feed_deliveries',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'connectionId', 'accountId', 'receivedAt', 'outcome', 'payloadHash', 'received', 'imported', 'duplicates', 'rejected', 'rejections'],
    properties: {
      outcome: { enum: ['IMPORTED', 'NOTHING_NEW', 'REJECTED', 'FAILED'] },
      payloadHash: { bsonType: 'string', pattern: '^[0-9a-f]{64}$' },
      received: { bsonType: ['int', 'long'], minimum: 0 },
      imported: { bsonType: ['int', 'long'], minimum: 0 },
      duplicates: { bsonType: ['int', 'long'], minimum: 0 },
      rejected: { bsonType: ['int', 'long'], minimum: 0 },
      rejections: { bsonType: 'array', maxItems: 50 },
    },
  },
  indexes: [{ key: { orgId: 1, connectionId: 1, receivedAt: -1 }, name: 'by_connection' }],
  guards: {
    beforeInsert(d) {
      if (d.imported + d.duplicates + d.rejected !== d.received) throw new GuardViolation('A delivery accounts for everything it received');
    },
    afterUpdate() {
      throw new GuardViolation('A bank feed delivery is kept as it was received');
    },
    beforeDelete() {
      throw new GuardViolation('Bank feed deliveries are kept as a record');
    },
  },
});
