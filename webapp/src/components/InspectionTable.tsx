import type { Inspection } from '@/lib/types';
import type { SortKey, SortSpec } from '@/lib/sorting';
import DueDate from './DueDate';
import FlagBadge from './FlagBadge';
import { rowFlags } from './flags';

interface Props {
  rows: Inspection[];
  sort: SortSpec;
  onSort: (key: SortKey) => void;
  /** "scheduled" adds a (non-sortable) Scheduled column. */
  mode: 'needs' | 'scheduled';
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'caseNumber', label: 'Case #' },
  { key: 'insuredName', label: 'Insured' },
  { key: 'locationAddress', label: 'Address' },
  { key: 'locationCity', label: 'City/State' },
  { key: 'inspectionDue', label: 'Due' },
  { key: 'portal', label: 'Portal' },
];

function SortHeader({
  label,
  colKey,
  sort,
  onSort,
}: {
  label: string;
  colKey: SortKey;
  sort: SortSpec;
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === colKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
    >
      <button
        type="button"
        onClick={() => onSort(colKey)}
        className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? 'text-slate-900' : ''}`}
      >
        {label}
        <span aria-hidden className="w-3 text-[10px]">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}
        </span>
      </button>
    </th>
  );
}

function cityState(row: Inspection): string {
  return [row.locationCity, row.locationState].filter(Boolean).join(', ');
}

/** Desktop table view (hidden below the `md` breakpoint). */
export default function InspectionTable({ rows, sort, onSort, mode }: Props) {
  return (
    <div className="hidden overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm md:block">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {COLUMNS.map((col) => (
              <SortHeader key={col.key} label={col.label} colKey={col.key} sort={sort} onSort={onSort} />
            ))}
            {mode === 'scheduled' && (
              <th scope="col" className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                Scheduled
              </th>
            )}
            <th scope="col" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              Flags
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row, i) => (
            <tr key={`${row.caseNumber}-${i}`} className="hover:bg-slate-50">
              <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-900">{row.caseNumber || '—'}</td>
              <td className="px-3 py-2">{row.insuredName || '—'}</td>
              <td className="px-3 py-2">{row.locationAddress || '—'}</td>
              <td className="whitespace-nowrap px-3 py-2">{cityState(row) || '—'}</td>
              <td className="whitespace-nowrap px-3 py-2"><DueDate value={row.inspectionDue} /></td>
              <td className="whitespace-nowrap px-3 py-2">{row.portal || '—'}</td>
              {mode === 'scheduled' && (
                <td className="whitespace-nowrap px-3 py-2">{row.dateScheduledFor || '—'}</td>
              )}
              <td className="whitespace-nowrap px-3 py-2">
                <span className="flex gap-1">
                  {rowFlags(row).map((flag) => (
                    <FlagBadge key={flag} label={flag} />
                  ))}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
