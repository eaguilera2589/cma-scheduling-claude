import { syncStatusTone } from '@/lib/editFields';

const TONE_CLASSES: Record<string, string> = {
  empty: 'bg-slate-100 text-slate-500 ring-slate-300',
  ready: 'bg-blue-100 text-blue-700 ring-blue-300',
  synced: 'bg-green-100 text-green-700 ring-green-300',
  error: 'bg-red-100 text-red-700 ring-red-300',
  other: 'bg-amber-100 text-amber-700 ring-amber-300',
};

/** Colored pill for the current Sync Status of a row. */
export default function SyncStatusPill({ status }: { status: string }) {
  const tone = syncStatusTone(status);
  const label = status.trim() === '' ? 'Not ready' : status.trim();
  return (
    <span
      className={`inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${TONE_CLASSES[tone]}`}
      title={`Sync Status: ${label}`}
    >
      {label}
    </span>
  );
}
