import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Report design version history (RPT-039): every saved version of a report design's name,
 * description and layout, kept as it was saved. Versions are never changed or deleted, so the
 * history stays a record even after a design is deleted.
 */
export interface ReportDesignVersionDoc {
  id: string;
  orgId: string;
  designId: string;
  version: number;
  name: string;
  description: string | null;
  layout: Record<string, unknown>;
  /** How this version came about. */
  change: 'CREATED' | 'EDITED' | 'RESTORED' | 'FROM_TEMPLATE';
  /** RESTORED: the version restored. FROM_TEMPLATE: null. */
  restoredFrom: number | null;
  templateId: string | null;
  savedById: string;
  savedAt: Date;
}

export const reportDesignVersions = defineCollection<ReportDesignVersionDoc>({
  name: 'report_design_versions',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'designId', 'version', 'name', 'layout', 'change', 'savedById', 'savedAt'],
    properties: {
      designId: { bsonType: 'string' },
      version: { bsonType: 'int', minimum: 1 },
      name: { bsonType: 'string', maxLength: 120 },
      layout: { bsonType: 'object' },
      change: { enum: ['CREATED', 'EDITED', 'RESTORED', 'FROM_TEMPLATE'] },
      savedAt: { bsonType: 'date' },
    },
  },
  indexes: [{ key: { orgId: 1, designId: 1, version: 1 }, name: 'one_per_version', unique: true }],
  guards: {
    afterUpdate() {
      throw new GuardViolation('A saved version of a report design is kept as it was saved');
    },
    beforeDelete() {
      throw new GuardViolation('Report design versions are kept as a record');
    },
  },
});
