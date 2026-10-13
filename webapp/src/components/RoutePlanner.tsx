'use client';

/**
 * Route Planner tab: fetches GET /api/plan and renders one card per city
 * day (farthest city first), with stops in the planner's returned order —
 * grade 1 starts farthest from home, the last grade ends closest. The UI
 * must NEVER re-sort: grades and city order are the planner's contract.
 */
import { useEffect, useRef, useState } from 'react';
import type { PlanResponse, PlannedStopView } from '@/lib/api/planHandler';
import { telHref } from '@/lib/telHref';
import FlagBadge from './FlagBadge';

function miles(n: number): string {
  return `${n.toFixed(1)} mi`;
}

function CityCard({ plan }: { plan: PlanResponse['cities'][number] }) {
  const n = plan.stops.length;
  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h2 className="text-base font-semibold text-slate-900">{plan.city || 'Unknown city'}</h2>
        <p className="text-sm text-slate-500">
          {n} stop{n === 1 ? '' : 's'} · ≈{miles(plan.totalMiles)} round trip
        </p>
      </header>
      <ol className="divide-y divide-slate-100">
        {plan.stops.map((stop, i) => (
          <StopRow key={`${stop.caseNumber}-${stop.grade}`} stop={stop} first={i === 0} last={i === n - 1} many={n > 1} />
        ))}
      </ol>
    </section>
  );
}

function StopRow({
  stop,
  first,
  last,
  many,
}: {
  stop: PlannedStopView;
  first: boolean;
  last: boolean;
  many: boolean;
}) {
  const phoneHref = telHref(stop.phone);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-bold text-white"
        title={`Grade ${stop.grade} of the day`}
      >
        {stop.grade}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-900" title={stop.address}>
          {stop.address || '—'}
          {stop.city ? <span className="text-slate-500">, {stop.city}</span> : null}
        </p>
        {(stop.caseNumber || stop.insuredName) && (
          <p className="truncate text-sm text-slate-700" title={stop.insuredName || undefined}>
            {stop.caseNumber ? (
              <span className="mr-2 text-xs text-slate-500">{stop.caseNumber}</span>
            ) : null}
            {stop.insuredName}
          </p>
        )}
        {phoneHref && (
          <a href={phoneHref} className="block truncate text-sm text-slate-500 hover:underline">
            {stop.phone}
          </a>
        )}
      </div>
      {stop.flags.length > 0 && (
        <span className="flex gap-1">
          {stop.flags.map((flag) => (
            <FlagBadge key={flag} label={flag} />
          ))}
        </span>
      )}
      <span
        className={`whitespace-nowrap text-sm ${
          stop.dueWarning ? 'font-semibold text-red-600' : 'text-slate-600'
        }`}
        title={stop.dueWarning ? 'Due soon or overdue' : undefined}
      >
        {stop.inspectionDue || '—'}
      </span>
      <span className="whitespace-nowrap text-xs text-slate-500">
        {miles(stop.legMiles)} {stop.grade === 1 ? 'from home' : 'from previous'}
      </span>
      {many && (first || last) && (
        <span className="w-full basis-full text-[11px] italic text-slate-400">
          {first ? 'starts farthest from home' : 'ends closest to home'}
        </span>
      )}
    </li>
  );
}

export default function RoutePlanner() {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/plan', { cache: 'no-store' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed with status ${res.status}`);
        }
        const json = (await res.json()) as PlanResponse;
        if (mountedRef.current) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
        Could not load the route plan: {error}
      </div>
    );
  }

  if (data === null) {
    return <p className="text-sm text-slate-500">Loading route plan…</p>;
  }

  const noStops = data.cities.every((c) => c.stops.length === 0);

  return (
    <div className="space-y-4">
      {data.configError && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          <p className="font-semibold">Route Planner needs setup.</p>
          <p>
            Add <code>GOOGLE_MAPS_API_KEY</code> to the environment and run{' '}
            <code>npm run geo:backfill</code> to geocode the open addresses.
          </p>
          {data.configError !== 'GOOGLE_MAPS_API_KEY is not set' && (
            <p className="mt-1 text-xs text-amber-700">{data.configError}</p>
          )}
        </div>
      )}

      {data.unresolved.length > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50/60 shadow-sm">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-amber-800">
            Needs address fix ({data.unresolved.length}) — not in any day plan
          </summary>
          <ul className="divide-y divide-amber-100 border-t border-amber-200 text-sm text-amber-900">
            {data.unresolved.map((u, i) => (
              <li key={`${u.caseNumber}-${i}`} className="px-4 py-2">
                <span className="font-medium">{u.caseNumber || '—'}</span>
                {' — '}
                {[u.address, u.city].filter(Boolean).join(', ') || 'no address on file'}
                <span className="ml-2 text-xs text-amber-600">(address could not be geocoded)</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {noStops ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
          {data.configError ? 'No routes to show until geocoding is set up.' : 'No open cases to route.'}
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-500">
            {data.cities.length} city day{data.cities.length === 1 ? '' : 's'} · farthest day first ·
            generated{' '}
            {new Date(data.generatedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
          {data.cities.map((plan) => (
            <CityCard key={`${plan.city}`} plan={plan} />
          ))}
        </>
      )}
    </div>
  );
}
