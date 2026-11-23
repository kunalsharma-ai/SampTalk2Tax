import { defineCollection } from '@talk2tax/document-db';

/**
 * Risk monitor readings (DASH-036): the organisation's risk score and each area's score and
 * findings, one per day, kept so the monitor can show how risk moves over time. Rewritten while
 * the day lasts; earlier days are kept as they were read.
 */
export interface RiskReadingDoc {
  id: string;
  orgId: string;
  /** The business day of the reading, YYYY-MM-DD. */
  date: string;
  score: number;
  level: string;
  areas: { area: string; score: number; high: number; medium: number; low: number; active: boolean }[];
  takenAt: Date;
}

export const riskReadings = defineCollection<RiskReadingDoc>({
  name: 'risk_readings',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'date', 'score', 'level', 'areas', 'takenAt'],
    properties: {
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      score: { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: 100 },
      level: { enum: ['CLEAR', 'LOW', 'ELEVATED', 'HIGH', 'SEVERE'] },
      areas: {
        bsonType: 'array',
        maxItems: 20,
        items: {
          bsonType: 'object',
          required: ['area', 'score', 'high', 'medium', 'low', 'active'],
          properties: {
            area: { bsonType: 'string', pattern: '^[A-Z_]+$' },
            score: { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: 100 },
            high: { bsonType: ['int', 'long'], minimum: 0 },
            medium: { bsonType: ['int', 'long'], minimum: 0 },
            low: { bsonType: ['int', 'long'], minimum: 0 },
            active: { bsonType: 'bool' },
          },
        },
      },
      takenAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, date: 1 }, name: 'org_date', unique: true }],
});
