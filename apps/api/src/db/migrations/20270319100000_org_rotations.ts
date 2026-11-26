import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { orgRotations } from '../collections/org-rotations';
import { reportSchedules } from '../collections/report-schedules';

/**
 * Thousands of organisations (PERF-001): when each organisation is next due for the alert checks,
 * and report schedules found by organisation.
 */
export default defineMigration({
  id: '20270319100000_org_rotations',
  async up(db) {
    await ensureCollection(db, orgRotations);
    await ensureCollection(db, reportSchedules);
  },
});
