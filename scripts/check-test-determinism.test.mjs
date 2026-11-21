/** QA-031: the determinism check finds unseeded randomness in tests and lets seeded data through. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNondeterminism, isTestFile, scanRepository } from './check-test-determinism.mjs';

test('finds unseeded randomness', () => {
  assert.equal(findNondeterminism('const n = Math.random() * 10;')[0].rule, 'math-random');
  assert.equal(findNondeterminism('const name = faker.person.fullName();')[0].rule, 'faker-unseeded');
  assert.deepEqual(findNondeterminism('a\nb\nconst x = Math.random();').map((h) => h.line), [3]);
});

test('lets seeded and unique-only values through', () => {
  for (const ok of ['const next = seededRandom(7);', 'const id = randomUUID();', 'faker.seed(3);\nconst n = faker.person.fullName();']) {
    assert.deepEqual(findNondeterminism(ok), [], ok);
  }
});

test('knows which files are tests', () => {
  for (const f of ['apps/api/test/x.e2e.test.ts', 'apps/web/e2e/flow.test.mjs', 'packages/accounting-engine/test/a.test.ts', 'apps/web/src/lib/x.test.ts']) assert.ok(isTestFile(f), f);
  for (const f of ['apps/api/src/app.module.ts', 'scripts/load-test.mjs', 'node_modules/a/test/b.js']) assert.ok(!isTestFile(f), f);
});

test('no test in the repository draws unseeded random data', () => {
  assert.deepEqual(scanRepository(), []);
});
