import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasLookupData } from './lookup';
import { EMPTY_INSPECTION, type Inspection } from './types';

// A sheet-mode row: real Case#, but every DB-only field blank ("").
const sheetRow = (c: string): Inspection => ({ ...EMPTY_INSPECTION, caseNumber: c });

test('hasLookupData: false when no rows / all DB-only fields blank (sheet mode)', () => {
  assert.equal(hasLookupData([]), false, 'no rows');
  assert.equal(hasLookupData([sheetRow('100'), sheetRow('200')]), false, 'sheet mode -> picker hidden');
});

test('hasLookupData: true when any DB-only field is present on any row (db mode)', () => {
  assert.equal(hasLookupData([{ ...sheetRow('1'), policyNumber: 'P1' }]), true);
  assert.equal(hasLookupData([{ ...sheetRow('1'), phone: '555-1234' }]), true);
  assert.equal(hasLookupData([{ ...sheetRow('1'), agentName: 'Ann' }]), true);
  assert.equal(hasLookupData([{ ...sheetRow('1'), agentNumber: 'A7' }]), true);
  // Only one row needs data; the rest can be blank.
  assert.equal(hasLookupData([sheetRow('1'), { ...sheetRow('2'), phone: '555' }]), true);
});
