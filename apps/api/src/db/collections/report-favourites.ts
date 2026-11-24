import { defineCollection } from '@talk2tax/document-db';

/** Reports a person pinned to the top of their reporting studio (RPT-001). One per person and report. */
export interface ReportFavouriteDoc {
  id: string;
  orgId: string;
  userId: string;
  report: string;
  createdAt: Date;
}

export const reportFavourites = defineCollection<ReportFavouriteDoc>({
  name: 'report_favourites',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'userId', 'report', 'createdAt'],
    properties: {
      userId: { bsonType: 'string' },
      report: { bsonType: 'string', pattern: '^[a-z-]{1,40}$' },
      createdAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, userId: 1, report: 1 }, name: 'org_user_report', unique: true }],
});
