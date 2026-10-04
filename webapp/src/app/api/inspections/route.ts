import { NextResponse } from 'next/server';
import { getInspections } from '@/lib/sheets';

// The data comes from an external sheet and must always be served fresh
// (subject to the 60s in-memory cache inside lib/sheets), never statically
// optimized into the build.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const inspections = await getInspections();
    return NextResponse.json(inspections);
  } catch (err) {
    console.error('[api/inspections] failed to load sheet data:', err);
    return NextResponse.json(
      { error: 'Failed to load inspections from the Google Sheet.' },
      { status: 502 }
    );
  }
}
