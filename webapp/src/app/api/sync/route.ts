import { makeSyncHandler } from '@/lib/api/handlers';
import { clearInspectionsCache } from '@/lib/sheets';

// Must run per-request; never statically optimized.
export const dynamic = 'force-dynamic';

/**
 * POST /api/sync — trigger the n8n Phase 2 workflow over all rows currently
 * marked "Ready to Sync". URL + shared secret come from N8N_WEBHOOK_URL /
 * N8N_SYNC_SECRET (env only; see .env.example). No LC360/Zoho logic here —
 * that lives entirely in n8n.
 */
export const POST = makeSyncHandler({
  fetch,
  clearCache: clearInspectionsCache,
});
