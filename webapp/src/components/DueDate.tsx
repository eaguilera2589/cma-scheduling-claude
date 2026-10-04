import { dueState } from '@/lib/dates';

const STATE_CLASSES: Record<string, string> = {
  overdue: 'text-red-600 font-semibold',
  soon: 'text-amber-600 font-medium',
  normal: '',
  unknown: '',
};

/** Renders an inspection due date, colored by urgency. */
export default function DueDate({ value }: { value: string }) {
  const state = dueState(value);
  if (!value) return <span className="text-slate-400">—</span>;
  return <span className={STATE_CLASSES[state]} title={state === 'overdue' ? 'Overdue' : state === 'soon' ? 'Due within 3 days' : undefined}>{value}</span>;
}
