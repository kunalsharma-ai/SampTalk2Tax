import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { accounts } from '../collections/chart';
import { journalEntries } from '../collections/ledger';
import { contacts, documents, payments } from '../collections/sales';

/**
 * Efficient search (PERF-012): the fields the header search looks in (document and payment numbers
 * and references, journal references and memos, account names) get an index that starts with the
 * organisation, so a search reads index entries and fetches only the records that match.
 */
export default defineMigration({
  id: '20270316100000_search_indexes',
  async up(db) {
    for (const def of [contacts, documents, payments, journalEntries, accounts]) await ensureCollection(db, def);
  },
});
