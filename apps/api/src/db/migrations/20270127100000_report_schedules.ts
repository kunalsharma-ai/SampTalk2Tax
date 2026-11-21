import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { reportScheduleRuns, reportSchedules } from '../collections/report-schedules';

/** Scheduled reports by email (RPT-031, RPT-032). */
export default defineMigration({
  id: '20270127100000_report_schedules',
  async up(db) {
    await ensureCollection(db, reportSchedules);
    await ensureCollection(db, reportScheduleRuns);
  },
});
