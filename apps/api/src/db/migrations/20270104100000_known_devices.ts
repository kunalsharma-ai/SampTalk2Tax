import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { authSessions, knownDevices } from '../collections/identity';

/** Devices people sign in from, and the device on each session (SEC-009). */
export default defineMigration({
  id: '20270104100000_known_devices',
  async up(db) {
    await ensureCollection(db, knownDevices);
    await ensureCollection(db, authSessions);
  },
});
