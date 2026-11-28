import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { users } from '../collections/identity';

/** How much the interface moves (DASH-038): a person's motion choice, checked by the users validator. */
export default defineMigration({
  id: '20270320100000_motion_preference',
  async up(db) {
    await ensureCollection(db, users);
  },
});
