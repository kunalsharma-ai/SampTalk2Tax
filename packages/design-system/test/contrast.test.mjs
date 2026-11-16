import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// WCAG 2.x contrast ratio between two hex colours.
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
const v = (name) => new RegExp(`--t2t-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)[1];

test('body and muted text meet WCAG AA (4.5:1) on every surface', () => {
  for (const surface of ['bg', 'surface', 'surface-raised', 'surface-hover']) {
    for (const text of ['text', 'text-muted']) {
      assert.ok(ratio(v(text), v(surface)) >= 4.5, `${text} on ${surface}: ${ratio(v(text), v(surface)).toFixed(2)}`);
    }
  }
});

test('status and accent colours meet 3:1 for non-text UI on surfaces', () => {
  for (const c of ['accent', 'positive', 'warning', 'negative', 'violet', 'focus']) {
    assert.ok(ratio(v(c), v('surface')) >= 3, `${c}: ${ratio(v(c), v('surface')).toFixed(2)}`);
  }
});
