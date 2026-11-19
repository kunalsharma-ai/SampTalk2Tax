#!/usr/bin/env node
/**
 * No certification claims (SEC-028): Talk2Tax must not say it is SOC 2, ISO 27001, PCI DSS or
 * similar certified, compliant or attested until an independent assessment is complete. This
 * scans everything a customer can read (the web app, e-mails and messages from the API, public
 * files, the docs and README) for a sentence that pairs a framework with a claim word, unless the
 * sentence says the opposite ("not certified", "working toward", ...).
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
/** A sentence that denies or defers the claim is fine. */
const NEGATED = /\b(?:not|no|never|nor|without|toward|towards|readiness|until|unless|before|cannot|can't|isn't|aren't|don't|doesn't|won't|claim|claims|claiming|pending|planned)\b/i;

/** Each sentence of the text that claims a certification, with its line number. */
export function findClaims(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const m = sentence.match(PAIR);
      if (!m || NEGATED.test(sentence)) continue;
      if (ASSESSED.some((a) => m[0].toLowerCase().includes(a.toLowerCase()))) continue;
      found.push({ line: i + 1, text: sentence.trim().slice(0, 200) });
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
    console.error(`Certification claims found (SEC-028). Talk2Tax has no completed independent assessment:`);
    for (const c of claims) console.error(`  ${c.file}:${c.line}  ${c.text}`);
    process.exit(1);
  }
  console.log('No certification claims.');
}
