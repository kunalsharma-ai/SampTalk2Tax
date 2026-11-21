import { defineCollection, GuardViolation } from '@talk2tax/document-db';

/**
 * Scheduled reports (RPT-031, RPT-032): a report emailed to members on a weekly or monthly
 * day. Each delivery is a run; a run is claimed by inserting it first (one per schedule and
 * slot), so two API processes never send the same report twice.
 */
export interface ReportScheduleDoc {
  id: string;
  orgId: string;
  name: string;
  report: string;
  format: string;
  period: string;
  frequency: 'WEEKLY' | 'MONTHLY';
  weekday: number | null;
  dayOfMonth: number | null;
  recipientIds: string[];
  isActive: boolean;
  nextRunOn: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportScheduleRunDoc {
  id: string;
  orgId: string;
  scheduleId: string;
  /** The run date for a scheduled run, or "manual:<id>" for one sent on request. */
  slot: string;
  runOn: string;
  status: 'SENDING' | 'SENT' | 'FAILED';
  params: Record<string, string>;
  recipients: string[];
  fileName: string | null;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  requestedById: string | null;
}

export const reportSchedules = defineCollection<ReportScheduleDoc>({
  name: 'report_schedules',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'name', 'report', 'format', 'period', 'frequency', 'recipientIds', 'isActive', 'nextRunOn', 'createdById', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 80 },
      frequency: { enum: ['WEEKLY', 'MONTHLY'] },
      recipientIds: { bsonType: 'array', minItems: 1, maxItems: 10, items: { bsonType: 'string' } },
      isActive: { bsonType: 'bool' },
      nextRunOn: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    },
  },
  indexes: [{ key: { isActive: 1, nextRunOn: 1 }, name: 'due' }],
});

export const reportScheduleRuns = defineCollection<ReportScheduleRunDoc>({
  name: 'report_schedule_runs',
  scope: 'tenant',
  schema: {
    bsonType: 'object',
    required: ['orgId', 'scheduleId', 'slot', 'runOn', 'status', 'params', 'recipients', 'startedAt'],
    properties: { status: { enum: ['SENDING', 'SENT', 'FAILED'] } },
  },
  indexes: [
    { key: { orgId: 1, scheduleId: 1, slot: 1 }, name: 'one_per_slot', unique: true },
    { key: { orgId: 1, scheduleId: 1, startedAt: -1 }, name: 'by_schedule' },
  ],
  guards: {
    afterUpdate(before, after) {
      if (before.status !== 'SENDING') throw new GuardViolation('A finished run is kept as it was');
      if (after.scheduleId !== before.scheduleId || after.slot !== before.slot || after.runOn !== before.runOn) throw new GuardViolation('A run keeps its schedule and date');
    },
    beforeDelete() {
      throw new GuardViolation('Runs are kept as the record of what was sent');
    },
  },
});
