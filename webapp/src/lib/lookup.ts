/**
 * Helpers for the Phase 4 quick-lookup picker.
 * Pure and dependency-free (beyond lib/types) so both the board component and
 * the node:test suite share the exact mode-gating rule.
 */
import type { Inspection } from './types';

/**
 * True when at least one row carries DB-only lookup data (Policy #, Phone, or
 * Agent name/number). Those columns are always blank in sheet mode, so this is
 * false there and the picker is hidden — the "never show an all-em-dash card on
 * prod" guarantee is a data-driven mechanism, not a build-time policy.
 */
export function hasLookupData(rows: Inspection[]): boolean {
  return rows.some((r) => r.policyNumber || r.phone || r.agentName || r.agentNumber);
}
