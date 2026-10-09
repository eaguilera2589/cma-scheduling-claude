/**
 * Unit tests for the sheet write layer. The Google client is faked — nothing
 * here talks to Google. The header row fixture is the verbatim row 1 of the
 * live Inspections tab (captured 2026-10-06), so the expected A1 ranges
 * double as proof the field→column mapping matches production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RowNotFoundError,
  planInspectionUpdate,
  rowsToInspections,
  updateInspectionFields,
  type SheetsClientLike,
} from './sheets';

/** Live row 1, verbatim (52 columns; edit columns land at AP..AU = idx 41..46). */
const LIVE_HEADER = [
  'CaseNumber', 'CaseID', 'PolicyNumber', 'CaseStatus', 'SchedulingStatus', 'CaseType',
  'Customer', 'InsuredName', 'LocationAddress', 'LocationCity', 'LocationState',
  'LocationPostalCode', 'LocationCounty', 'InsuredHomePhone', 'InsuredWorkPhone',
  'InsuredCellPhone', 'InsuredEmail', 'AgentName', 'AgentPhone', 'Underwriter',
  'FieldRep', 'Ordered', 'Assigned', 'InspectionDue', 'Due', 'Completed',
  'DateScheduledFor', 'DateScheduledOn', 'PlannedFor', 'LastCalledOn',
  'NumberOfContactAttempts', 'LastContactAttemptName', 'DaysAssigned',
  'InspectionDueDays', 'PayAmount', 'TotalRecs', 'OpenCriticalRecs', 'Rush',
  'Escalated', 'Case Link', 'Last Synced',
  // Human-edit columns:
  'Schedule Appointment (Y/N)', 'Date', 'Time', 'Attempted to Contact',
  'Comments', 'Sync Status',
  'Portal', 'PolicyContactName', 'NeedsScheduling', 'DateLastContactAttempt',
  'Days Until Due',
];

const COL = Object.fromEntries(LIVE_HEADER.map((h, i) => [h, i]));

/** A data row with only a few cells set; the rest blank. */
function row(patches: Record<string, string>): string[] {
  const cells: string[] = new Array(LIVE_HEADER.length).fill('');
  for (const [header, value] of Object.entries(patches)) cells[COL[header]] = value;
  return cells;
}

const BLANK_ROW: string[] = new Array(LIVE_HEADER.length).fill('');

/**
 * Grid mirroring the live sheet's shape: header, five all-blank rows, then
 * data starting at grid row 7 — the blank rows must NOT shift row addressing.
 */
function grid(): string[][] {
  return [
    LIVE_HEADER,
    BLANK_ROW, BLANK_ROW, BLANK_ROW, BLANK_ROW, BLANK_ROW,
    row({
      CaseNumber: '2386063',
      InsuredName: 'Jane Doe',
      InspectionDue: '10/15/2026',
      PolicyContactName: 'Jim Client',
      'Schedule Appointment (Y/N)': 'Y',
      Date: '10/01/2026',
      Time: '9:00 AM',
      'Attempted to Contact': 'Insured',
      Comments: 'first attempt',
      'Sync Status': 'Synced',
    }),
    BLANK_ROW,
    row({
      CaseNumber: '2412564',
      InsuredName: 'John Roe',
      InspectionDue: '10/20/2026',
      'Sync Status': '',
    }),
  ];
}

test('sheet mode leaves the four DB-only Phase 4 fields blank (no header maps to them)', () => {
  // The sheet has raw LC360 columns like "PolicyNumber"/"AgentName", but
  // HEADER_TO_FIELD maps none of them to policyNumber/phone/agentName/
  // agentNumber — so a sheet read must not error and the fields must be "".
  const rows = rowsToInspections(grid());
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.policyNumber ?? '', '');
    assert.equal(r.phone ?? '', '');
    assert.equal(r.agentName ?? '', '');
    assert.equal(r.agentNumber ?? '', '');
  }
});

test('rowsToInspections maps the PolicyContactName header to contactAtInsured', () => {
  const rows = rowsToInspections(grid());
  assert.equal(rows[0].contactAtInsured, 'Jim Client'); // live header is mapped
  assert.equal(rows[1].contactAtInsured, ''); // blank cell -> ""
});

test('contactAtInsured stays blank on an odd sheet lacking the PolicyContactName header', () => {
  // HEADER_TO_FIELD missing-key tolerance: no crash, field comes back "".
  const header = LIVE_HEADER.filter((h) => h !== 'PolicyContactName');
  const rows = rowsToInspections([header, ['2386063', 'JANE-DOE-GUID']]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].caseNumber, '2386063');
  assert.equal(rows[0].contactAtInsured ?? '', '');
});

test('rowsToInspections reads the six human-edit fields from the human headers', () => {
  const rows = rowsToInspections(grid());
  assert.equal(rows.length, 2, 'blank rows skipped');
  assert.deepEqual(
    {
      scheduleAppointmentYN: rows[0].scheduleAppointmentYN,
      date: rows[0].date,
      time: rows[0].time,
      attemptedToContact: rows[0].attemptedToContact,
      comments: rows[0].comments,
      syncStatus: rows[0].syncStatus,
    },
    {
      scheduleAppointmentYN: 'Y',
      date: '10/01/2026',
      time: '9:00 AM',
      attemptedToContact: 'Insured',
      comments: 'first attempt',
      syncStatus: 'Synced',
    }
  );
  assert.equal(rows[1].syncStatus, '');
  assert.equal(rows[1].date, '');
});

test('planInspectionUpdate maps the 6 edit fields to their live column letters', () => {
  const edits = {
    scheduleAppointmentYN: 'Y',
    date: '10/05/2026',
    time: '4:00 PM',
    attemptedToContact: 'Agent',
    comments: 'left voicemail',
    syncStatus: 'Ready to Sync',
  };
  const plan = planInspectionUpdate(grid(), 'Inspections', '2386063', edits);

  assert.equal(plan.rowNumber, 7);
  assert.deepEqual(plan.updates, [
    { field: 'scheduleAppointmentYN', a1: 'Inspections!AP7', value: 'Y' },
    { field: 'date', a1: 'Inspections!AQ7', value: '10/05/2026' },
    { field: 'time', a1: 'Inspections!AR7', value: '4:00 PM' },
    { field: 'attemptedToContact', a1: 'Inspections!AS7', value: 'Agent' },
    { field: 'comments', a1: 'Inspections!AT7', value: 'left voicemail' },
    { field: 'syncStatus', a1: 'Inspections!AU7', value: 'Ready to Sync' },
  ]);
});

test('planInspectionUpdate writes only the targeted edit cells of the matched row', () => {
  const plan = planInspectionUpdate(grid(), 'Inspections', '2412564', {
    date: '11/02/2026',
    syncStatus: 'Ready to Sync',
  });
  assert.equal(plan.rowNumber, 9);
  assert.equal(plan.updates.length, 2, 'only the two edited fields are addressed');
  assert.deepEqual(plan.updates.map((u) => u.a1), ['Inspections!AQ9', 'Inspections!AU9']);

  const readColumnLetters = ['A', 'H', 'I', 'X', 'AA', 'AV']; // CaseNumber, Insured, …, Portal
  for (const u of plan.updates) {
    const letter = /!([A-Z]+)\d+$/.exec(u.a1)?.[1] ?? '';
    assert.ok(!readColumnLetters.includes(letter), `must not touch read column ${letter}`);
  }
});

test('planInspectionUpdate: unknown CaseNumber throws RowNotFoundError', () => {
  assert.throws(
    () => planInspectionUpdate(grid(), 'Inspections', '9999999', { date: '10/05/2026' }),
    RowNotFoundError
  );
});

test('planInspectionUpdate: missing edit-column header fails loudly', () => {
  const noComments = grid().map((r) => r.filter((_, i) => i !== COL['Comments']));
  assert.throws(
    () => planInspectionUpdate(noComments, 'Inspections', '2386063', { comments: 'hi' }),
    /Comments/
  );
});

test('planInspectionUpdate quotes sheet titles that need quoting', () => {
  const plan = planInspectionUpdate(grid(), 'My Tab', '2386063', { date: '10/05/2026' });
  assert.equal(plan.updates[0].a1, `'My Tab'!AQ7`);
});

/** Fake Google client that records writes and serves a fixed grid. */
function fakeClient(values: string[][]) {
  const updates: { range: string; requestBody: { values: string[][] }; valueInputOption: string }[] = [];
  const client: SheetsClientLike = {
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [
              { properties: { title: 'Inspections', gridProperties: { rowCount: 1012, columnCount: 52 } } },
            ],
          },
        };
      },
      values: {
        async get() {
          return { data: { values } };
        },
        async update(params) {
          // Read through requestBody.values — the shape the real googleapis
          // client requires. A revert to a top-level `values:` param makes
          // this throw (requestBody undefined), failing the test.
          updates.push({
            range: params.range,
            requestBody: { values: params.requestBody.values },
            valueInputOption: params.valueInputOption,
          });
          return {};
        },
      },
    },
  };
  return { client, updates };
}

test('updateInspectionFields writes only human-edit cells via values.update (RAW)', async () => {
  const prevSheetId = process.env.SHEET_ID;
  process.env.SHEET_ID = 'test-sheet';
  try {
    const { client, updates } = fakeClient(grid());
    const result = await updateInspectionFields(
      '2386063',
      { date: '10/05/2026', time: '2:30 PM', syncStatus: 'Ready to Sync' },
      client
    );

    assert.deepEqual(result, {
      caseNumber: '2386063',
      rowNumber: 7,
      writtenFields: ['date', 'time', 'syncStatus'],
    });
    assert.deepEqual(updates, [
      { range: 'Inspections!AQ7', requestBody: { values: [['10/05/2026']] }, valueInputOption: 'RAW' },
      { range: 'Inspections!AR7', requestBody: { values: [['2:30 PM']] }, valueInputOption: 'RAW' },
      { range: 'Inspections!AU7', requestBody: { values: [['Ready to Sync']] }, valueInputOption: 'RAW' },
    ]);
  } finally {
    if (prevSheetId === undefined) delete process.env.SHEET_ID;
    else process.env.SHEET_ID = prevSheetId;
  }
});

test('updateInspectionFields: missing case surfaces RowNotFoundError without writing', async () => {
  const prevSheetId = process.env.SHEET_ID;
  process.env.SHEET_ID = 'test-sheet';
  try {
    const { client, updates } = fakeClient(grid());
    await assert.rejects(
      () => updateInspectionFields('00000000', { syncStatus: 'Ready to Sync' }, client),
      RowNotFoundError
    );
    assert.deepEqual(updates, [], 'no write attempted for unmatched case');
  } finally {
    if (prevSheetId === undefined) delete process.env.SHEET_ID;
    else process.env.SHEET_ID = prevSheetId;
  }
});
