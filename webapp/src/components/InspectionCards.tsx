import type { Inspection } from '@/lib/types';
import DueDate from './DueDate';
import FlagBadge from './FlagBadge';
import { rowFlags } from './flags';

interface Props {
  rows: Inspection[];
  /** "scheduled" also shows the scheduled-for date on each card. */
  mode: 'needs' | 'scheduled';
}

function cityState(row: Inspection): string {
  return [row.locationCity, row.locationState].filter(Boolean).join(', ');
}

/** Stacked card view for small screens (hidden at the `md` breakpoint and up). */
export default function InspectionCards({ rows, mode }: Props) {
  return (
    <ul className="space-y-3 md:hidden">
      {rows.map((row, i) => (
        <li
          key={`${row.caseNumber}-${i}`}
          className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="font-semibold text-slate-900">{row.caseNumber || '—'}</span>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {rowFlags(row).map((flag) => (
                <FlagBadge key={flag} label={flag} />
              ))}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-slate-700">{row.insuredName || '—'}</p>
          <p className="text-sm text-slate-500">{row.locationAddress || '—'}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            {cityState(row) && <span>{cityState(row)}</span>}
            {row.portal && <span>{row.portal}</span>}
            <span>
              Due <DueDate value={row.inspectionDue} />
            </span>
            {mode === 'scheduled' && row.dateScheduledFor && (
              <span>
                Scheduled <span className="font-medium text-slate-700">{row.dateScheduledFor}</span>
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
