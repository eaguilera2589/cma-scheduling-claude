/** Red pill for Rush/Escalated flags. */
export default function FlagBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-red-700 ring-1 ring-inset ring-red-300">
      {label}
    </span>
  );
}
