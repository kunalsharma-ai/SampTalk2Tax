/** PERF-014 / PERF-021: the performance-claims check. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPerformanceClaims, checkRepository } from './check-performance-claims.mjs';

const budget = { key: 'api-read-p95', feature: 'PERF-016', title: 'Reads', percentile: 95, limitMs: 300, benchmark: 'scripts/load-test.mjs', conditions: 'CI runner' };
const base = {
  budgets: [budget],
  statuses: { 'PERF-016': { status: 'Tested', evidence: ['scripts/load-test.mjs › reads'] } },
  features: [{ id: 'PERF-016', description: 'Common API reads under 300 milliseconds' }],
  ci: 'run: node scripts/load-test.mjs --check',
  exists: () => true,
  source: () => "readFileSync('../perf/budgets.json'); limit('api-read-p95')",
};

test('passes a budget measured in CI and claimed with its benchmark', () => {
  assert.deepEqual(checkPerformanceClaims(base), []);
});

test('finds an incomplete budget and a benchmark that is missing, not in CI or holds its own number', () => {
  assert.deepEqual(checkPerformanceClaims({ ...base, budgets: [{ ...budget, limitMs: 0, conditions: '' }] }), [
    'api-read-p95: conditions is missing',
    'api-read-p95: limitMs must be a positive number',
  ]);
  assert.deepEqual(checkPerformanceClaims({ ...base, exists: () => false }), ['api-read-p95: the benchmark scripts/load-test.mjs does not exist']);
  assert.deepEqual(checkPerformanceClaims({ ...base, ci: 'run: pnpm test' }), ['api-read-p95: the benchmark scripts/load-test.mjs does not run in CI']);
  assert.match(checkPerformanceClaims({ ...base, source: () => 'const BUDGET = 300;' })[0], /must read its limit from perf\/budgets.json/);
  // Browser benchmarks run with every other browser test.
  const e2e = { ...budget, benchmark: 'apps/web/e2e/dash.test.mjs' };
  assert.deepEqual(checkPerformanceClaims({ ...base, budgets: [e2e], statuses: { 'PERF-016': { status: 'Tested', evidence: ['apps/web/e2e/dash.test.mjs'] } }, ci: 'run: pnpm e2e' }), []);
});

test('finds claims made without the measurement', () => {
  assert.match(checkPerformanceClaims({ ...base, statuses: { 'PERF-016': { status: 'Tested', evidence: ['docs/x.md'] } } })[0], /evidence does not name the benchmark/);
  assert.deepEqual(checkPerformanceClaims({ ...base, budgets: [] }), ['PERF-016 sets a time target and is Tested, but perf/budgets.json has no budget for it']);
  // Not claimed yet: nothing to measure.
  assert.deepEqual(checkPerformanceClaims({ ...base, budgets: [], statuses: { 'PERF-016': { status: 'Not started', evidence: [] } } }), []);
});

test('the repository makes no unmeasured performance claim', () => {
  assert.deepEqual(checkRepository(), []);
});
