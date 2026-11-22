import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Executive and investor reports (RPT-022, RPT-023): one per audience and fiscal quarter or year,
 * with the narrative written for it. While a draft its figures are worked out from the books each
 * time it is read; finalising freezes the figures and the narrative, and a final report is never
 * changed or deleted.
 */
export interface StakeholderNarrative {
  highlights: string;
  challenges: string;
  outlook: string;
  /** Decisions needed (executive) or asks of investors (investor). */
  asks: string;
}

export interface StakeholderReportDoc {
  id: string;
  orgId: string;
  audience: 'EXECUTIVE' | 'INVESTOR';
  /** "FY2027" or "FY2027-Q2". */
  period: string;
  status: 'DRAFT' | 'FINAL';
  narrative: StakeholderNarrative;
  snapshot: Record<string, unknown> | null;
  createdById: string;
  createdAt: Date;
  updatedById: string;
  updatedAt: Date;
  finalisedById: string | null;
  finalisedAt: Date | null;
}

const TEXT = { bsonType: 'string', maxLength: 5000 };

export const stakeholderReports = defineCollection<StakeholderReportDoc>({
  name: 'stakeholder_reports',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'audience', 'period', 'status', 'narrative', 'createdById', 'createdAt', 'updatedById', 'updatedAt'],
    properties: {
      audience: { enum: ['EXECUTIVE', 'INVESTOR'] },
      period: { bsonType: 'string', pattern: '^FY\\d{4}(-Q[1-4])?$' },
      status: { enum: ['DRAFT', 'FINAL'] },
      narrative: { bsonType: 'object', required: ['highlights', 'challenges', 'outlook', 'asks'], properties: { highlights: TEXT, challenges: TEXT, outlook: TEXT, asks: TEXT } },
      snapshot: { bsonType: ['object', 'null'] },
    },
  },
  indexes: [{ key: { orgId: 1, audience: 1, period: 1 }, name: 'one_report_a_period', unique: true }],
  guards: {
    beforeInsert(r) {
      if (r.status !== 'DRAFT' || r.snapshot) throw new GuardViolation('A report starts as a draft');
    },
    afterUpdate(before, after) {
      if (before.status === 'FINAL') throw new GuardViolation('A final report is kept as it was');
      if (before.audience !== after.audience || before.period !== after.period) throw new GuardViolation('A report keeps its audience and period');
      if (after.status === 'FINAL' && (!after.snapshot || !after.finalisedById || !after.finalisedAt)) throw new GuardViolation('A report is finalised with its figures, who and when');
    },
    beforeDelete() {
      throw new GuardViolation('Executive and investor reports are kept as a record');
    },
  },
});
