import { defineMigration, ensureCollection } from '@talk2tax/document-db';
import { cardPrograms, cardTransactions, companyCards } from '../collections/company-cards';

/** Company cards: card programmes, corporate and virtual cards, and card transactions (EXP-011/012). */
export default defineMigration({
  id: '20270307100000_company_cards',
  async up(db) {
    await ensureCollection(db, cardPrograms);
    await ensureCollection(db, companyCards);
    await ensureCollection(db, cardTransactions);
  },
});
