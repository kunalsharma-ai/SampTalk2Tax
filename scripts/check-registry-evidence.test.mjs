/** RULE-020: the registry check refuses claims the code does not back. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidencePath, evidenceProblems, scanRegistry } from './check-registry-evidence.mjs';

test('reads the path out of an evidence entry', () => {
  assert.equal(evidencePath('apps/api/test/ledger.e2e.test.ts › journal posting'), 'apps/api/test/ledger.e2e.test.ts');
  assert.equal(evidencePath('apps/api/src/tax-notices; MongoDB collections tax_notices'), 'apps/api/src/tax-notices');
  assert.equal(evidencePath('/v1/orgs/:orgId/contacts'), null);
  assert.equal(evidencePath('decimal.js with 40-digit precision'), null);
});

test('refuses a Tested feature without a test, and evidence that is gone', () => {
  const exists = (p) => p !== 'apps/api/test/gone.e2e.test.ts';
  assert.deepEqual(evidenceProblems('X-1', { status: 'Tested', evidence: ['apps/web/src/app/orgs/[orgId]/x'] }, exists), ['X-1: marked Tested but names no test']);
  assert.deepEqual(evidenceProblems('X-2', { status: 'Tested', evidence: ['apps/api/test/gone.e2e.test.ts'] }, exists), ['X-2: evidence apps/api/test/gone.e2e.test.ts is not in the repository', 'X-2: marked Tested but names no test']);
  assert.deepEqual(evidenceProblems('X-3', { status: 'Tested', evidence: ['apps/api/test/x.e2e.test.ts › works', 'GET /v1/x'] }, exists), []);
  assert.deepEqual(evidenceProblems('X-4', { status: 'Not started', evidence: ['apps/api/test/gone.e2e.test.ts'] }, exists), []);
});

test('the registry claims nothing the repository does not show', () => {
  assert.deepEqual(scanRegistry(), []);
});
