#!/usr/bin/env node
/**
 * Claims Talk2Tax must not make (SEC-028, RULE-006, RULE-007). This scans everything a customer
 * can read (the web app, e-mails and messages from the API, public files, the docs and README) for
 * a sentence that makes one of these claims, unless the sentence, or the heading it sits under,
 * says the opposite ("not certified", "no live bank feed", "Not in this release", ...):
 *
 *   - certification: SOC 2, ISO 27001, PCI DSS or similar certified, compliant or attested, until
 *     an independent assessment is complete;
 *   - regulatory: approved, certified or licensed by a tax authority, the government or a
 *     regulator, or "fully compliant" / "guaranteed compliance", which nothing has verified;
 *   - live banking: a live, real-time or direct bank feed or connection, which needs a provider,
 *     credentials and validation that Talk2Tax does not have.
 *   - competitors (COMP-046): that a competitor lacks something, or that Talk2Tax is better than
 *     one, unless the sentence cites a verified source or says the point is not confirmed.
 *
 *   node scripts/check-claims.mjs          exits 1 and lists each claim found
 *
 * A claim may be added only with a completed assessment: record it in docs/COMPLIANCE_READINESS.md
 * (Assessments) and list the report here in ASSESSED.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Frameworks with a completed independent assessment, by the name used in claims. None yet. */
export const ASSESSED = [];

const FRAMEWORK = String.raw`(?:SOC\s?[123](?:\s+Type\s+(?:I{1,2}|[12]))?|ISO(?:\/IEC)?\s?27(?:001|017|018|701)|PCI[\s-]?DSS|HIPAA|GDPR|DPDP(?:\s+Act)?|CSA\s+STAR|FedRAMP)`;
const CLAIM = String.raw`(?:certified|certificate|certification\s+(?:achieved|obtained|granted)|compliant|accredited|attested|attestation\s+(?:achieved|obtained)|audited|approved)`;
const PAIR = new RegExp(String.raw`\b${FRAMEWORK}\b[^.!?\n]{0,60}?\b${CLAIM}\b|\b${CLAIM}\b[^.!?\n]{0,40}?\b${FRAMEWORK}\b`, 'i');
const AUTHORITY = String.raw`(?:GSTN?|IRP|e-?invoic\w*|e-?way\s+bill\w*|TDS|TCS|income[- ]tax(?:\s+department)?|CBDT|CBIC|RBI|SEBI|MCA|ICAI|government|govt|statutory|regulatory|regulators?|tax\s+department)`;
const ENDORSED = String.raw`(?:approved|certified|accredited|endorsed|licensed|authori[sz]ed|recogni[sz]ed|empanelled)`;
const REGULATORY = new RegExp(
  String.raw`\b${AUTHORITY}\b[^.!?\n]{0,40}?\b${ENDORSED}\b|\b${ENDORSED}\s+by\s+(?:the\s+)?${AUTHORITY}\b|\b(?:100%|fully|completely|guaranteed|always)\s+(?:tax[- ]|GST[- ]|legally\s+|regulatory\s+|statutory\s+)?compliant\b|\bguarantee[sd]?\s+(?:tax\s+|GST\s+|regulatory\s+|statutory\s+|legal\s+)?compliance\b`,
  'i',
);
const LIVE_BANKING = /\b(?:live|real[- ]time|automatic|automated|direct|instant)\s+bank(?:ing)?\s+(?:feeds?|sync(?:ing|hroni[sz]ation)?|connections?|integrations?)\b|\b(?:live|real[- ]time)\s+feeds?\s+from\s+(?:your\s+)?banks?\b|\bconnects?\s+(?:directly\s+)?to\s+(?:your|all|every|any)\s+banks?\b/i;
const COMPETITOR_NAMES = String.raw`(?:QuickBooks|Intuit|Xero|Zoho(?:\s+Books)?|NetSuite|Oracle|SAP|Dynamics\s*365|Business\s+Central|Sage(?:\s+Intacct)?|FreshBooks|Odoo|Wave|Acumatica|Workday|Ramp|BILL|Bill\.com|Tally(?:Prime)?|[Cc]ompetitors?|[Oo]ther\s+(?:tools|software|products|apps))`;
/** COMP-046: a competitor is not said to lack something, or to be worse, without a verified source. */
const COMPETITOR = new RegExp(
  String.raw`\b(?:[Uu]nlike|[Bb]etter\s+than|[Bb]eats|[Oo]utperforms|[Ss]uperior\s+to|[Rr]eplaces)\s+(?:the\s+)?${COMPETITOR_NAMES}\b|\b${COMPETITOR_NAMES}\b[^.!?\n]{0,40}?\b(?:lacks?|lacking|doesn't|does\s+not|don't|do\s+not|can't|cannot|has\s+no|have\s+no|offers?\s+no|is\s+missing|are\s+missing|fails?\s+to)\b`,
);
/** What lets a competitor sentence through: it cites a check, or is the rule itself. */
const COMPETITOR_OK = /\b(?:not\s+confirmed|verified|source|claim|claims|claiming|incorrectly)\b/i;
const KINDS = [
  ['certification', PAIR],
  ['regulatory', REGULATORY],
  ['live-banking', LIVE_BANKING],
  ['competitor', COMPETITOR],
];
/** A sentence that denies, defers or only describes a condition for the claim is fine. */
const NEGATED = /\b(?:not|no|never|nor|without|toward|towards|readiness|until|unless|before|cannot|can't|isn't|aren't|don't|doesn't|won't|claim|claims|claiming|pending|planned|only|needs|requires|must)\b/i;

/** Each sentence of the text that makes a claim, with its line number and kind. Markdown headings that deny (such as "Not in slice 2") cover the lines under them. */
export function findClaims(text) {
  const found = [];
  let deniedSection = false;
  text.split('\n').forEach((line, i) => {
    const heading = line.match(/^#{1,6}\s+(.*)/);
    if (heading) deniedSection = NEGATED.test(heading[1]) || /\blimitations?\b|\bout of scope\b/i.test(heading[1]);
    if (deniedSection && !heading) return;
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      for (const [kind, re] of KINDS) {
        const m = sentence.match(re);
        if (!m) continue;
        if (kind === 'competitor' ? COMPETITOR_OK.test(sentence) : NEGATED.test(sentence)) continue;
        if (kind === 'certification' && ASSESSED.some((a) => m[0].toLowerCase().includes(a.toLowerCase()))) continue;
        found.push({ line: i + 1, kind, text: sentence.trim().slice(0, 200) });
        break;
      }
    }
  });
  return found;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** What customers and visitors can read. */
const SCAN = ['apps/web/src', 'apps/web/public', 'apps/api/src', 'docs', 'README.md'];
const EXTENSIONS = /\.(?:ts|tsx|mjs|js|json|md|txt|html|svg|webmanifest)$/;
/** Requirements and inventories quote the rule itself; the readiness document states the position. */
const SKIP = new Set(['docs/MASTER_DIRECTIVE.md', 'docs/PRODUCT_REQUIREMENTS.md', 'docs/FEATURE_INVENTORY.md', 'docs/FEATURE_STATUS.md']);

function* files(path) {
  const full = join(ROOT, path);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    if (EXTENSIONS.test(path) && !SKIP.has(path)) yield path;
    return;
  }
  for (const name of readdirSync(full)) {
    if (name === 'node_modules' || name.startsWith('.next') || name === 'dist') continue;
    yield* files(join(path, name));
  }
}

export function scanRepository() {
  const out = [];
  for (const SCAN_PATH of SCAN) for (const f of files(SCAN_PATH)) for (const c of findClaims(readFileSync(join(ROOT, f), 'utf8'))) out.push({ file: relative(ROOT, join(ROOT, f)), ...c });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const claims = scanRepository();
  if (claims.length) {
    console.error('Claims Talk2Tax cannot back (SEC-028, RULE-006, RULE-007): no independent assessment, regulator approval or live bank connection exists.');
    for (const c of claims) console.error(`  ${c.file}:${c.line}  [${c.kind}] ${c.text}`);
    process.exit(1);
  }
  console.log('No certification, regulatory, live-banking or competitor claims.');
}
