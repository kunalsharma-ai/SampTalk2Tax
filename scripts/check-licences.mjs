/**
 * RULE-017 and COMP-048: Talk2Tax is built from original code and open-source
 * packages whose licences allow use in a commercial product. This check fails CI
 * when (1) an installed package has a licence outside the allowed list, or
 * (2) a source file carries a competitor's copyright or proprietary notice,
 * which would mean their code was copied in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Licences that allow use, change and sale in a closed product with attribution. */
export const ALLOWED_LICENCES = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Unlicense', 'PSF-2.0', 'BlueOak-1.0.0', 'Python-2.0', 'CC0-1.0']);
/**
 * Licences allowed only for named packages, and why. MPL-2.0 is file-level
 * copyleft: fine while the files are used unchanged. LGPL is allowed for the
 * image library sharp loads dynamically. CC-BY-4.0 covers browser-support data.
 */
export const ALLOWED_FOR = {
  'MPL-2.0': { why: 'file-level copyleft, used unchanged', packages: null },
  'LGPL-3.0-or-later': { why: 'native image library loaded dynamically by sharp', packages: /^@img\/sharp-libvips-/ },
  'CC-BY-4.0': { why: 'browser-support data, attributed', packages: /^caniuse-lite$/ },
};

function partAllowed(name, id) {
  const t = id.trim().replace(/^\(|\)$/g, '');
  if (ALLOWED_LICENCES.has(t)) return true;
  const rule = ALLOWED_FOR[t];
  return !!rule && (rule.packages === null || rule.packages.test(name));
}

/** Whether package `name` may be used under SPDX expression `expr`. */
export function licenceAllowed(name, expr) {
  if (!expr || /unknown|unlicensed|see license in|proprietary|commercial/i.test(expr)) return false;
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (/\s+OR\s+/.test(e)) return e.split(/\s+OR\s+/).some((p) => licenceAllowed(name, p));
  return e.split(/\s+AND\s+/).every((p) => partAllowed(name, p));
}

const COMPETITORS = ['Intuit', 'QuickBooks', 'Xero', 'Zoho', 'Oracle', 'NetSuite', 'SAP SE', 'Microsoft Corporation', 'Sage Group', 'Sage Software', 'Tally Solutions', 'Workday', 'FreshBooks', 'Odoo', 'Wave Financial', 'Acumatica', 'Ramp Business', 'Bill\\.com', 'BILL Holdings'];
const NOTICE = new RegExp(`(copyright|©|\\(c\\)\\s*\\d{4})[^\\n]{0,40}\\b(${COMPETITORS.join('|')})\\b|\\b(${COMPETITORS.join('|')})\\b[^\\n]{0,40}(all rights reserved|proprietary and confidential|confidential and proprietary)`, 'i');

/** Lines of `text` with a competitor's copyright or proprietary notice. */
export function findCompetitorNotices(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (NOTICE.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

const SOURCE = /\.(ts|tsx|js|mjs|cjs|css|html)$/;
const SELF = new Set(['scripts/check-licences.mjs', 'scripts/check-licences.test.mjs']);

export function scanSources() {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => SOURCE.test(f) && !SELF.has(f));
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const hit of findCompetitorNotices(text)) out.push({ file: f, ...hit });
  }
  return out;
}

/** Installed packages whose licence is not allowed. */
export function scanPackages() {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const byLicence = JSON.parse(raw);
  const out = [];
  for (const [licence, pkgs] of Object.entries(byLicence)) for (const p of pkgs) if (!licenceAllowed(p.name, licence)) out.push({ name: p.name, versions: p.versions, licence });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const notices = scanSources();
  const packages = scanPackages();
  for (const n of notices) console.error(`Competitor notice (RULE-017): ${n.file}:${n.line}  ${n.text.slice(0, 160)}`);
  for (const p of packages) console.error(`Licence not allowed (RULE-017): ${p.name}@${p.versions.join(',')}  ${p.licence}`);
  if (notices.length || packages.length) process.exit(1);
  console.log('Only original code and allowed open-source licences.');
}
