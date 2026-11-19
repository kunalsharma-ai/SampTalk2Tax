/** SEC-028: the certification-claim check finds claims and lets denials and plans through. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findClaims, scanRepository } from './check-claims.mjs';

test('finds a certification claim', () => {
  for (const claim of ['Talk2Tax is SOC 2 Type II certified.', 'We are ISO 27001 certified and GDPR compliant.', 'Certified under ISO/IEC 27001', 'A PCI-DSS compliant checkout', 'Fully HIPAA compliant storage', 'Our SOC2 attested platform']) {
    assert.equal(findClaims(claim).length, 1, claim);
  }
  assert.deepEqual(findClaims('Intro line\nTalk2Tax is ISO 27001 certified.'), [{ line: 2, text: 'Talk2Tax is ISO 27001 certified.' }]);
});

test('lets denials, plans and unrelated text through', () => {
  for (const ok of [
    'Talk2Tax is not SOC 2 certified.',
    'We are working toward ISO 27001; no certification has been obtained.',
    'SOC 2 readiness: controls mapped below.',
    'Do not claim SOC 2 or ISO 27001 certification without a completed independent assessment.',
    'The month was certified by the owner.',
    'GDPR and the DPDP Act give people the right to erase their data.',
  ]) {
    assert.deepEqual(findClaims(ok), [], ok);
  }
});

test('nothing a customer can read claims a certification today', () => {
  assert.deepEqual(scanRepository(), []);
});
