/**
 * Unit tests for the sync-banner poll helpers. Pure logic only — the polling
 * loop itself lives in the board component (no component-test framework).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMPTY_INSPECTION, type Inspection } from './types';
import { createPollGuard, hasReadySyncRows, pollOutcome, SYNC_POLL_TIMEOUT_MS, type PollGuard } from './syncStatus';

function row(syncStatus: string): Inspection {
  return { ...EMPTY_INSPECTION, syncStatus };
}

test('hasReadySyncRows: exact "Ready to Sync" literal only', () => {
  assert.equal(hasReadySyncRows([]), false);
  assert.equal(hasReadySyncRows([row(''), row('Synced')]), false);
  assert.equal(hasReadySyncRows([row('Synced'), row('Error: boom')]), false);
  assert.equal(hasReadySyncRows([row('Synced'), row('Ready to Sync')]), true);
  // Case matters here: the editor writes this exact literal, and the n8n
  // SELECT lower()s; the banner predicate must match what we ourselves write.
  assert.equal(hasReadySyncRows([row('ready to sync')]), false);
});

test('pollOutcome: zero-ready clears on the FIRST tick', () => {
  assert.equal(pollOutcome(5_000, 0, []), 'complete');
  assert.equal(pollOutcome(5_000, 0, [row('Synced')]), 'complete');
});

test('pollOutcome: ready rows keep polling; completion wins over the cap', () => {
  assert.equal(pollOutcome(5_000, 0, [row('Ready to Sync')]), 'continue');
  assert.equal(pollOutcome(SYNC_POLL_TIMEOUT_MS - 1, 0, [row('Ready to Sync')]), 'continue');
  // At/past the cap: stop with the neutral notice.
  assert.equal(pollOutcome(SYNC_POLL_TIMEOUT_MS, 0, [row('Ready to Sync')]), 'timed-out');
  // But rows finishing at the cap still counts as complete (no false alarm).
  assert.equal(pollOutcome(SYNC_POLL_TIMEOUT_MS + 1_000, 0, [row('Synced')]), 'complete');
});

test('pollOutcome: a failed poll (null rows) only ends at the cap', () => {
  assert.equal(pollOutcome(10_000, 0, null), 'continue');
  assert.equal(pollOutcome(SYNC_POLL_TIMEOUT_MS, 0, null), 'timed-out');
});

test('createPollGuard: start/stop advance generations; only the newest is fresh', () => {
  const g = createPollGuard();
  const g1 = g.start();
  assert.equal(g.isStale(g1), false);
  const g2 = g.start();
  assert.equal(g.isStale(g1), true, 'superseded poller is stale');
  assert.equal(g.isStale(g2), false);
  g.stop();
  assert.equal(g.isStale(g2), true, 'a stopped poller in-flight tick is stale too');
  const g3 = g.start();
  assert.ok(g3 > g2, 'generations are monotonic');
  assert.equal(g.isStale(g3), false);
});

test('generation guard: re-click while a tick is in flight — new poller lives, stale tick is inert', () => {
  // Pure model of the board poll-loop control flow: startSyncPolling /
  // stopPolling / tick continuation. Mirrors the component orderings so the
  // interleaving bug reproduces here without a component-test framework.
  const log: string[] = [];
  let intervalAlive = false; // false between clear() and the next install
  let currentGen = -1; // generation of the LIVE poller, if any
  const guard: PollGuard = createPollGuard();
  const banner = { kind: 'busy' as 'busy' | 'idle' };

  const stopPolling = (by: string) => {
    intervalAlive = false; // clearInterval
    guard.stop();
    log.push(`stop:${by}`);
  };
  const startPolling = (by: string) => {
    stopPolling(by); // an overlapping poller is always superseded, never stacked
    currentGen = guard.start();
    intervalAlive = true;
  };
  // Tick continuation AFTER await load(), decided 'complete': setState + stop.
  const finishTick = (gen: number, id: string) => {
    if (guard.isStale(gen)) {
      log.push(`stale-tick:${id}`);
      return; // must not setState, must not stopPolling
    }
    banner.kind = 'idle';
    stopPolling(`tick:${id}`);
  };

  // 1) First Sync click → poller A; its tick fires and is awaiting load() …
  startPolling('A');
  const genA = currentGen;

  // 2) … while that fetch is in flight the user clicks Sync again:
  //    triggerSync's stopPolling + startSyncPolling → poller B takes over.
  startPolling('B');
  const genB = currentGen;
  assert.notEqual(genB, genA);
  assert.equal(intervalAlive, true, 'B interval installed');

  // 3) A stale continuation from the OLD poller finally resolves with 'idle'.
  finishTick(genA, 'A');

  // The old tick must be inert: B is still polling, the banner is untouched.
  assert.equal(intervalAlive, true, 'a stale tick must not kill the new poller');
  assert.equal(banner.kind, 'busy', 'a stale tick must not setState');
  assert.ok(!log.some((l) => l === 'stop:tick:A'), 'stale tick never stops the new loop');

  // 4) The NEW poller still works: its own completion clears the banner + stops.
  finishTick(genB, 'B');
  assert.equal(banner.kind, 'idle');
  assert.equal(intervalAlive, false);
});
