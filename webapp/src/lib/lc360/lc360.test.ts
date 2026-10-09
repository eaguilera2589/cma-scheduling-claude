/**
 * Unit tests for the LC360 ingest client + repository. No network, no database:
 * the HTTP client's mapping/toDate are pure, and the upsert is exercised against
 * a fake Queryable that records the SQL it receives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCaseToColumns, toDate, type Lc360Case } from './client';
import { upsertLc360Cases } from './repository';
import type { Queryable } from '../db/caseRepository';

interface Recorded {
  sql: string;
  params?: unknown[];
}
function fake(handler: (sql: string) => Record<string, unknown>[]): { exec: Queryable; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const exec: Queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: handler(sql), rowCount: handler(sql).length };
    },
  };
  return { exec, calls };
}

test('toDate: /Date(ms)/, /Date(ms±tz)/, epoch ms, and blank all normalise to MM/DD/YYYY', () => {
  // 2026-09-02 UTC midnight -> depends on host tz; just assert the shape MM/DD/YYYY.
  assert.match(toDate('/Date(1757548800000)/'), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.match(toDate('/Date(1757548800000-0400)/'), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(toDate(null), '');
  assert.equal(toDate(''), '');
  assert.equal(toDate(undefined), '');
});

test('mapCaseToColumns: maps owned cols, applies toDate, stringifies booleans/numbers', () => {
  const c = {
    CaseID: '68b73b8d-5339-4ec0-9e63-e3a0e0c55838',
    CaseNumber: '2447386',
    InsuredName: 'Jane Doe',
    LocationAddress: '1 Main St',
    LocationCity: 'Tampa',
    LocationState: 'FL',
    InspectionDue: '/Date(1757548800000)/',
    DateScheduledFor: null,
    Rush: false,
    Escalated: true,
    SchedulingStatus: 0,
    CaseType: 'Property',
    PolicyNumber: 'AC4080004020',
    AgentName: 'Synergy LLC',
    AgentPhone: '7276567867',
    InsuredCellPhone: '(813) 659-6342',
    InsuredHomePhone: '555-0000',
    InsuredWorkPhone: '',
  };
  const m = mapCaseToColumns(c, 'Sutton');
  assert.equal(m.case_number, '2447386');
  assert.equal(m.caseid, '68b73b8d-5339-4ec0-9e63-e3a0e0c55838'); // raw PascalCase CaseID -> caseid
  assert.equal(m.insured_name, 'Jane Doe');
  assert.match(m.inspection_due, /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(m.date_scheduled_for, ''); // null date -> ""
  assert.equal(m.rush, 'FALSE'); // boolean false -> "FALSE"
  assert.equal(m.escalated, 'TRUE'); // boolean true -> "TRUE"
  assert.equal(m.scheduling_status, '0'); // number -> "0"
  assert.equal(m.policy_number, 'AC4080004020');
  assert.equal(m.agent_name, 'Synergy LLC');
  assert.equal(m.agent_number, '7276567867'); // from AgentPhone
  assert.equal(m.phone, '(813) 659-6342'); // Cell wins
  assert.equal(m.portal, 'Sutton');
});

test('mapCaseToColumns: phone precedence Cell -> Home -> Work', () => {
  const base = { CaseNumber: '1' };
  assert.equal(mapCaseToColumns({ ...base, InsuredCellPhone: 'C', InsuredHomePhone: 'H', InsuredWorkPhone: 'W' }, '').phone, 'C');
  assert.equal(mapCaseToColumns({ ...base, InsuredCellPhone: '', InsuredHomePhone: 'H', InsuredWorkPhone: 'W' }, '').phone, 'H');
  assert.equal(mapCaseToColumns({ ...base, InsuredCellPhone: '', InsuredHomePhone: '', InsuredWorkPhone: 'W' }, '').phone, 'W');
  assert.equal(mapCaseToColumns({ ...base, InsuredCellPhone: '', InsuredHomePhone: '', InsuredWorkPhone: '' }, '').phone, '');
});

test('upsertLc360Cases: blank input is a no-op', async () => {
  const { exec, calls } = fake(() => []);
  assert.deepEqual(await upsertLc360Cases([], exec), { inserted: 0, updated: 0 });
  assert.equal(calls.length, 0);
});

test('upsertLc360Cases: INSERT sets human-edit defaults but UPDATE never touches them', async () => {
  const row: Lc360Case = {
    case_number: '999',
    caseid: '11111111-2222-3333-4444-555555555555',
    insured_name: 'Jane Doe',
    location_address: '1 Main St',
    location_city: 'Tampa',
    location_state: 'FL',
    inspection_due: '09/02/2026',
    date_scheduled_for: '',
    portal: 'Preferred',
    rush: 'FALSE',
    escalated: '',
    scheduling_status: '0',
    case_type: 'Property',
    policy_number: 'AC1',
    phone: '555',
    agent_name: 'Agent',
    agent_number: '727',
  };
  const { exec, calls } = fake(() => [{ inserted: true }]);
  const result = await upsertLc360Cases([row], exec);
  assert.deepEqual(result, { inserted: 1, updated: 0 });

  const sql = calls[0].sql;
  const setClause = sql.slice(sql.indexOf('DO UPDATE SET') + 'DO UPDATE SET'.length, sql.indexOf('RETURNING'));

  // ON CONFLICT UPDATE must refresh LC360-owned columns...
  for (const owned of ['insured_name', 'policy_number', 'phone', 'agent_name', 'agent_number', 'portal', 'caseid']) {
    assert.ok(setClause.includes(`${owned} = EXCLUDED.${owned}`), `update must refresh ${owned}`);
  }
  // ...and must NOT touch any of the six human-edit columns.
  for (const human of ['schedule_appointment_yn', 'attempted_to_contact', 'comments', 'sync_status', '"date"', '"time"']) {
    assert.ok(!setClause.includes(human), `update must NOT touch human-edit column ${human}`);
  }
  // INSERT column list DOES include the human-edit columns (blank defaults).
  const insertList = sql.slice(sql.indexOf('INSERT INTO cases (') + 'INSERT INTO cases ('.length, sql.indexOf(') VALUES'));
  for (const human of ['schedule_appointment_yn', 'comments', 'sync_status', '"date"', '"time"', 'attempted_to_contact']) {
    assert.ok(insertList.includes(human), `insert must include ${human} for the blank default`);
  }
  // caseid is inserted (bound as a param) on fresh rows, too.
  assert.ok(insertList.includes('caseid'), 'insert must include caseid');
  assert.ok(calls[0].params?.includes('11111111-2222-3333-4444-555555555555'), 'caseid value must be bound as a param');
});

test('upsertLc360Cases: all values bound as params, never inlined', async () => {
  const row = {
    ...({} as Lc360Case),
    case_number: "9'; DROP",
    insured_name: "Robert'); DROP TABLE cases;--",
  } as Lc360Case;
  const { exec, calls } = fake(() => [{ inserted: false }]);
  const result = await upsertLc360Cases([row], exec);
  assert.deepEqual(result, { inserted: 0, updated: 1 });
  assert.ok(!calls[0].sql.includes('Robert'), 'value must not be interpolated into SQL');
  assert.ok(!calls[0].sql.includes('DROP'), 'value must not be interpolated into SQL');
  assert.ok(calls[0].params?.includes("Robert'); DROP TABLE cases;--"), 'value must be passed as a bound param');
});
