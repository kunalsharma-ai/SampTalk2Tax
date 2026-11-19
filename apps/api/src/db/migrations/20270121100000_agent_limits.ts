import { defineMigration } from '@talk2tax/document-db';

/** Agent execution limits (SEC-037): ai_agent_settings.hourlyTaskLimit, the server's default (null) for every agent. */
export default defineMigration({
  id: '20270121100000_agent_limits',
  async up(db) {
    await db.collection('ai_agent_settings').updateMany({ hourlyTaskLimit: { $exists: false } }, { $set: { hourlyTaskLimit: null } });
  },
});
