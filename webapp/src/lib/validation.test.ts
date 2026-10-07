import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalComments,
  canonicalContact,
  canonicalDate,
  canonicalSyncStatus,
  canonicalTime,
  canonicalYN,
  validateEditBody,
} from './validation';

test('canonicalYN: Y/N/blank, case-insensitive; anything else invalid', () => {
  assert.equal(canonicalYN(''), '');
  assert.equal(canonicalYN(' y '), 'Y');
  assert.equal(canonicalYN('N'), 'N');
  assert.equal(canonicalYN('yes'), null);
  assert.equal(canonicalYN('YY'), null);
});

test('canonicalDate: MM/DD/YYYY (or M/D/YYYY) canonicalized; blanks ok; junk/rollover rejected', () => {
  assert.equal(canonicalDate(''), '');
  assert.equal(canonicalDate('10/01/2026'), '10/01/2026');
  assert.equal(canonicalDate(' 4/5/2026 '), '04/05/2026');
  assert.equal(canonicalDate('2026-10-01'), null, 'ISO form is not the sheet format');
  assert.equal(canonicalDate('13/01/2026'), null);
  assert.equal(canonicalDate('02/30/2026'), null, 'impossible date rejected');
  assert.equal(canonicalDate('02/29/2025'), null, '2025 is not a leap year');
  assert.equal(canonicalDate('02/29/2024'), '02/29/2024', 'leap day accepted');
  assert.equal(canonicalDate('1/1/26'), null, 'two-digit year rejected');
});

test('canonicalTime: H:MM AM/PM canonicalized; blanks ok; junk rejected', () => {
  assert.equal(canonicalTime(''), '');
  assert.equal(canonicalTime('4:00 PM'), '4:00 PM');
  assert.equal(canonicalTime('4:00pm'), '4:00 PM');
  assert.equal(canonicalTime(' 04:00 pm '), '4:00 PM', 'padding stripped, casing canonical');
  assert.equal(canonicalTime('12:05 AM'), '12:05 AM');
  assert.equal(canonicalTime('12:00 PM'), '12:00 PM');
  assert.equal(canonicalTime('13:00 PM'), null, 'hour out of 12h range');
  assert.equal(canonicalTime('0:30 AM'), null, 'hour 0 not in 12h format');
  assert.equal(canonicalTime('4:60 PM'), null);
  assert.equal(canonicalTime('4:00'), null, 'AM/PM required');
  assert.equal(canonicalTime('4:00 XM'), null);
});

test('canonicalSyncStatus: blank / Ready to Sync / Synced / existing Error strings', () => {
  assert.equal(canonicalSyncStatus(''), '');
  assert.equal(canonicalSyncStatus('ready to sync'), 'Ready to Sync');
  assert.equal(canonicalSyncStatus(' READY TO SYNC '), 'Ready to Sync');
  assert.equal(canonicalSyncStatus('Synced'), 'Synced');
  assert.equal(canonicalSyncStatus('synced'), 'Synced');
  assert.equal(canonicalSyncStatus('Error: bad contact type'), 'Error: bad contact type');
  assert.equal(canonicalSyncStatus('error: bad contact type'), 'Error: bad contact type');
  assert.equal(canonicalSyncStatus('Error'), 'Error: ');
  assert.equal(canonicalSyncStatus('Pending'), null, 'arbitrary status rejected');
});

test('canonicalContact / canonicalComments: string bounds', () => {
  assert.equal(canonicalContact(' Insured '), 'Insured');
  assert.equal(canonicalContact('x'.repeat(101)), null);
  assert.equal(canonicalComments(' hi there \nthere '), 'hi there \nthere');
  assert.equal(canonicalComments('x'.repeat(5001)), null);
});

test('validateEditBody: accepts a subset and canonicalizes', () => {
  const res = validateEditBody({ date: '4/5/2026', syncStatus: 'ready to sync' });
  assert.ok(res.ok);
  assert.deepEqual(res.edits, { date: '04/05/2026', syncStatus: 'Ready to Sync' });
});

test('validateEditBody: full six-field body', () => {
  const res = validateEditBody({
    scheduleAppointmentYN: 'y',
    date: '10/05/2026',
    time: '2:30pm',
    attemptedToContact: 'Agent',
    comments: 'left voicemail',
    syncStatus: 'Ready to Sync',
  });
  assert.ok(res.ok);
  assert.deepEqual(res.edits, {
    scheduleAppointmentYN: 'Y',
    date: '10/05/2026',
    time: '2:30 PM',
    attemptedToContact: 'Agent',
    comments: 'left voicemail',
    syncStatus: 'Ready to Sync',
  });
});

test('validateEditBody: rejects bad shapes and values', () => {
  assert.equal(validateEditBody([]).ok, false);
  assert.equal(validateEditBody('nope').ok, false);
  assert.equal(validateEditBody(null).ok, false);
  assert.equal(validateEditBody({}).ok, false, 'empty body');

  const unknown = validateEditBody({ caseNumber: '123' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /caseNumber/);

  const nonString = validateEditBody({ date: 5 });
  assert.equal(nonString.ok, false);

  const badDate = validateEditBody({ date: 'tomorrow' });
  assert.equal(badDate.ok, false);

  const mixedBad = validateEditBody({ date: '10/05/2026', time: '99:99' });
  assert.equal(mixedBad.ok, false);
});
