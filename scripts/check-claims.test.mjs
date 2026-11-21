/** SEC-028, RULE-006, RULE-007: the claims check finds claims and lets denials and plans through. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findClaims, scanRepository } from './check-claims.mjs';

test('finds a certification claim', () => {
  for (const claim of ['Talk2Tax is SOC 2 Type II certified.', 'We are ISO 27001 certified and GDPR compliant.', 'Certified under ISO/IEC 27001', 'A PCI-DSS compliant checkout', 'Fully HIPAA compliant storage', 'Our SOC2 attested platform']) {
    assert.equal(findClaims(claim).length, 1, claim);
  }
  assert.deepEqual(findClaims('Intro line\nTalk2Tax is ISO 27001 certified.'), [{ line: 2, kind: 'certification', text: 'Talk2Tax is ISO 27001 certified.' }]);
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

test('finds regulatory approval and compliance claims (RULE-007)', () => {
  for (const claim of [
    'Talk2Tax is a GSTN approved accounting platform.',
    'Approved by the Income Tax Department.',
    'Our e-invoicing is government certified.',
    'An RBI licensed payment flow.',
    'Payroll that is 100% compliant with Indian law.',
    'Fully GST compliant invoices, every time.',
    'We guarantee tax compliance.',
  ]) {
    assert.deepEqual(findClaims(claim).map((c) => c.kind), ['regulatory'], claim);
  }
});

test('finds live banking claims (RULE-006)', () => {
  for (const claim of ['Live bank feeds from 200 banks.', 'Real-time bank sync keeps balances current.', 'Talk2Tax connects directly to your bank.', 'Automatic bank feeds for every account.', 'A real-time feed from your bank.']) {
    assert.deepEqual(findClaims(claim).map((c) => c.kind), ['live-banking'], claim);
  }
});

test('lets regulatory and banking denials, conditions and ordinary words through', () => {
  for (const ok of [
    'There is no live bank feed: statements come from CSV files you download from your bank.',
    'Talk2Tax is not approved by the GSTN.',
    'Requirement TAX-027 allows government submission only through an approved GSP/ASP integration, which is not built.',
    'A direct connection needs an approved GSP integration.',
    'The journal was approved by the owner.',
    'GST returns are prepared from the books; you file them on the GST portal.',
    'Statutory bonus is worked out each year.',
  ]) {
    assert.deepEqual(findClaims(ok), [], ok);
  }
  assert.deepEqual(findClaims('## Not in this release\nLive bank feeds, OFX import.\n## Done\nLive bank feeds from every bank.'), [{ line: 4, kind: 'live-banking', text: 'Live bank feeds from every bank.' }]);
});

test('nothing a customer can read makes one of these claims today', () => {
  assert.deepEqual(scanRepository(), []);
});
