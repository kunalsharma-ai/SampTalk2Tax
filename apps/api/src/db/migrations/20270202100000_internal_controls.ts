import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { controlTests, internalControls } from '../collections/internal-controls';

/** Internal controls register and control tests (AUDIT-008, AUDIT-013). */
export default defineMigration({
  id: '20270202100000_internal_controls',
  async up(db) {
    await ensureCollection(db, internalControls);
    await ensureCollection(db, controlTests);
  },
});
