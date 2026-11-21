/** RULE-017: the licence and competitor-code check. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCompetitorNotices, licenceAllowed, scanPackages, scanSources } from './check-licences.mjs';

test('allows permissive licences and refuses closed or strong copyleft ones', () => {
  for (const [name, l] of [['a', 'MIT'], ['a', 'Apache-2.0 AND MIT'], ['a', '(MIT OR GPL-3.0)'], ['a', 'MPL-2.0'], ['@img/sharp-libvips-linux-x64', 'LGPL-3.0-or-later'], ['caniuse-lite', 'CC-BY-4.0']]) assert.ok(licenceAllowed(name, l), `${name} ${l}`);
  for (const [name, l] of [['a', 'GPL-3.0'], ['a', 'AGPL-3.0'], ['a', 'SSPL-1.0'], ['a', 'BUSL-1.1'], ['a', 'UNLICENSED'], ['a', 'Unknown'], ['a', 'SEE LICENSE IN LICENSE.txt'], ['a', 'MIT AND GPL-2.0'], ['other-lib', 'LGPL-3.0-or-later'], ['other-data', 'CC-BY-4.0']]) assert.ok(!licenceAllowed(name, l), `${name} ${l}`);
});

test('finds competitor copyright notices and lets ordinary mentions through', () => {
  for (const bad of ['// Copyright (c) 2021 Intuit Inc.', ' * © Xero Limited', '/* Zoho Corporation. All rights reserved. */', '// Oracle NetSuite proprietary and confidential']) assert.equal(findCompetitorNotices(bad).length, 1, bad);
  for (const ok of ['// Import a chart of accounts exported from QuickBooks or Tally.', "label: 'Xero CSV'", '// Copyright (c) 2026 Talk2Tax']) assert.deepEqual(findCompetitorNotices(ok), [], ok);
});

test('the repository has no competitor code and no disallowed licence', () => {
  assert.deepEqual(scanSources(), []);
  assert.deepEqual(scanPackages(), []);
});
