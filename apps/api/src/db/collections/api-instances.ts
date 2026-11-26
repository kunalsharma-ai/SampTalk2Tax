import { defineCollection } from '@talk2tax/document-db';

/**
 * Horizontal scaling (PERF-008): each API server says it is running here every
 * API_INSTANCE_HEARTBEAT_SECONDS, so System health can list every server, not only the one
 * answering. A server removes its row when it stops; a row not seen for a day is removed by the
 * database (TTL). Platform-wide; no organisation data.
 */
export interface ApiInstanceDoc {
  id: string;
  host: string;
  pid: number;
  version: string;
  commit: string | null;
  region: string;
  rateLimitStore: 'memory' | 'database';
  startedAt: Date;
  lastSeenAt: Date;
}

export const apiInstances = defineCollection<ApiInstanceDoc>({
  name: 'api_instances',
  scope: 'global',
  schema: {
    bsonType: 'object',
    required: ['host', 'pid', 'version', 'region', 'rateLimitStore', 'startedAt', 'lastSeenAt'],
    properties: {
      host: { bsonType: 'string', maxLength: 255 },
      pid: { bsonType: ['int', 'long'] },
      version: { bsonType: 'string', maxLength: 50 },
      commit: { bsonType: ['string', 'null'], maxLength: 64 },
      region: { bsonType: 'string', maxLength: 40 },
      rateLimitStore: { enum: ['memory', 'database'] },
      startedAt: { bsonType: 'date' },
      lastSeenAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { lastSeenAt: 1 }, name: 'last_seen', expireAfterSeconds: 86_400 }],
});
