import type { AnyCollectionDef } from './collection';

/**
 * Partitioning readiness (PERF-009). MongoDB splits a collection across shards by a shard key,
 * and the natural key for Talk2Tax is the organisation (orgId): every query of a tenant
 * collection carries it, so each request would reach one shard. MongoDB only lets a sharded
 * collection keep a unique index when the index starts with the shard key; any other unique
 * index blocks sharding until it is changed. This reads the collection definitions and says,
 * for each collection, whether it could be sharded by organisation today.
 */
export type ShardState =
  /** Tenant collection whose unique indexes all start with orgId: can be sharded by organisation as it is. */
  | 'READY'
  /** Unique within the organisation's own rows (keyed by ids of its other rows): orgId can lead the index without changing what is unique. */
  | 'NEEDS_ORG_PREFIX'
  /** Looked up without the organisation (tokens, key hashes, gateway references): stays unsharded, or moves the lookup to a small unsharded collection. */
  | 'GLOBAL_LOOKUP'
  /** Shared collection (users, plans, platform settings): not split by organisation. */
  | 'GLOBAL';

export interface ShardBlocker {
  index: string;
  key: string[];
  partial: boolean;
  kind: 'NEEDS_ORG_PREFIX' | 'GLOBAL_LOOKUP';
}

export interface CollectionShardReadiness {
  name: string;
  scope: 'tenant' | 'global';
  state: ShardState;
  blockers: ShardBlocker[];
}

/** A field naming another row by its id (documentId, lines.id): unique per organisation already, because ids are never reused across organisations. */
const isIdField = (field: string) => /(^|\.)id$|Id$/.test(field);

/** How one collection stands against sharding by { orgId: 1 }. */
export function collectionShardReadiness(def: AnyCollectionDef): CollectionShardReadiness {
  if (def.scope === 'global') return { name: def.name, scope: 'global', state: 'GLOBAL', blockers: [] };
  const blockers: ShardBlocker[] = [];
  for (const index of def.indexes ?? []) {
    if (!index.unique) continue;
    const key = Object.keys(index.key);
    if (key[0] === 'orgId') continue;
    blockers.push({
      index: index.name ?? key.join('_'),
      key,
      partial: Boolean(index.partialFilterExpression),
      kind: key.some((f) => f !== 'orgId' && isIdField(f)) ? 'NEEDS_ORG_PREFIX' : 'GLOBAL_LOOKUP',
    });
  }
  const state: ShardState = blockers.some((b) => b.kind === 'GLOBAL_LOOKUP') ? 'GLOBAL_LOOKUP' : blockers.length ? 'NEEDS_ORG_PREFIX' : 'READY';
  return { name: def.name, scope: 'tenant', state, blockers };
}

export interface ShardReadinessSummary {
  collections: CollectionShardReadiness[];
  counts: Record<ShardState, number>;
}

/** Every collection's readiness, sorted by name, with a count per state. */
export function shardReadiness(defs: readonly AnyCollectionDef[]): ShardReadinessSummary {
  const collections = defs.map(collectionShardReadiness).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const counts: Record<ShardState, number> = { READY: 0, NEEDS_ORG_PREFIX: 0, GLOBAL_LOOKUP: 0, GLOBAL: 0 };
  for (const c of collections) counts[c.state] += 1;
  return { collections, counts };
}

export interface PartitioningThresholds {
  /** Review partitioning when the database (data plus indexes) reaches this size. */
  databaseBytes: number;
  /** Review partitioning when one collection (data plus indexes) reaches this size. */
  collectionBytes: number;
}

export interface CollectionSize {
  name: string;
  documents: number;
  bytes: number;
}

export interface PartitioningAdvice {
  justified: boolean;
  reasons: string[];
  databaseShare: number;
  largestShare: number;
}

const GB = 1024 ** 3;
const size = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/**
 * Whether splitting the database is justified now: only when the database or one collection
 * has grown past the size one replica set is set to carry. Shares are how far along (0..1+).
 */
export function partitioningAdvice(databaseBytes: number, largest: readonly CollectionSize[], t: PartitioningThresholds): PartitioningAdvice {
  if (!(t.databaseBytes > 0) || !(t.collectionBytes > 0)) throw new Error('Partitioning thresholds must be above zero');
  const reasons: string[] = [];
  if (databaseBytes >= t.databaseBytes) reasons.push(`The database holds ${size(databaseBytes)}, past the ${size(t.databaseBytes)} set for one replica set`);
  const top = largest.reduce<CollectionSize | null>((m, c) => (!m || c.bytes > m.bytes ? c : m), null);
  for (const c of largest) if (c.bytes >= t.collectionBytes) reasons.push(`${c.name} holds ${size(c.bytes)}, past the ${size(t.collectionBytes)} set for one collection`);
  return {
    justified: reasons.length > 0,
    reasons,
    databaseShare: Math.round((databaseBytes / t.databaseBytes) * 10000) / 10000,
    largestShare: top ? Math.round((top.bytes / t.collectionBytes) * 10000) / 10000 : 0,
  };
}
