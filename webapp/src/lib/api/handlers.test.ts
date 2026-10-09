/**
 * Route-handler tests against the injectable-deps factories — no Next server,
 * no Google writes, no n8n. Covers: PATCH validation/status codes, update +
 * cache-bust wiring, and the sync trigger's env-only config + header forwarding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makePatchInspectionHandler,
  makeSyncHandler,
  type RouteContext,
} from './handlers';
import { RowNotFoundError, type SheetsClientLike } from '../sheets';
import type { SixEditFields } from '../types';

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/inspections/2386063', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function ctx(caseNumber: string): RouteContext<{ caseNumber: string }> {
  return { params: Promise.resolve({ caseNumber }) };
}

function recorder() {
  const calls: { caseNumber: string; edits: Partial<SixEditFields> }[] = [];
  let cacheCleared = 0;
  return {
    calls,
    get cacheCleared() {
      return cacheCleared;
    },
    deps: {
      update: async (caseNumber: string, edits: Partial<SixEditFields>, _client?: SheetsClientLike) => {
        calls.push({ caseNumber, edits });
        return { caseNumber, rowNumber: 7, writtenFields: Object.keys(edits) as (keyof SixEditFields)[] };
      },
      clearCache: () => {
        cacheCleared++;
      },
    },
  };
}

test('PATCH valid body: 200, update called with canonical edits, cache busted', async () => {
  const r = recorder();
  const PATCH = makePatchInspectionHandler(r.deps);
  const res = await PATCH(
    patchRequest({ date: '4/5/2026', time: '2:30pm', syncStatus: 'ready to sync' }),
    ctx('2386063')
  );

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json.updated, { date: '04/05/2026', time: '2:30 PM', syncStatus: 'Ready to Sync' });
  assert.equal(json.caseNumber, '2386063');

  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].caseNumber, '2386063');
  assert.deepEqual(r.calls[0].edits, { date: '04/05/2026', time: '2:30 PM', syncStatus: 'Ready to Sync' });
  assert.equal(r.cacheCleared, 1);
});

test('PATCH invalid values: 4xx and nothing written, no cache bust', async () => {
  const cases: unknown[] = [
    { date: 'tomorrow' },
    { date: '02/30/2026' },
    { time: '25:00' },
    { scheduleAppointmentYN: 'maybe' },
    { syncStatus: 'Almost done' },
    { unexpectedField: 'x' },
    { date: 5 },
    {},
    'not json',
    [],
  ];
  for (const body of cases) {
    const r = recorder();
    const PATCH = makePatchInspectionHandler(r.deps);
    const res = await PATCH(patchRequest(body), ctx('2386063'));
    assert.ok(res.status >= 400 && res.status < 500, `body ${JSON.stringify(body)} -> ${res.status}`);
    assert.equal(r.calls.length, 0, 'no write for invalid body');
    assert.equal(r.cacheCleared, 0);
  }
});

test('PATCH unknown CaseNumber: 404', async () => {
  const r = recorder();
  const PATCH = makePatchInspectionHandler({
    ...r.deps,
    update: async (caseNumber: string) => {
      throw new RowNotFoundError(caseNumber);
    },
  });
  const res = await PATCH(patchRequest({ syncStatus: 'Ready to Sync' }), ctx('9999999'));
  assert.equal(res.status, 404);
  assert.equal(r.cacheCleared, 0);
});

test('PATCH sheet-access failure: 500 with underlying message in detail, no cache bust', async () => {
  const r = recorder();
  const PATCH = makePatchInspectionHandler({
    ...r.deps,
    update: async () => {
      throw new Error('quota');
    },
  });
  const res = await PATCH(patchRequest({ comments: 'hello' }), ctx('2386063'));
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.error, 'Failed to write the update to the Google Sheet.');
  assert.equal(json.detail, 'quota', 'underlying error message surfaced for debugging');
  assert.equal(r.cacheCleared, 0);
});

test('PATCH generic failure: non-Error throw is stringified into detail', async () => {
  const r = recorder();
  const PATCH = makePatchInspectionHandler({
    ...r.deps,
    update: async () => {
      throw 'boom'; // non-Error rejection: String(err) must still surface
    },
  });
  const res = await PATCH(patchRequest({ comments: 'hello' }), ctx('2386063'));
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.detail, 'boom');
});

test('PATCH empty caseNumber: 400', async () => {
  const r = recorder();
  const PATCH = makePatchInspectionHandler(r.deps);
  const res = await PATCH(patchRequest({ comments: 'hello' }), ctx('   '));
  assert.equal(res.status, 400);
  assert.equal(r.calls.length, 0);
});

// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
}

function syncDeps(response: { ok: boolean; status: number }, opts: { throws?: boolean } = {}) {
  const calls: FetchCall[] = [];
  let cacheCleared = 0;
  const deps = {
    fetch: (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: init as FetchCall['init'] });
      if (opts.throws) throw new TypeError('ECONNREFUSED');
      return {
        ok: response.ok,
        status: response.status,
        text: async () => 'upstream said no',
      };
    }) as unknown as typeof fetch,
    clearCache: () => {
      cacheCleared++;
    },
  };
  return { deps, calls, get cacheCleared() { return cacheCleared; } };
}

function withEnv(
  url: string | undefined,
  secret: string | undefined,
  fn: () => Promise<void>,
  extra: { dataSource?: string; dbUrl?: string } = {}
) {
  const savedUrl = process.env.N8N_WEBHOOK_URL;
  const savedSecret = process.env.N8N_SYNC_SECRET;
  const savedDataSource = process.env.DATA_SOURCE;
  const savedDbUrl = process.env.N8N_WEBHOOK_URL_DB;
  if (url === undefined) delete process.env.N8N_WEBHOOK_URL;
  else process.env.N8N_WEBHOOK_URL = url;
  if (secret === undefined) delete process.env.N8N_SYNC_SECRET;
  else process.env.N8N_SYNC_SECRET = secret;
  // Sync-target tests must be deterministic regardless of the ambient env:
  // DATA_SOURCE and N8N_WEBHOOK_URL_DB default to unset unless requested.
  if (extra.dataSource === undefined) delete process.env.DATA_SOURCE;
  else process.env.DATA_SOURCE = extra.dataSource;
  if (extra.dbUrl === undefined) delete process.env.N8N_WEBHOOK_URL_DB;
  else process.env.N8N_WEBHOOK_URL_DB = extra.dbUrl;
  return fn().finally(() => {
    if (savedUrl === undefined) delete process.env.N8N_WEBHOOK_URL;
    else process.env.N8N_WEBHOOK_URL = savedUrl;
    if (savedSecret === undefined) delete process.env.N8N_SYNC_SECRET;
    else process.env.N8N_SYNC_SECRET = savedSecret;
    if (savedDataSource === undefined) delete process.env.DATA_SOURCE;
    else process.env.DATA_SOURCE = savedDataSource;
    if (savedDbUrl === undefined) delete process.env.N8N_WEBHOOK_URL_DB;
    else process.env.N8N_WEBHOOK_URL_DB = savedDbUrl;
  });
}

test('POST /api/sync: 503 when N8N_WEBHOOK_URL is unset, webhook not called', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv(undefined, undefined, async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.match(json.error, /N8N_WEBHOOK_URL/);
  });
  assert.equal(d.calls.length, 0);
});

test('POST /api/sync: forwards POST + x-sync-secret, 202 + cache bust on 2xx', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv('http://n8n.local/webhook/cma-sync', 'shhh-secret', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.match(json.message, /Ready to Sync/);
  });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, 'http://n8n.local/webhook/cma-sync');
  assert.equal(d.calls[0].init?.method, 'POST');
  assert.equal(d.calls[0].init?.headers?.['x-sync-secret'], 'shhh-secret');
  assert.equal(d.cacheCleared, 1);
});

test('POST /api/sync: non-2xx from n8n → 502, no cache bust', async () => {
  const d = syncDeps({ ok: false, status: 403 });
  await withEnv('http://n8n.local/webhook/cma-sync', 'wrong-secret', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 502);
  });
  assert.equal(d.cacheCleared, 0);
});

test('POST /api/sync: unreachable webhook → 502', async () => {
  const d = syncDeps({ ok: false, status: 0 }, { throws: true });
  await withEnv('http://n8n.local/webhook/cma-sync', 'shhh', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 502);
  });
});

// ---------------------------------------------------------------------------
// DB-mode sync targeting (cutover T3): DATA_SOURCE=db must fire the
// lc360-sync-db workflow; sheet mode must hit N8N_WEBHOOK_URL unchanged.

const SHEET_URL = 'http://n8n.local:5678/webhook/lc360-sync';
const DB_URL = 'http://n8n.local:5678/webhook/lc360-sync-db';

test('POST /api/sync: db mode with N8N_WEBHOOK_URL_DB set → posts to the DB URL', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv(SHEET_URL, 'shhh', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 202);
  }, { dataSource: 'db', dbUrl: DB_URL });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, DB_URL, 'DB mode must target the explicit lc360-sync-db URL');
  assert.equal(d.calls[0].init?.method, 'POST');
  assert.equal(d.calls[0].init?.headers?.['x-sync-secret'], 'shhh', 'same shared secret header');
});

test('POST /api/sync: db mode without override → derives lc360-sync-db from N8N_WEBHOOK_URL', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv(SHEET_URL, 'shhh', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 202);
  }, { dataSource: 'db' });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, DB_URL, 'trailing lc360-sync segment must swap to lc360-sync-db');
});

test('POST /api/sync: db mode cannot derive (non-lc360-sync URL, no override) → 503, webhook untouched', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv('http://n8n.local:5678/webhook/some-other-hook', 'shhh', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.match(json.error, /N8N_WEBHOOK_URL_DB/);
  }, { dataSource: 'db' });
  assert.equal(d.calls.length, 0, 'must never fall back to the sheet webhook in db mode');
});

test('POST /api/sync: sheet mode posts to N8N_WEBHOOK_URL unchanged, even if N8N_WEBHOOK_URL_DB is set', async () => {
  const d = syncDeps({ ok: true, status: 200 });
  await withEnv(SHEET_URL, 'shhh', async () => {
    const res = await makeSyncHandler(d.deps)();
    assert.equal(res.status, 202);
  }, { dataSource: 'sheet', dbUrl: DB_URL });
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0].url, SHEET_URL, 'sheet mode ignores the DB override entirely');
});
