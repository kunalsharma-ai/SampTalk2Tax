/**
 * AI explains and assists; it never invents tax rates or legal requirements (TAX-054). An AI
 * answer is checked after it is written: every tax rate it states (a percentage in a sentence
 * about tax) and every legal reference it cites (a section, rule or article) must appear in what
 * Talk2Tax gave the model in that conversation (tool results from the books and the built-in
 * rules) or in the organisation's own tax rates. Anything else is flagged to the reader as not
 * found in Talk2Tax, with the sentence it came from, so they confirm it with an adviser. The check
 * is deterministic and errs towards flagging.
 */

export type TaxClaimKind = 'RATE' | 'CITATION';

export interface TaxClaim {
  kind: TaxClaimKind;
  /** As written in the answer, for example "12%" or "section 194Q". */
  text: string;
  /** Normalised: "12" for a rate, "194Q" for a citation. */
  value: string;
  sentence: string;
  supported: boolean;
}

export interface TaxClaimCheck {
  claims: TaxClaim[];
  unsupported: TaxClaim[];
}

const TAX_WORDS = /\b(?:tax|taxes|taxed|gst|igst|cgst|sgst|utgst|vat|tds|tcs|cess|withholding|withheld|duty|duties|levy|levied|surcharge|excise|rate|rates|slab|bracket)\b/i;
const PERCENT = /(?<![\d.])(\d{1,3}(?:\.\d{1,4})?)\s?(?:%|per\s?cent\b|percent\b)/gi;
const CITATION = /\b(section|sec\.|u\/s|rule|article)\s?(\d{1,4}[A-Z]{0,3}(?:\(\d{1,3}[a-z]?\)){0,3})/gi;
const NUMBER = /\d+(?:\.\d+)?/g;

/** "18.00" → "18", "7.50" → "7.5". */
export function normaliseRate(n: string): string {
  if (!n.includes('.')) return String(Number(n));
  const [whole, frac] = n.split('.') as [string, string];
  const f = frac.replace(/0+$/, '');
  return f ? `${Number(whole)}.${f}` : String(Number(whole));
}

function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s(?=[A-Z0-9"(₹$€£])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The numbers and words in the evidence, to look claims up in. */
function index(evidence: string[]) {
  const numbers = new Set<string>();
  const text = evidence.join('\n').toUpperCase();
  for (const e of evidence) for (const m of e.match(NUMBER) ?? []) numbers.add(normaliseRate(m));
  return { numbers, text };
}

function citationIn(text: string, code: string) {
  const at = text.indexOf(code.toUpperCase());
  if (at < 0) return false;
  const before = at === 0 ? '' : text[at - 1]!;
  const after = text[at + code.length] ?? '';
  return !/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after);
}

/**
 * The tax rates and legal references in an AI answer, each marked supported when the evidence
 * (what the model was given) or the organisation's own rates contain it.
 */
export function checkTaxClaims(answer: string, input: { evidence: string[]; ownRates?: string[] }): TaxClaimCheck {
  const ev = index(input.evidence);
  for (const r of input.ownRates ?? []) ev.numbers.add(normaliseRate(r));
  const claims: TaxClaim[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(answer.slice(0, 50_000))) {
    if (TAX_WORDS.test(sentence)) {
      for (const m of sentence.matchAll(PERCENT)) {
        const value = normaliseRate(m[1]!);
        const key = `RATE:${value}:${sentence}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({ kind: 'RATE', text: m[0], value, sentence: sentence.slice(0, 300), supported: ev.numbers.has(value) });
      }
    }
    for (const m of sentence.matchAll(CITATION)) {
      const value = m[2]!.toUpperCase();
      const key = `CITATION:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push({ kind: 'CITATION', text: m[0], value, sentence: sentence.slice(0, 300), supported: citationIn(ev.text, value) });
    }
  }
  return { claims, unsupported: claims.filter((c) => !c.supported) };
}

/** The line added to an answer's record and shown under it when something is not supported. */
export function taxClaimsNotice(check: TaxClaimCheck): string | null {
  if (!check.unsupported.length) return null;
  const list = check.unsupported.map((c) => c.text).join(', ');
  return `This answer mentions ${list}, which Talk2Tax could not find in your records or its built-in rules. The AI may have recalled or invented it: confirm it with your tax adviser before relying on it.`;
}
