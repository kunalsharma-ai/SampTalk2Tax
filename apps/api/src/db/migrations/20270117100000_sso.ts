import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { mirrorModels } from '../mirror-writes';

/** Single sign-on (SEC-006/007): sso_connections, sso_domains and sso_login_states. */
export default defineMigration({
  id: '20270117100000_sso',
  async up(db) {
    for (const info of mirrorModels(['SsoConnection', 'SsoDomain', 'SsoLoginState'])) await ensureCollection(db, info.def);
  },
});
