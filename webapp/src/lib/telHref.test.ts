import { test } from 'node:test';
import assert from 'node:assert/strict';

import { telHref } from './telHref';

test('telHref: strips dashes and spaces to digits', () => {
  assert.equal(telHref('813-555-0100'), 'tel:8135550100');
});

test('telHref: preserves leading + and strips parens/spaces/dashes', () => {
  assert.equal(telHref('+1 (813) 555-0100'), 'tel:+18135550100');
});

test('telHref: empty or whitespace-only returns empty string', () => {
  assert.equal(telHref(''), '');
  assert.equal(telHref('   '), '');
});

test('telHref: digits-only passthrough', () => {
  assert.equal(telHref('8135550100'), 'tel:8135550100');
});

test('telHref: no digits at all returns empty string', () => {
  assert.equal(telHref('---'), '');
  assert.equal(telHref('N/A'), '');
});
