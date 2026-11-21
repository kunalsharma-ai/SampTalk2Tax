import { defineCollection } from '@talk2tax/document-db';

/**
 * Saved report views (RPT-028, RPT-029, RPT-037): a report and its filters under a name, kept
 * for the person who saved it or shared with everyone in the organisation who can read reports.
 */
export interface ReportViewDoc {
  id: string;
  orgId: string;
  name: string;
  report: string;
  /** Dates (a period relative to the day it is opened, or fixed dates) and the report's filters. */
  filters: Record<string, unknown>;
  shared: boolean;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  updatedById: string;
}

export const reportViews = defineCollection<ReportViewDoc>({
  name: 'report_views',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'report', 'filters', 'shared', 'ownerId', 'createdAt', 'updatedAt', 'updatedById'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 80 },
      report: { bsonType: 'string', maxLength: 40 },
      filters: { bsonType: 'object' },
      shared: { bsonType: 'bool' },
      ownerId: { bsonType: 'string' },
    },
  },
  indexes: [{ key: { orgId: 1, report: 1, ownerId: 1 }, name: 'by_report_owner' }],
});
