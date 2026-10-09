/**
 * Pure helpers for the sync-banner auto-clear loop (board UI batch spec).
 * Dependency-free so the board component and the node:test suite share the
 * exact completion/timeout rules — no component-test framework needed.
 */
import type { Inspection } from './types';

/** The literal the webapp writes and the n8n DB workflow selects on. */
export const READY_TO_SYNC = 'Ready to Sync';

/** True while any row still awaits the n8n sync workflow. */
export function hasReadySyncRows(rows: Inspection[]): boolean {
  return rows.some((r) => r.syncStatus === READY_TO_SYNC);
}

/** Poll cadence while the "sync in progress" banner is up. */
export const SYNC_POLL_INTERVAL_MS = 5_000;

/** Hard cap: after this long, stop polling and show a neutral notice instead. */
export const SYNC_POLL_TIMEOUT_MS = 5 * 60_000;

export type PollOutcome =
  /** No rows ready anymore — n8n finished; clear the banner, stop polling. */
  | 'complete'
  /** Still rows pending but past the cap; show the timeout notice, stop. */
  | 'timed-out'
  /** Keep waiting. */
  | 'continue';

/**
 * Decide what one poll tick means. Completion wins over the timeout cap; a
 * failed poll (rows === null) only ends the loop by hitting the cap.
 */
export function pollOutcome(nowMs: number, startedAtMs: number, rows: Inspection[] | null): PollOutcome {
  if (rows !== null && !hasReadySyncRows(rows)) return 'complete';
  if (nowMs - startedAtMs >= SYNC_POLL_TIMEOUT_MS) return 'timed-out';
  return 'continue';
}

/**
 * Generation guard for the poll loop. Clearing the interval does not cancel
 * an async tick already awaiting its fetch; when it resumes it would apply a
 * stale decision (banner setState + stopPolling) to whatever poller is live
 * now. Every start/stop advances a monotonic generation; a tick carries the
 * generation it was born under and must return — inert — once that
 * generation is no longer current.
 */
export interface PollGuard {
  /** Supersede every previous poller; returns the new poller's generation. */
  start(): number;
  /** Stop polling; makes the stopped poller's in-flight ticks inert too. */
  stop(): void;
  /** True when a tick born under `gen` belongs to a superseded/stopped poller. */
  isStale(gen: number): boolean;
}

/** Fresh guard; generations start at 0, so the first `start()` returns 1. */
export function createPollGuard(): PollGuard {
  let gen = 0;
  return {
    start: () => ++gen,
    stop: () => {
      gen += 1;
    },
    isStale: (tickGen: number) => tickGen !== gen,
  };
}
