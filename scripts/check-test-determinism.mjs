/**
 * QA-031: tests must give the same result on every run. A test that draws from
 * Math.random can pass today and fail tomorrow with no code change, so test
 * files use seededRandom (from @talk2tax/accounting-engine) for numbers and
 * randomUUID for values that only need to be unique.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /(^|\/)(test|e2e)\/.*\.(ts|tsx|mjs|js)$|\.test\.(ts|tsx|mjs|js)$/;
const RULES = [
  { id: 'math-random', pattern: /\bMath\.random\s*\(/, fix: 'use seededRandom(seed) for numbers or randomUUID() for unique values' },
  { id: 'faker-unseeded', pattern: /\bfaker\.(?!seed\b)\w+\.\w+\(/, fix: 'call faker.seed(n) first, or use seededRandom' },
];
const ALLOWED = new Set(['scripts/check-test-determinism.test.mjs']);

/** Lines of `text` that break a determinism rule. */
export function findNondeterminism(text) {
  const out = [];
  const seeded = /\bfaker\.seed\s*\(/.test(text);
  text.split('\n').forEach((line, i) => {
    for (const r of RULES) {
      if (r.id === 'faker-unseeded' && seeded) continue;
      if (r.pattern.test(line)) out.push({ line: i + 1, rule: r.id, fix: r.fix, text: line.trim() });
    }
  });
  return out;
}

export function isTestFile(path) {
  return TEST_FILE.test(path) && !path.includes('node_modules/');
}

export function scanRepository() {
  const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = [];
  for (const f of tracked) {
    if (!isTestFile(f) || ALLOWED.has(f)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    for (const hit of findNondeterminism(text)) out.push({ file: f, ...hit });
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = scanRepository();
  if (hits.length) {
    console.error('Tests that can change result between runs (QA-031):');
    for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.rule}: ${h.fix}\n    ${h.text}`);
    process.exit(1);
  }
  console.log('Test data is deterministic.');
}
