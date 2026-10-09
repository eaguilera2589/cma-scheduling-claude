import type { Inspection } from '@/lib/types';
import DueDate from './DueDate';
import FlagBadge from './FlagBadge';
import SyncStatusPill from './SyncStatusPill';
import { rowFlags } from './flags';

interface Props {
  rows: Inspection[];
  /** "scheduled" also shows the scheduled-for date on each card. */
  mode: 'needs' | 'scheduled';
  /** Opens the row editor (requires a row with a CaseNumber). */
  onEdit: (caseNumber: string) => void;
}

function cityState(row: Inspection): string {
  return [row.locationCity, row.locationState].filter(Boolean).join(', ');
}

/** Stacked card view for small screens (hidden at the `md` breakpoint and up). */
export default function InspectionCards({ rows, mode, onEdit }: Props) {
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
          {/* Field order mirrors the desktop table (board UI batch spec):
              insured, contact, phone, address, then the meta line. */}
          {row.contactAtInsured && (
            <p className="text-sm text-slate-500">
              Contact <span className="text-slate-700">{row.contactAtInsured}</span>
            </p>
          )}
          {row.phone && <p className="text-sm text-slate-500">{row.phone}</p>}
          <p className="text-sm text-slate-500">{row.locationAddress || '—'}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            {cityState(row) && <span>{cityState(row)}</span>}
            <span>
              Due <DueDate value={row.inspectionDue} />
            </span>
            {row.policyNumber && (
              <span>
                Policy <span className="text-slate-700">{row.policyNumber}</span>
              </span>
            )}
            {row.agentName && (
              <span>
                Agent <span className="text-slate-700">{row.agentName}</span>
              </span>
            )}
            {row.agentNumber && (
              <span>
                Agent Phone <span className="text-slate-700">{row.agentNumber}</span>
              </span>
            )}
            {row.portal && <span>{row.portal}</span>}
            {mode === 'scheduled' && row.dateScheduledFor && (
              <span>
                Scheduled <span className="font-medium text-slate-700">{row.dateScheduledFor}</span>
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-2">
            <SyncStatusPill status={row.syncStatus} />
            <button
              type="button"
              onClick={() => onEdit(row.caseNumber)}
              disabled={!row.caseNumber}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              Edit
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
