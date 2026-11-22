import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { communicationPolicies, contactEmailConsents } from '../collections/communication';

/** Contacts' email consent and the organisation's communication policy (AR-043). */
export default defineMigration({
  id: '20270211100000_communication_policy',
  async up(db) {
    await ensureCollection(db, contactEmailConsents);
    await ensureCollection(db, communicationPolicies);
  },
});
