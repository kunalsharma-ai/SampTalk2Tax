import { describe, expect, it } from 'vitest';
import { financialTagIssues, lineTagIssues } from '../src';

const location = { key: 'location', label: 'Location', isActive: true, values: [{ code: 'PUNE', name: 'Pune', isActive: true }, { code: 'GOA', name: 'Goa', isActive: false }] };

describe('financial tags', () => {
  it('are defined with a key, a name and coded values', () => {
    expect(financialTagIssues({ key: 'location', label: 'Location', values: [{ code: 'PUNE', name: 'Pune' }, { code: 'MUM-1', name: 'Mumbai' }] })).toEqual([]);
    expect(financialTagIssues({ key: 'Location', label: ' ', values: [{ code: 'pune', name: '' }, { code: 'X', name: 'X' }, { code: 'X', name: 'Again' }] })).toEqual([
      'The key is lower case letters, digits and _, starting with a letter, such as location',
      'Give the tag a name of 1 to 60 characters',
      'Value code pune: use capital letters, digits, - and _, up to 20 characters',
      'Value pune: give it a name',
      'Value code X is used twice',
    ]);
  });

  it('hold lines to the defined values, and leave undefined keys free', () => {
    expect(lineTagIssues([location], [{ dimensions: { location: 'PUNE', campaign: 'diwali' } }, {}, { dimensions: null }])).toEqual([]);
    expect(lineTagIssues([location], [{ dimensions: { location: 'DELHI' } }, { dimensions: { location: 'GOA' } }])).toEqual(['Line 1: DELHI is not a Location', 'Line 2: Location GOA is inactive']);
    expect(lineTagIssues([{ ...location, isActive: false }], [{ dimensions: { location: 'PUNE' } }])).toEqual(['Line 1: the Location tag is no longer used']);
  });
});
