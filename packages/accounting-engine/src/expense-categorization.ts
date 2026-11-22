/**
 * Automatic expense categorisation (EXP-020, AP-020): the likely expense account for a receipt or
 * bill line, from how this business has booked the same merchant or vendor before, the words of
 * the description, and common kinds of spending matched to the account names. Rule-based and
 * explained; a person always chooses, and nothing is booked here.
 *
 * Scores, per account:
 * - Same merchant or vendor before: 3 points times the share of its earlier lines that went to
 *   the account (needs 2 or more earlier lines; 1 line gives 1.5 points).
 * - A kind of spending (taxi, hotel, restaurant, phone bill, software...) named in the merchant or
 *   description, matched to an account whose name fits it: 2 points.
 * - Description words seen on earlier lines: 1 point times the share of those lines that went to
 *   the account.
 * The best three accounts with 1 point or more are suggested. Confidence is high at 3 points or
 * more, medium at 2, low below.
 */

export type CategoryConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface CategoryAccount {
  id: string;
  code: string;
  name: string;
}

export interface CategoryHistoryLine {
  /** Merchant on a receipt, or vendor on a bill. */
  merchant: string | null;
  description: string | null;
  accountId: string;
}

export interface CategorySuggestion {
  accountId: string;
  code: string;
  name: string;
  confidence: CategoryConfidence;
  because: string[];
  /** Points, rounded to one decimal; not money. */
  score: number;
}

/** Kinds of spending: words that name them, and words of the account names they belong to. */
const KINDS: { kind: string; words: string[]; accounts: string[] }[] = [
  { kind: 'travel', words: ['uber', 'ola', 'rapido', 'taxi', 'cab', 'cabs', 'flight', 'flights', 'airline', 'airlines', 'indigo', 'vistara', 'airindia', 'train', 'irctc', 'railway', 'rail', 'bus', 'redbus', 'metro', 'toll', 'parking', 'fastag', 'airport', 'auto', 'travels', 'makemytrip', 'goibibo', 'cleartrip'], accounts: ['travel', 'conveyance', 'transport'] },
  { kind: 'hotel stay', words: ['hotel', 'hotels', 'inn', 'resort', 'lodge', 'stay', 'airbnb', 'oyo', 'accommodation', 'guest house'], accounts: ['travel', 'lodging', 'accommodation', 'hotel'] },
  { kind: 'fuel', words: ['fuel', 'petrol', 'diesel', 'cng', 'hpcl', 'bpcl', 'iocl', 'indian oil', 'shell'], accounts: ['fuel', 'vehicle', 'conveyance', 'travel'] },
  { kind: 'meals', words: ['restaurant', 'cafe', 'coffee', 'lunch', 'dinner', 'breakfast', 'food', 'meal', 'meals', 'swiggy', 'zomato', 'dhaba', 'snacks', 'tea', 'canteen', 'starbucks', 'dominos', 'pizza'], accounts: ['meal', 'meals', 'food', 'entertainment', 'staff welfare', 'refreshment', 'travel'] },
  { kind: 'phone and internet', words: ['airtel', 'jio', 'vodafone', 'bsnl', 'mobile', 'phone', 'internet', 'broadband', 'recharge', 'wifi', 'telephone', 'postpaid'], accounts: ['telephone', 'internet', 'communication', 'utilities'] },
  { kind: 'electricity and water', words: ['electricity', 'power', 'water', 'bescom', 'msedcl', 'tata power', 'adani electricity', 'utility'], accounts: ['utilities', 'electricity', 'power'] },
  { kind: 'software', words: ['software', 'subscription', 'saas', 'license', 'licence', 'google workspace', 'microsoft', 'office 365', 'aws', 'azure', 'zoom', 'adobe', 'slack', 'github', 'atlassian', 'canva', 'hosting', 'domain'], accounts: ['software', 'subscription', 'subscriptions', 'computer', 'it'] },
  { kind: 'office supplies', words: ['stationery', 'stationary', 'printer', 'printing', 'paper', 'toner', 'pen', 'pens', 'notebook', 'courier', 'postage', 'xerox', 'photocopy'], accounts: ['office', 'stationery', 'printing', 'postage', 'supplies'] },
  { kind: 'advertising', words: ['ads', 'advertising', 'advertisement', 'facebook ads', 'google ads', 'linkedin', 'promotion', 'banner', 'brochure', 'marketing'], accounts: ['marketing', 'advertising', 'promotion'] },
  { kind: 'professional fees', words: ['consultant', 'consulting', 'legal', 'lawyer', 'advocate', 'audit', 'ca fees', 'chartered accountant', 'professional fees', 'retainer'], accounts: ['professional', 'legal', 'consult', 'audit'] },
  { kind: 'rent', words: ['rent', 'lease', 'coworking', 'co working', 'wework'], accounts: ['rent', 'lease'] },
  { kind: 'training', words: ['course', 'training', 'udemy', 'coursera', 'conference', 'seminar', 'workshop', 'webinar', 'certification', 'books'], accounts: ['training', 'education', 'conference', 'learning'] },
  { kind: 'repairs', words: ['repair', 'repairs', 'maintenance', 'service charge', 'servicing', 'plumber', 'electrician', 'carpenter'], accounts: ['repair', 'maintenance'] },
  { kind: 'bank charges', words: ['bank charges', 'sms charges', 'neft charges', 'processing fee', 'annual fee', 'card fee'], accounts: ['bank charges', 'bank'] },
];

const norm = (s: string | null | undefined) => ` ${(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const STOP = new Set(['the', 'and', 'for', 'from', 'with', 'to', 'of', 'in', 'on', 'at', 'a', 'an', 'by', 'paid', 'payment', 'bill', 'invoice', 'receipt', 'charges', 'charge', 'fee', 'fees']);
const words = (s: string | null | undefined) => [...new Set(norm(s).trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];

/** Accounts likely to fit a line, best first; none when nothing points anywhere. */
export function suggestExpenseCategory(input: { merchant?: string | null; description?: string | null; accounts: CategoryAccount[]; history: CategoryHistoryLine[]; limit?: number }): CategorySuggestion[] {
  const allowed = new Map(input.accounts.map((a) => [a.id, a]));
  const score = new Map<string, number>();
  const because = new Map<string, string[]>();
  const add = (id: string, points: number, why: string) => {
    if (!allowed.has(id) || points <= 0) return;
    score.set(id, (score.get(id) ?? 0) + points);
    because.set(id, [...(because.get(id) ?? []), why]);
  };
  const history = input.history.filter((h) => allowed.has(h.accountId));

  // The same merchant or vendor before.
  const m = norm(input.merchant).trim();
  if (m) {
    const same = history.filter((h) => norm(h.merchant).trim() === m);
    const counts = new Map<string, number>();
    for (const h of same) counts.set(h.accountId, (counts.get(h.accountId) ?? 0) + 1);
    for (const [id, n] of counts) add(id, same.length >= 2 ? (3 * n) / same.length : 1.5, `${n} of ${same.length} earlier ${same.length === 1 ? 'line' : 'lines'} from ${input.merchant!.trim()} went here`);
  }

  // A kind of spending named in the merchant or description.
  const text = `${norm(input.merchant)}${norm(input.description)}`;
  for (const k of KINDS) {
    const hit = k.words.find((w) => text.includes(` ${w} `));
    if (!hit) continue;
    const fits = input.accounts.filter((a) => k.accounts.some((w) => norm(a.name).includes(` ${w} `) || norm(a.name).includes(` ${w}s `)));
    // The most specific fit: the first account word in the list that any account name has.
    const word = k.accounts.find((w) => fits.some((a) => norm(a.name).includes(` ${w} `) || norm(a.name).includes(` ${w}s `)));
    for (const a of fits.filter((x) => word && (norm(x.name).includes(` ${word} `) || norm(x.name).includes(` ${word}s `)))) add(a.id, 2, `"${hit}" reads as ${k.kind}`);
  }

  // Description words seen on earlier lines.
  for (const w of words(input.description)) {
    const seen = history.filter((h) => words(h.description).includes(w) || words(h.merchant).includes(w));
    if (seen.length < 2) continue;
    const counts = new Map<string, number>();
    for (const h of seen) counts.set(h.accountId, (counts.get(h.accountId) ?? 0) + 1);
    for (const [id, n] of counts) add(id, n / seen.length, `"${w}" was on ${seen.length} earlier lines, ${n} of them booked here`);
  }

  return [...score.entries()]
    .filter(([, s]) => s >= 1)
    .sort((a, b) => b[1] - a[1] || allowed.get(a[0])!.code.localeCompare(allowed.get(b[0])!.code))
    .slice(0, input.limit ?? 3)
    .map(([id, s]) => {
      const a = allowed.get(id)!;
      return { accountId: id, code: a.code, name: a.name, confidence: s >= 3 ? 'HIGH' : s >= 2 ? 'MEDIUM' : 'LOW', because: because.get(id)!, score: Math.round(s * 10) / 10 }; // not money: points
    });
}
