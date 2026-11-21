/** COMP-044, COMP-046, COMP-047: the matrix check refuses unsourced, unofficial and inconsistent findings. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkMatrix } from './check-competitive-matrix.mjs';

const doc = (summaryCode, detailRow) => `## Summary

| Capability | Acme Books |
|---|---|
| Payroll | ${summaryCode} |

## Acme Books

| Capability | Code | Finding | Source (verified 2026-11-21) |
|---|---|---|---|
${detailRow}
`;

test('accepts a sourced, dated and consistent finding', () => {
  assert.deepEqual(checkMatrix(doc('AO', '| Payroll | AO | Payroll is a separate paid product. | https://acme.example/payroll |')), []);
  assert.deepEqual(checkMatrix(doc('NC', '| Payroll | NC | Not on the pages read. | — |')), []);
});

test('refuses a finding with no source, an unofficial source or an off-scale code', () => {
  const problems = (row, code = 'EM') => checkMatrix(doc(code, row)).map((p) => p.problem).join('\n');
  assert.match(problems('| Payroll | EM | Payroll included. | — |'), /needs an official source/);
  assert.match(problems('| Payroll | EM | Payroll included. | https://www.g2.com/products/acme |'), /not an official vendor source/);
  assert.match(problems('| Payroll | EM | Payroll included. | http://acme.example/payroll |'), /not https/);
  assert.match(problems('| Payroll | Lacks | Payroll missing. | — |', 'NC'), /not on the scale/);
});

test('refuses a summary cell that disagrees with its detail row', () => {
  const problems = checkMatrix(doc('EM', '| Payroll | NC | Not on the pages read. | — |'));
  assert.match(problems.map((p) => p.problem).join('\n'), /summary says EM, detail says NC/);
});

test('refuses a detail table with no verification date', () => {
  const text = doc('AO', '| Payroll | AO | Separate product. | https://acme.example/payroll |').replace(' (verified 2026-11-21)', '');
  assert.match(checkMatrix(text).map((p) => p.problem).join('\n'), /no verification date/);
});

test('the real matrix passes', () => {
  assert.deepEqual(checkMatrix(readFileSync(new URL('../docs/COMPETITIVE_FEATURE_MATRIX.md', import.meta.url), 'utf8')), []);
});
