/**
 * Unit tests for the Postgres repository. No database: a fake Queryable records
 * the SQL + bound params and returns canned rows, so we can assert the
 * snake<->camel mapping, the parameterized write path (values NEVER inlined),
 * the not-found behavior, and the idempotent upsert shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getDbInspections,
  updateDbInspectionFields,
  upsertCases,
  type Queryable,
} from './caseRepository';
import { RowNotFoundError } from '../sheets';
import { EMPTY_INSPECTION, type Inspection } from '../types';

interface Recorded {
  sql: string;
  params?: unknown[];
}
function fake(
  handler: (sql: string, params?: unknown[]) => { rows?: Record<string, unknown>[]; rowCount?: number | null }
): { exec: Queryable; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const exec: Queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      const r = handler(sql, params);
      return { rows: r.rows ?? [], rowCount: r.rowCount ?? 0 };
    },
  };
  return { exec, calls };
}

test('getDbInspections maps snake_case columns to camelCase and nulls to ""', async () => {
  const { exec, calls } = fake(() => ({
    rows: [
      {
        case_number: '2386063',
        insured_name: 'Jane Doe',
        rush: 'FALSE',
        date: '10/01/2026',
        time: null, // NULL -> "" (a blank cell, not the literal "null")
        comments: null,
      },
    ],
  }));
  const rows = await getDbInspections(exec);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].caseNumber, '2386063');
  assert.equal(rows[0].insuredName, 'Jane Doe');
  assert.equal(rows[0].rush, 'FALSE');
  assert.equal(rows[0].date, '10/01/2026');
  assert.equal(rows[0].time, '');
  assert.equal(rows[0].comments, '');
  // Reserved words must be quoted in the SELECT list.
  assert.match(calls[0].sql, /"date"/);
  assert.match(calls[0].sql, /"time"/);
  assert.match(calls[0].sql, /FROM cases ORDER BY case_number/);
});

test('getDbInspections selects and maps the four DB-only fields (Phase 4)', async () => {
  const { exec, calls } = fake(() => ({
    rows: [
      {
        case_number: '10674154',
        policy_number: 'IMA426093C',
        phone: '813-695-9931',
        agent_name: 'Jaclyn Juron',
        agent_number: '(813)963-1669',
      },
      {
        // The "~2 cases with blank agent number": NULL must map to "", not crash.
        case_number: '10674809',
        policy_number: 'WS706590',
        phone: '863-701-2916',
        agent_name: 'Patricia McNamara',
        agent_number: null,
      },
    ],
  }));
  const rows = await getDbInspections(exec);

  // All four DB columns are in the SELECT list.
  for (const col of ['policy_number', 'phone', 'agent_name', 'agent_number']) {
    assert.ok(
      new RegExp(`(^|,|\\s)${col}($|,|\\s)`).test(calls[0].sql),
      `SELECT list must include ${col}`
    );
  }
  assert.equal(rows[0].policyNumber, 'IMA426093C');
  assert.equal(rows[0].phone, '813-695-9931');
  assert.equal(rows[0].agentName, 'Jaclyn Juron');
  assert.equal(rows[0].agentNumber, '(813)963-1669');
  assert.equal(rows[1].agentNumber, ''); // NULL -> ""
});

test('getDbInspections selects and maps caseid + last_synced (sync T1)', async () => {
  const { exec, calls } = fake(() => ({
    rows: [
      {
        case_number: '2447386',
        caseid: '68b73b8d-5339-4ec0-9e63-e3a0e0c55838',
        last_synced: '2026-10-08T18:00:00.000Z',
      },
      {
        // Backfilled rows may still predate the write-back: NULL -> "".
        case_number: '2447387',
        caseid: null,
        last_synced: null,
      },
    ],
  }));
  const rows = await getDbInspections(exec);

  // Both new columns must be in the SELECT list.
  assert.ok(calls[0].sql.includes('caseid'), 'SELECT list must include caseid');
  assert.ok(calls[0].sql.includes('last_synced'), 'SELECT list must include last_synced');
  assert.equal(rows[0].caseid, '68b73b8d-5339-4ec0-9e63-e3a0e0c55838');
  assert.equal(rows[0].lastSynced, '2026-10-08T18:00:00.000Z');
  assert.equal(rows[1].caseid, ''); // NULL -> ""
  assert.equal(rows[1].lastSynced, ''); // NULL -> ""
});

test('upsertCases never writes the DB-only columns (LC360-owned, migrate must not wipe)', async () => {
  const row: Inspection = {
    ...EMPTY_INSPECTION,
    caseNumber: '555',
    policyNumber: 'SHOULD-NOT-BE-WRITTEN',
    phone: 'nope',
    agentName: 'nope',
    agentNumber: 'nope',
    caseid: 'SHOULD-NOT-BE-WRITTEN-GUID',
    lastSynced: '2026-10-08T18:00:00.000Z',
  };
  const { exec, calls } = fake(() => ({ rows: [], rowCount: 1 }));
  await upsertCases([row], exec);

  for (const col of ['policy_number', 'agent_name', 'agent_number', 'caseid', 'last_synced']) {
    assert.ok(!calls[0].sql.includes(col), `upsert SQL must not touch ${col}`);
  }
  // `phone` is also a substring of nothing else here, but check precisely:
  assert.ok(!/[(,]\s*phone\s*[=,)]/.test(calls[0].sql), 'upsert SQL must not touch the phone column');
  assert.ok(!calls[0].params?.includes('SHOULD-NOT-BE-WRITTEN'), 'values must not be bound either');
  assert.ok(!calls[0].params?.includes('SHOULD-NOT-BE-WRITTEN-GUID'), 'caseid value must not be bound either');
});

test('updateDbInspectionFields binds values as params (never inlined) and returns rowNumber 0', async () => {
  const { exec, calls } = fake(() => ({ rows: [{ case_number: '123' }], rowCount: 1 }));
  const result = await updateDbInspectionFields('123', { date: '10/05/2026', comments: "Robert'); DROP" }, exec);

  assert.deepEqual(result, { caseNumber: '123', rowNumber: 0, writtenFields: ['date', 'comments'] });
  assert.equal(calls[0].sql, 'UPDATE cases SET "date" = $1, comments = $2 WHERE case_number = $3 RETURNING case_number');
  assert.deepEqual(calls[0].params, ['10/05/2026', "Robert'); DROP", '123']);
  // Injection guard: the raw value must never appear inside the SQL text.
  assert.ok(!calls[0].sql.includes('Robert'), 'user value must not be interpolated into SQL');
  assert.ok(!calls[0].sql.includes('10/05/2026'), 'user value must not be interpolated into SQL');
});

test('updateDbInspectionFields: no matching row throws RowNotFoundError', async () => {
  const { exec } = fake(() => ({ rows: [], rowCount: 0 }));
  await assert.rejects(() => updateDbInspectionFields('999', { comments: 'x' }, exec), RowNotFoundError);
});

test('updateDbInspectionFields: empty edits / empty caseNumber fail before any query', async () => {
  let queried = false;
  const exec: Queryable = { async query() { queried = true; return { rows: [], rowCount: 0 }; } };
  await assert.rejects(() => updateDbInspectionFields('123', {}, exec), /no field edits/);
  await assert.rejects(() => updateDbInspectionFields('   ', { comments: 'x' }, exec), /required/);
  assert.equal(queried, false);
});

test('upsertCases builds an ON CONFLICT upsert binding every field as a param', async () => {
  const row: Inspection = { ...EMPTY_INSPECTION, caseNumber: '555', insuredName: 'Ann', date: '01/02/2026' };
  const { exec, calls } = fake(() => ({ rows: [], rowCount: 1 }));
  const written = await upsertCases([row], exec);

  assert.equal(written, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO cases \(case_number, [\s\S]*\) VALUES \(\$1, \$2, \$3,/);
  assert.match(calls[0].sql, /ON CONFLICT \(case_number\) DO UPDATE SET/);
  // Values are params, never SQL text.
  assert.ok(calls[0].params?.includes('555'));
  assert.ok(calls[0].params?.includes('Ann'));
  assert.ok(!calls[0].sql.includes('Ann'));
});

test('upsertCases([]) issues no query and writes nothing', async () => {
  const { exec, calls } = fake(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await upsertCases([], exec), 0);
  assert.equal(calls.length, 0);
});
