import { NextResponse } from 'next/server';
import { loadInspections } from '@/lib/dataSource';

// The data comes from an external source (sheet, or Postgres in staging) and
// must always be served fresh (subject to the 60s in-memory cache in
// lib/sheets for the sheet source), never statically optimized into the build.
//
// The concrete source is chosen by DATA_SOURCE (default 'sheet' == prod); see
// lib/dataSource.ts. In sheet mode this calls the exact same getInspections()
// it always did.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const inspections = await loadInspections();
    return NextResponse.json(inspections);
  } catch (err) {
    console.error('[api/inspections] failed to load data:', err);
    return NextResponse.json(
      { error: 'Failed to load inspections from the Google Sheet.' },
      { status: 502 }
    );
  }
}
