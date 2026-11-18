import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mfaChallenges, userMfa } from '../collections/identity';

/** Two-step sign-in: authenticator secrets with recovery codes, and the sign-in challenges waiting for a code. */
export default defineMigration({
  id: '20261220100000_two_step_sign_in',
  async up(db) {
    for (const def of [userMfa, mfaChallenges]) await ensureCollection(db, def);
  },
});
