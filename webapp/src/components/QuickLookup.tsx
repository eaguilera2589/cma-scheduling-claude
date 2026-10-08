'use client';

/**
 * Phase 4 quick-lookup: pick a Case# from a dropdown and see the read-only
 * details the DB ingest surfaced (Policy #, Phone, Agent name/number) plus the
 * insured name. Operates purely on rows the board already loaded — no fetch.
 * The parent (InspectionsBoard) only renders this when rows actually carry
 * DB-only lookup data, so in sheet mode (those fields blank) the picker is
 * hidden entirely rather than showing an all-em-dash card.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Inspection } from '@/lib/types';

const DASH = '\u2014'; // em dash for missing values

/** Blank-safe display: "" / null / undefined all become "—". */
function show(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v === '' ? DASH : v;
}

export default function QuickLookup({ rows }: { rows: Inspection[] }) {
  const [selected, setSelected] = useState<string>('');

  // Option list is stable per row-set, drops blank-Case# rows (they'd collide
  // with the empty placeholder option), and is sorted numeric-aware so 10674154
  // sorts after 9999999, matching how a human reads case numbers.
  const sorted = useMemo(
    () =>
      rows
        .filter((r) => r.caseNumber.trim() !== '')
        .sort((a, b) =>
          a.caseNumber.localeCompare(b.caseNumber, 'en', { numeric: true })
        ),
    [rows]
  );

  // Keep the select and the card consistent if a reload drops the picked case.
  const selectedRow = useMemo(
    () => (selected ? rows.find((r) => r.caseNumber === selected) : undefined),
    [rows, selected]
  );
  useEffect(() => {
    if (selected && !selectedRow) setSelected('');
  }, [selected, selectedRow]);

  if (rows.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56">
          <label
            htmlFor="quick-lookup-case"
            className="block text-xs font-semibold uppercase tracking-wide text-slate-500"
          >
            Quick lookup by Case#
          </label>
          <select
            id="quick-lookup-case"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            <option value="">{DASH} Select a case {DASH}</option>
            {sorted.map((r) => (
              <option key={r.caseNumber} value={r.caseNumber}>
                {r.caseNumber}
                {r.insuredName ? ` \u2014 ${r.insuredName}` : ''}
              </option>
            ))}
          </select>
        </div>

        {selected && (
          <button
            type="button"
            onClick={() => setSelected('')}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-slate-900"
          >
            Clear
          </button>
        )}
      </div>

      {selectedRow && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-slate-200 pt-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Case #</dt>
            <dd className="mt-0.5 font-medium text-slate-900">{show(selectedRow.caseNumber)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Policy #</dt>
            <dd className="mt-0.5 text-slate-900">{show(selectedRow.policyNumber)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Insured name</dt>
            <dd className="mt-0.5 text-slate-900">{show(selectedRow.insuredName)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Phone</dt>
            <dd className="mt-0.5 text-slate-900">{show(selectedRow.phone)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Agent name</dt>
            <dd className="mt-0.5 text-slate-900">{show(selectedRow.agentName)}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Agent number</dt>
            <dd className="mt-0.5 text-slate-900">{show(selectedRow.agentNumber)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}
