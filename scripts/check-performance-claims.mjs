/**
 * PERF-014 / PERF-021: performance targets are written down as budgets (perf/budgets.json) and only
 * claimed when a benchmark that runs in CI measures them. This check fails when:
 *
 *   - a budget is missing its feature, limit, percentile, benchmark or test conditions;
 *   - a budget's benchmark file does not exist, does not run in CI, or does not read the budget's
 *     limit from perf/budgets.json by its key (so the number lives in one place);
 *   - a feature with a budget is marked Implemented or Tested without its benchmark as evidence;
 *   - a feature whose description sets a time target ("under two seconds", "300 milliseconds") is
 *     marked Implemented or Tested with no budget.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLAIMED = new Set(['Implemented', 'Tested']);
const TIME_TARGET = /\b(?:milliseconds?|seconds?|ms)\b/i;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Problems with the budgets file and the claims made in the registry. */
export function checkPerformanceClaims({ budgets, statuses, features, ci, exists, source }) {
  const problems = [];
  const byFeature = new Map();
  for (const b of budgets) {
    const name = b.key ?? '(a budget without a key)';
    for (const field of ['key', 'feature', 'title', 'benchmark', 'conditions']) if (typeof b[field] !== 'string' || !b[field].trim()) problems.push(`${name}: ${field} is missing`);
    if (!(Number.isFinite(b.limitMs) && b.limitMs > 0)) problems.push(`${name}: limitMs must be a positive number`);
    if (!(Number.isInteger(b.percentile) && b.percentile > 0 && b.percentile <= 100)) problems.push(`${name}: percentile must be 1 to 100`);
    if (typeof b.feature === 'string') byFeature.set(b.feature, [...(byFeature.get(b.feature) ?? []), b]);
    if (typeof b.benchmark !== 'string') continue;
    if (!exists(b.benchmark)) {
      problems.push(`${name}: the benchmark ${b.benchmark} does not exist`);
      continue;
    }
    const inCi = ci.includes(b.benchmark) || (/^apps\/web\/e2e\/[^/]+\.test\.mjs$/.test(b.benchmark) && /\bpnpm e2e\b/.test(ci));
    if (!inCi) problems.push(`${name}: the benchmark ${b.benchmark} does not run in CI`);
    const text = source(b.benchmark);
    if (!text.includes('perf/budgets.json') || !text.includes(`'${b.key}'`)) problems.push(`${name}: ${b.benchmark} must read its limit from perf/budgets.json by the key '${b.key}'`);
  }
  for (const [feature, list] of byFeature) {
    const s = statuses[feature];
    if (!s || !CLAIMED.has(s.status)) continue;
    const evidence = (s.evidence ?? []).join(' ');
    for (const b of list) if (!evidence.includes(b.benchmark)) problems.push(`${feature} is ${s.status} but its evidence does not name the benchmark ${b.benchmark} for ${b.key}`);
  }
  for (const f of features) {
    const s = statuses[f.id];
    if (!f.id.startsWith('PERF-') || !s || !CLAIMED.has(s.status) || !TIME_TARGET.test(f.description ?? '')) continue;
    if (!byFeature.has(f.id)) problems.push(`${f.id} sets a time target and is ${s.status}, but perf/budgets.json has no budget for it`);
  }
  return problems;
}

export function checkRepository() {
  const budgets = JSON.parse(read('perf/budgets.json')).budgets;
  const statuses = JSON.parse(read('features/status.json')).features;
  const registry = JSON.parse(read('features/registry.json'));
  const features = Array.isArray(registry) ? registry : registry.features;
  return checkPerformanceClaims({ budgets, statuses, features, ci: read('.github/workflows/ci.yml'), exists: (p) => existsSync(join(ROOT, p)), source: read });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkRepository();
  if (problems.length) {
    console.error('Performance claims without a measured budget (PERF-014, PERF-021):');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('Every performance target claimed has a budget measured in CI.');
}
