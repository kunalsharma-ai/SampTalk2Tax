import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { riskReadings } from '../collections/risk-readings';

/** Risk monitor readings, one per organisation and day (DASH-036). */
export default defineMigration({
  id: '20270308100000_risk_readings',
  async up(db) {
    await ensureCollection(db, riskReadings);
  },
});
