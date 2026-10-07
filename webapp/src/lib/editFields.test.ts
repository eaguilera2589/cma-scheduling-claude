import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isoDateToSheet,
  optionsWithCurrent,
  sheetDateToInput,
  sheetTimeToInput,
  syncStatusTone,
  timeInputToSheet,
} from './editFields';

test('isoDateToSheet: date-picker ISO -> sheet MM/DD/YYYY', () => {
  assert.equal(isoDateToSheet('2026-10-01'), '10/01/2026');
  assert.equal(isoDateToSheet('2026-02-30'), '', 'impossible day rejected');
  assert.equal(isoDateToSheet(''), '');
  assert.equal(isoDateToSheet('10/01/2026'), '', 'non-ISO rejected');
});

test('sheetDateToInput: sheet date -> date-picker ISO, "" when not parseable', () => {
  assert.equal(sheetDateToInput('10/01/2026'), '2026-10-01');
  assert.equal(sheetDateToInput('4/5/2026'), '2026-04-05');
  assert.equal(sheetDateToInput(''), '');
  assert.equal(sheetDateToInput('weird'), '');
});

test('timeInputToSheet: 24h time-picker value -> sheet H:MM AM/PM', () => {
  assert.equal(timeInputToSheet('16:00'), '4:00 PM');
  assert.equal(timeInputToSheet('09:30'), '9:30 AM');
  assert.equal(timeInputToSheet('00:05'), '12:05 AM', 'midnight hour');
  assert.equal(timeInputToSheet('12:00'), '12:00 PM', 'noon');
  assert.equal(timeInputToSheet('23:59'), '11:59 PM');
  assert.equal(timeInputToSheet(''), '');
  assert.equal(timeInputToSheet('24:00'), '');
  assert.equal(timeInputToSheet('16:60'), '');
});

test('sheetTimeToInput: sheet H:MM AM/PM -> 24h picker value, "" when not parseable', () => {
  assert.equal(sheetTimeToInput('4:00 PM'), '16:00');
  assert.equal(sheetTimeToInput('9:30 AM'), '09:30');
  assert.equal(sheetTimeToInput('12:05 AM'), '00:05');
  assert.equal(sheetTimeToInput('12:00 PM'), '12:00');
  assert.equal(sheetTimeToInput(''), '');
  assert.equal(sheetTimeToInput('later'), '');
});

test('picker conversions round-trip through the sheet format', () => {
  for (const sheet of ['12:05 AM', '9:30 AM', '12:00 PM', '4:00 PM', '11:59 PM']) {
    assert.equal(timeInputToSheet(sheetTimeToInput(sheet)), sheet);
  }
  for (const sheet of ['10/01/2026', '04/05/2026', '02/29/2024']) {
    assert.equal(isoDateToSheet(sheetDateToInput(sheet)), sheet);
  }
});

test('syncStatusTone', () => {
  assert.equal(syncStatusTone(''), 'empty');
  assert.equal(syncStatusTone('Ready to Sync'), 'ready');
  assert.equal(syncStatusTone('Synced'), 'synced');
  assert.equal(syncStatusTone('Error: bad contact type'), 'error');
  assert.equal(syncStatusTone('Something else'), 'other');
});

test('optionsWithCurrent keeps nonstandard current values selectable', () => {
  assert.deepEqual(optionsWithCurrent(['', 'Ready to Sync', 'Synced'], ''), ['', 'Ready to Sync', 'Synced']);
  assert.deepEqual(optionsWithCurrent(['', 'Ready to Sync', 'Synced'], 'Synced'), ['', 'Ready to Sync', 'Synced']);
  assert.deepEqual(optionsWithCurrent(['', 'Ready to Sync', 'Synced'], 'Error: x'), [
    '',
    'Ready to Sync',
    'Synced',
    'Error: x',
  ]);
});
