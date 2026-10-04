import type { Inspection } from '@/lib/types';

/** Flag badges ("RUSH" / "ESCALATED") for a row, empty array if none. */
export function rowFlags(row: Inspection): string[] {
  const flags: string[] = [];
  if (row.rush.trim().toUpperCase() === 'Y') flags.push('Rush');
  if (row.escalated.trim().toUpperCase() === 'Y') flags.push('Escalated');
  return flags;
}
