import { defineMigration } from '@talk2tax/document-db';

/**
 * The bookkeeping collections of the data layer itself: per-organisation and global
 * counters (_sequences). _migrations and _locks are created by the runner.
 */
export default defineMigration({
  id: '20261109090000_foundation',
  async up(db) {
    const existing = await db.listCollections({ name: '_sequences' }, { nameOnly: true }).toArray();
    if (!existing.length) {
      await db.createCollection('_sequences', {
        validator: { $jsonSchema: { bsonType: 'object', required: ['_id', 'value'], properties: { _id: { bsonType: 'string' }, value: { bsonType: ['int', 'long'], minimum: 1 } } } },
        validationLevel: 'strict',
        validationAction: 'error',
      });
    }
  },
});
