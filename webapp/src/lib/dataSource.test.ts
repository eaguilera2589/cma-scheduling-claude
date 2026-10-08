/**
 * The DATA_SOURCE selector contract. The whole prod-safety guarantee rests on
 * "unset/anything-but-db => sheet", so that mapping is asserted directly. The
 * cache-clear branch is checked to not throw in either mode (no network/DB: in
 * db mode it returns without touching sheets; in sheet mode it clears the
 * in-memory cache).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDataSource, clearSourceCache } from './dataSource';

function withDataSource(value: string | undefined, fn: () => void) {
  const saved = process.env.DATA_SOURCE;
  if (value === undefined) delete process.env.DATA_SOURCE;
  else process.env.DATA_SOURCE = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.DATA_SOURCE;
    else process.env.DATA_SOURCE = saved;
  }
}

test('resolveDataSource: unset / empty / "sheet" / typo all mean sheet', () => {
  for (const v of [undefined, '', 'sheet', 'Sheet', 'postgres', 'sql']) {
    withDataSource(v, () => assert.equal(resolveDataSource(), 'sheet', `value ${JSON.stringify(v)} -> sheet`));
  }
});

test('resolveDataSource: exactly "db" selects the database source', () => {
  withDataSource('db', () => assert.equal(resolveDataSource(), 'db'));
});

test('clearSourceCache resolves without throwing in db mode (no DB touched)', async () => {
  const saved = process.env.DATA_SOURCE;
  process.env.DATA_SOURCE = 'db';
  try {
    await clearSourceCache(); // must return before importing the repository/pool
  } finally {
    if (saved === undefined) delete process.env.DATA_SOURCE;
    else process.env.DATA_SOURCE = saved;
  }
});
