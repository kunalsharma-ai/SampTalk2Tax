/**
 * RULE-019 / RULE-012: money is never added, multiplied or rounded as a
 * binary float, not even for a preview on screen. Amounts go through the
 * Decimal helpers in @talk2tax/accounting-engine (dec, amountOrZero,
 * addAmounts, roundToCurrency). This check fails CI when app code converts an
 * amount to a JS number and does arithmetic with it. A line that works with
 * numbers that are not money (percents, minutes, counts) says so with a
 * trailing `// not money` comment.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = /^(apps\/(web|api)\/src|packages\/[^/]+\/src)\/.*\.(ts|tsx|mjs)$/;
const SKIP = /\.test\.(ts|tsx|mjs)$|\.d\.ts$/;
const MONEY = /(amount|total|subtotal|tax|interest|fee|price|balance|held|open|estimate|bySource|cost|paid|due|gross|net|salary|wage|debit|credit|liability)/i;
const NUMBERED = /(?:Number|parseFloat)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g;
const ARITH_AFTER = /^\s*[-+*/]/;
const ARITH_BEFORE = /[-+*/]\s*\(?\s*$/;

/** Lines of `text` that turn an amount into a float and calculate with it. */
export function findFloatMoney(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/\/\/\s*not money\b/.test(line)) return;
    let why = null;
    if (/\bparseFloat\(/.test(line) && MONEY.test(line)) why = 'parseFloat on an amount';
    for (const m of line.matchAll(NUMBERED)) {
      if (why) break;
      if (!MONEY.test(m[1])) continue;
      const before = line.slice(0, m.index);
      const after = line.slice(m.index + m[0].length);
      if (ARITH_AFTER.test(after) || ARITH_BEFORE.test(before) || /Math\.(round|floor|ceil)\($/.test(before)) why = `float arithmetic on ${m[0]}`;
    }
    if (!why && /Math\.round\([^)]*\*\s*100\)/.test(line) && MONEY.test(line)) why = 'rounds an amount through a float';
    if (why) out.push({ line: i + 1, why, text: line.trim() });
  });
  return out;
}

export function scanRepository() {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => SCAN.test(f) && !SKIP.test(f));
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const hit of findFloatMoney(text)) out.push({ file: f, ...hit });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = scanRepository();
  if (hits.length) {
    console.error('Money calculated as a float (RULE-019). Use dec, amountOrZero or addAmounts from @talk2tax/accounting-engine:');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.why}\n    ${h.text.slice(0, 160)}`);
    process.exit(1);
  }
  console.log('No float money arithmetic.');
}
