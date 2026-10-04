'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Inspection } from '@/lib/types';
import { sortInspections, type SortKey, type SortSpec } from '@/lib/sorting';
import InspectionTable from './InspectionTable';
import InspectionCards from './InspectionCards';

type Tab = 'needs' | 'scheduled';

const TABS: { id: Tab; label: string }[] = [
  { id: 'needs', label: 'Needs Scheduling' },
  { id: 'scheduled', label: 'Scheduled' },
];

function needsScheduling(row: Inspection): boolean {
  return row.dateScheduledFor.trim() === '';
}

export default function InspectionsBoard() {
  const [tab, setTab] = useState<Tab>('needs');
  const [rows, setRows] = useState<Inspection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortSpec>({ key: 'inspectionDue', dir: 'asc' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/inspections', { cache: 'no-store' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with status ${res.status}`);
        }
        const data = (await res.json()) as Inspection[];
        if (!cancelled) setRows(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const all = useMemo(() => rows ?? [], [rows]);
  const needsCount = useMemo(() => all.filter(needsScheduling).length, [all]);

  const visible = useMemo(() => {
    const filtered =
      tab === 'needs' ? all.filter(needsScheduling) : all.filter((r) => !needsScheduling(r));
    return sortInspections(filtered, sort);
  }, [all, tab, sort]);

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  }

  const counts: Record<Tab, number> = { needs: needsCount, scheduled: all.length - needsCount };

  return (
    <div className="space-y-4">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          Could not load inspections: {error}
        </div>
      )}

      {rows === null && !error && (
        <p className="text-sm text-slate-500">Loading inspections…</p>
      )}

      <div
        role="tablist"
        aria-label="Inspection views"
        className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t.label}
            <span className={`ml-1.5 text-xs ${tab === t.id ? 'text-slate-300' : 'text-slate-400'}`}>
              {counts[t.id]}
            </span>
          </button>
        ))}
      </div>

      {rows !== null && (
        <p className="text-sm text-slate-500">
          Showing {visible.length} inspection{visible.length === 1 ? '' : 's'}
        </p>
      )}

      {rows !== null &&
        (visible.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No inspections in this view.
          </p>
        ) : (
          <>
            <InspectionTable rows={visible} sort={sort} onSort={toggleSort} mode={tab} />
            <InspectionCards rows={visible} mode={tab} />
          </>
        ))}
    </div>
  );
}
