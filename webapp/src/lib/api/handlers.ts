/**
 * Route-handler logic for the write endpoints, as plain (Request) => Response
 * factories with injectable dependencies. Kept Next-free so the API tests can
 * exercise them under plain node:test; the route.ts files under src/app/api
 * wire these to the App Router with production deps.
 */
import {
  RowNotFoundError,
  clearInspectionsCache,
  updateInspectionFields,
} from '../sheets';
import { resolveDataSource } from '../dataSource';
import type { SixEditFields } from '../types';
import { validateEditBody } from '../validation';

export type RouteContext<TParams> = { params: Promise<TParams> };

export interface PatchInspectionDeps {
  update: typeof updateInspectionFields;
  clearCache: () => void;
}

/**
 * PATCH /api/inspections/[caseNumber]
 * Body: a subset of the six editable fields. 200 + canonicalized values on
 * success, 400 on validation errors, 404 when the case is not in the sheet,
 * 500 for sheet-access failures. Cache is busted after every successful write
 * so the UI sees the new values immediately.
 */
export function makePatchInspectionHandler(deps: PatchInspectionDeps) {
  return async function PATCH(
    request: Request,
    context: RouteContext<{ caseNumber: string }>
  ): Promise<Response> {
    const { caseNumber } = await context.params;
    // App Router params arrive URL-decoded already; decode defensively in case
    // a segment slipped through raw (an odd "%" must not throw a URIError).
    let id: string;
    try {
      id = decodeURIComponent(caseNumber).trim();
    } catch {
      id = caseNumber.trim();
    }
    if (!id) {
      return Response.json({ error: 'A non-empty caseNumber is required.' }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
    }

    const validated = validateEditBody(body);
    if (!validated.ok) {
      return Response.json({ error: validated.error }, { status: 400 });
    }

    try {
      const result = await deps.update(id, validated.edits);
      deps.clearCache();
      return Response.json({
        caseNumber: result.caseNumber,
        rowNumber: result.rowNumber,
        updated: validated.edits,
      });
    } catch (err) {
      if (err instanceof RowNotFoundError) {
        return Response.json({ error: err.message }, { status: 404 });
      }
      console.error(`[api/inspections/${id}] write failed:`, err);
      // Surface the single-line error message (no stack, no secrets) so the
      // cause is visible without reading the server log.
      const message = err instanceof Error ? err.message : String(err);
      return Response.json(
        { error: 'Failed to write the update to the Google Sheet.', detail: message },
        { status: 500 }
      );
    }
  };
}

export interface SyncHandlerDeps {
  fetch: typeof fetch;
  clearCache: () => void;
}

/** Cap for waiting on the n8n webhook response (sync itself may run longer). */
const SYNC_TIMEOUT_MS = 90_000;

/**
 * Pick the n8n webhook URL to fire, by active data source.
 *
 * Sheet mode (prod): exactly `N8N_WEBHOOK_URL` — the pre-cutover behavior,
 * byte-for-byte unchanged.
 *
 * DB mode (staging cutover): the "LC360 Sync (DB)" workflow (id
 * EYZmcYCOTejZadNY, webhook path `lc360-sync-db`) instead of the sheet one
 * (`lc360-sync`). Both workflows live on the same n8n host and only the
 * trailing webhook path segment differs, so:
 *   1. prefer an explicit `N8N_WEBHOOK_URL_DB` override if set;
 *   2. else derive it from `N8N_WEBHOOK_URL` by swapping its trailing
 *      `lc360-sync` path segment for `lc360-sync-db` (a trailing slash is
 *      accepted and normalized away);
 *   3. if neither works, return undefined — NEVER fall back to the sheet
 *      webhook in DB mode (that would push the real production sheet from a
 *      staging instance); the caller fails loudly with 503 instead.
 *
 * The `x-sync-secret` header is unchanged either way: both workflows check the
 * same `$env.SYNC_SECRET`, so N8N_SYNC_SECRET remains the single shared secret.
 */
function resolveSyncWebhookUrl(): string | undefined {
  const sheetUrl = process.env.N8N_WEBHOOK_URL;
  if (resolveDataSource() !== 'db') {
    return sheetUrl;
  }
  const dbUrl = process.env.N8N_WEBHOOK_URL_DB;
  if (dbUrl) {
    return dbUrl;
  }
  const derived = /^(.*\/)lc360-sync\/?$/.exec(sheetUrl ?? '');
  return derived ? `${derived[1]}lc360-sync-db` : undefined;
}

/**
 * POST /api/sync — fire the n8n Phase 2 webhook over all "Ready to Sync"
 * rows. URL/secret come from env only (N8N_WEBHOOK_URL / N8N_SYNC_SECRET,
 * plus N8N_WEBHOOK_URL_DB as the DB-mode target — see
 * resolveSyncWebhookUrl); 503 when unconfigured, 202 when n8n accepted the
 * trigger, 502 otherwise. The LC360/Zoho push itself happens inside n8n —
 * this only triggers it.
 */
export function makeSyncHandler(deps: SyncHandlerDeps) {
  return async function POST(): Promise<Response> {
    const url = resolveSyncWebhookUrl();
    if (!url) {
      // DB-mode message names the DB override so a staging misconfiguration
      // is diagnosable from the response alone; the sheet-mode message (and
      // entire code path) is unchanged.
      const configured =
        resolveDataSource() === 'db'
          ? 'N8N_WEBHOOK_URL_DB (or N8N_WEBHOOK_URL ending in /lc360-sync) in the environment'
          : 'N8N_WEBHOOK_URL in .env.local';
      return Response.json(
        { error: `Sync is not configured: set ${configured}.` },
        { status: 503 }
      );
    }
    const secret = process.env.N8N_SYNC_SECRET;

    try {
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-sync-secret': secret } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      if (res.ok) {
        // Sheet state may have changed in n8n; serve fresh data on next read.
        deps.clearCache();
        return Response.json(
          { ok: true, message: 'Sync triggered — rows marked "Ready to Sync" are being processed.' },
          { status: 202 }
        );
      }
      const text = (await res.text().catch(() => '')).slice(0, 300);
      console.error(`[api/sync] n8n webhook responded ${res.status}: ${text}`);
      return Response.json(
        { error: `n8n rejected the sync trigger (status ${res.status}).` },
        { status: 502 }
      );
    } catch (err) {
      console.error('[api/sync] failed to reach the n8n webhook:', err);
      return Response.json(
        { error: 'Could not reach the n8n sync webhook. Check N8N_WEBHOOK_URL and the n8n server.' },
        { status: 502 }
      );
    }
  };
}
