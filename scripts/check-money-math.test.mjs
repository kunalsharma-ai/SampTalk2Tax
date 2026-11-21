/** RULE-019: the money-math check finds float arithmetic on amounts and lets decimal code through. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findFloatMoney, scanRepository } from './check-money-math.mjs';

test('finds amounts calculated as floats', () => {
  for (const bad of [
    'const left = Number(r.ledgerBalance) - explained;',
    'const explained = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);',
    'const total = rows.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);',
    'const wAmount = (Number(calc.subtotal) + Number(calc.tax)).toFixed(2);',
    'const converted = (Math.round(Number(amount) * Number(used) * 100) / 100).toFixed(2);',
    'const fee = parseFloat(form.lateFee);',
  ]) {
    assert.equal(findFloatMoney(bad).length, 1, bad);
  }
});

test('lets decimal code, non-money numbers and marked lines through', () => {
  for (const ok of [
    'const total = addAmounts(rows.map((x) => x.amount));',
    'const left = amountOrZero(r.ledgerBalance).minus(explained);',
    'const minute = Number(parts.hour) * 60 + Number(parts.minute);',
    'const ok = Number(amount) > 0;',
    'const width = (Number(amount) / max) * 100; // not money: a chart width',
  ]) {
    assert.deepEqual(findFloatMoney(ok), [], ok);
  }
});

test('no app code calculates money as a float', () => {
  assert.deepEqual(scanRepository(), []);
});
