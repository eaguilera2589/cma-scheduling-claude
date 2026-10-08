/**
 * LC360 (LossControl360) read client.
 *
 * This is a faithful, credential-free port of the LC360 pull embedded in the
 * n8n workflow `n8n-workflow/existing-lc360-sheet-export.json`. It reproduces
 * that workflow's exact HTTP behaviour against the (unofficial) LC360 ASMX API:
 *
 *   1. GET  https://<host>/Login/Login            -> scrape the hidden
 *      __RequestVerificationToken + capture the pre-auth `set-cookie`.
 *   2. POST https://<host>/Login/Login            -> form-urlencoded login,
 *      redirects OFF, expect HTTP 302; merge the returned `set-cookie` into a
 *      name-keyed cookie jar (later wins).
 *   3. POST https://<host>/WebServices/LandingPage.asmx/GetCases
 *                                                  -> JSON body, returns
 *      { d: { Cases: [...], TotalCount: n } }.
 *
 * Two portals share this code (Preferred / Sutton); a row's `portal` tag is set
 * from which portal returned it. Credentials are NEVER hardcoded here — the
 * username comes from the portal's env var and the password is passed in by the
 * caller (the ingest script reads it from the environment). Nothing here ever
 * logs a credential value.
 */
import https from 'node:https';

/** A case already mapped to the snake_case columns of the staging `cases` table. */
export interface Lc360Case {
  case_number: string;
  insured_name: string;
  location_address: string;
  location_city: string;
  location_state: string;
  inspection_due: string;
  date_scheduled_for: string;
  portal: string;
  rush: string;
  escalated: string;
  scheduling_status: string;
  case_type: string;
  // Phase-2 columns populated by the direct LC360 ingest.
  policy_number: string;
  phone: string;
  agent_name: string;
  agent_number: string;
}

export interface PortalConfig {
  /** Tag written to the `portal` column and used in logs. */
  label: 'Preferred' | 'Sutton';
  host: string;
  /** Name of the env var that holds this portal's username. */
  usernameEnv: string;
}

/**
 * The two LC360 portals. Hosts are stable constants (per the n8n workflow);
 * the per-portal usernames are read from the environment by the caller.
 */
export const PORTALS: readonly PortalConfig[] = [
  { label: 'Preferred', host: 'preferred.losscontrol360.com', usernameEnv: 'LC360_PREFERRED_USERNAME' },
  { label: 'Sutton', host: 'ecommerce3.sibfla.com', usernameEnv: 'LC360_SUTTON_USERNAME' },
];

/** Page identifier the GetCases endpoint expects (verbatim from the workflow). */
const GET_CASES_PAGE = 'LC360Web.Pages.Inspectors._default';

/** Fields a well-formed GetCases row must carry; a missing one means the API changed. */
const REQUIRED_FIELDS = ['CaseID', 'CaseNumber', 'CaseStatus', 'InspectionDue', 'InsuredName'] as const;

/**
 * Date fields, serialised by ASMX as `/Date(<ms><tz>)/`. Matches the workflow's
 * DATE_FIELDS set verbatim (only InspectionDue / DateScheduledFor land in the DB,
 * but the set is kept complete so toDate() is applied to exactly the right keys).
 */
const DATE_FIELDS = new Set<string>([
  'Ordered', 'Assigned', 'Due', 'InspectionDue', 'Completed', 'DateScheduledFor',
  'DateScheduledOn', 'PlannedFor', 'LastCalledOn', 'DateLastContactAttempt',
  'InspectionDate', 'QARejected', 'LastCaseNoteDate',
]);

// (DATE_FIELDS documents the contract; the explicit toDate() calls in
// mapCaseToColumns are what actually normalise the two date columns we persist.)

/** A cookie jar keyed by cookie name; insertion order is preserved. */
export type CookieJar = Map<string, string>;

/** Low-level request result: status, headers, parsed set-cookie strings, body text. */
interface HttpResponse {
  statusCode: number;
  headers: NodeJS.Dict<string | string[]>;
  setCookies: string[];
  body: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Single HTTPS request. Redirects are never followed (node:https never is by
 * default) so a 302 login response is observable. No `Accept-Encoding` is sent,
 * so the response body arrives uncompressed — simplest correct behaviour for the
 * small JSON payloads here.
 */
function httpsRequest(
  options: https.RequestOptions,
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = res.headers['set-cookie'];
        const setCookies = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          setCookies,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`LC360 request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Turn raw `set-cookie` header values into a name-keyed jar (full `name=value`). */
function jarFromSetCookie(raw: string[], seed?: CookieJar): CookieJar {
  const jar: CookieJar = seed ? new Map(seed) : new Map();
  for (const entry of raw) {
    const pair = String(entry).split(';')[0].trim();
    if (!pair || !pair.includes('=')) continue;
    const name = pair.slice(0, pair.indexOf('='));
    jar.set(name, pair); // later wins (Map.set overwrites same name)
  }
  return jar;
}

/** Serialize a jar back into a `Cookie:` header value. */
function jarHeader(jar: CookieJar): string {
  return [...jar.values()].join('; ');
}

/** Extract the ASP.NET anti-forgery token value from the login page HTML. */
function extractToken(html: string): string {
  const m =
    html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i) ||
    html.match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i);
  if (!m) {
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || 'unknown';
    throw new Error(
      `PRE-FLIGHT FAIL: __RequestVerificationToken not found on ${'login page'}. ` +
        `Page title was "${title}" (${html.length} bytes). The login markup may have ` +
        `changed, or the request was redirected away from the login form.`
    );
  }
  return m[1];
}

/** Pull human-readable validation errors out of an LC360 login failure page (no creds). */
function loginErrorHints(body: string): string {
  const msgs = [...body.matchAll(/<li>([^<]{3,160})<\/li>/gi)]
    .map((x) => x[1].trim())
    .filter((x) => /incorrect|invalid|locked|attempt|password|user ?name/i.test(x));
  return msgs.length ? ` LC360 said: "${msgs.slice(0, 2).join(' | ')}".` : ' LC360 returned no error text.';
}

/**
 * Authenticate to one portal and return its auth cookie jar.
 * Throws on any pre-flight or login failure. Never logs credentials.
 */
export async function authenticate(portal: PortalConfig, username: string, password: string): Promise<CookieJar> {
  // 1. GET the login page (text), capturing the anti-forgery token + session cookie.
  const page = await httpsRequest({
    method: 'GET',
    hostname: portal.host,
    path: '/Login/Login',
    headers: { Connection: 'close' },
  });
  const token = extractToken(page.body);
  let jar = jarFromSetCookie(page.setCookies);
  if (jar.size === 0) {
    throw new Error(
      `SETUP FAIL: the ${portal.label} login page returned no cookies. The ` +
        `anti-forgery token is only valid when paired with its session cookie.`
    );
  }

  // 2. POST the credentials (redirects off). Build the body exactly like the workflow.
  const enc = encodeURIComponent;
  const formBody = [
    `UserName=${enc(username)}`,
    `Password=${enc(password)}`,
    `__RequestVerificationToken=${enc(token)}`,
    'RememberMe=false',
    'ReturnUrl=',
  ].join('&');

  const res = await httpsRequest(
    {
      method: 'POST',
      hostname: portal.host,
      path: '/Login/Login',
      headers: {
        Cookie: jarHeader(jar),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        Connection: 'close',
      },
    },
    formBody
  );

  if (res.statusCode !== 302) {
    const sent = `username ${username.length ? `${username.length} chars` : 'EMPTY'}, ` +
      `password ${password.length ? `${password.length} chars` : 'EMPTY'}`;
    throw new Error(
      `LOGIN FAILED (${portal.label}): expected 302, got ${res.statusCode}. Sent ${sent}.` +
        loginErrorHints(res.body)
    );
  }

  // 3. Merge the post-auth cookies into the jar (later wins, keyed by name).
  jar = jarFromSetCookie(res.setCookies, jar);
  if (jar.size === 0) {
    throw new Error(`LOGIN FAILED (${portal.label}): no cookies returned despite a 302.`);
  }
  return jar;
}

/** Normalise an LC360 scalar value to the trimmed text the DB/serving layer expects. */
function toCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; // Sheets rendered booleans uppercase
  if (typeof v === 'number') return String(v);
  return String(v).trim();
}

/** Convert an ASMX `/Date(...)/` value (or anything Date-parses) to MM/DD/YYYY, '' if blank. */
export function toDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const m = String(v).match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  const dt = m ? new Date(parseInt(m[1], 10)) : new Date(String(v));
  if (isNaN(dt.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(dt.getMonth() + 1)}/${p(dt.getDate())}/${dt.getFullYear()}`;
}

/** First non-empty of the given raw values, in precedence order. */
function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    const s = toCell(v);
    if (s) return s;
  }
  return '';
}

/**
 * Map a raw GetCases case to the staging `cases` columns. Field selection and
 * the toDate rule mirror the n8n mapper; the four Phase-2 columns and the
 * Cell->Home->Work phone precedence are added per the ingest spec.
 */
export function mapCaseToColumns(c: Record<string, unknown>, portalLabel: string): Lc360Case {
  return {
    case_number: toCell(c.CaseNumber),
    insured_name: toCell(c.InsuredName),
    location_address: toCell(c.LocationAddress),
    location_city: toCell(c.LocationCity),
    location_state: toCell(c.LocationState),
    inspection_due: toDate(c.InspectionDue),
    date_scheduled_for: toDate(c.DateScheduledFor),
    portal: portalLabel,
    rush: toCell(c.Rush),
    escalated: toCell(c.Escalated),
    scheduling_status: toCell(c.SchedulingStatus),
    case_type: toCell(c.CaseType),
    policy_number: toCell(c.PolicyNumber),
    // phone precedence: Cell -> Home -> Work (first non-empty wins).
    phone: firstNonEmpty(c.InsuredCellPhone, c.InsuredHomePhone, c.InsuredWorkPhone),
    agent_name: toCell(c.AgentName),
    agent_number: toCell(c.AgentPhone),
  };
}

/** Assert the GetCases row shape still matches the expected contract. */
function assertContract(cases: Record<string, unknown>[]): void {
  if (cases.length === 0) return;
  const missing = REQUIRED_FIELDS.filter((f) => !(f in cases[0]));
  if (missing.length) {
    throw new Error(
      `PRE-FLIGHT FAIL: GetCases is missing expected fields: ${missing.join(', ')}. ` +
        `LC360 may have been upgraded — re-run field discovery before trusting this.`
    );
  }
}

export interface PortalResult {
  label: string;
  cases: Lc360Case[];
  /** Total rows reported by LC360 across pages (d.TotalCount). */
  totalCount: number;
}

/**
 * Fetch every case from one portal, paginating defensively. The upstream export
 * only ever asked for page 0 (pageSize 500, ~83 total today); we additionally
 * loop pageNumber upward until we have collected `d.TotalCount` rows.
 */
export async function fetchPortal(portal: PortalConfig, password: string): Promise<PortalResult> {
  const username = process.env[portal.usernameEnv];
  if (!username) {
    throw new Error(`Missing env var ${portal.usernameEnv} for the ${portal.label} portal.`);
  }
  const jar = await authenticate(portal, username, password);

  const pageSize = 500;
  const maxPages = 200; // hard guard against a server that ignores pageNumber
  const collected: Record<string, unknown>[] = [];
  let pageNumber = 0;
  let totalCount = 0;

  for (;;) {
    const body = JSON.stringify({ Page: GET_CASES_PAGE, pageNumber, pageSize, sortBy: '' });
    const res = await httpsRequest(
      {
        method: 'POST',
        hostname: portal.host,
        path: '/WebServices/LandingPage.asmx/GetCases',
        headers: {
          Cookie: jarHeader(jar),
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      body
    );

    if (res.statusCode !== 200) {
      throw new Error(`GetCases (${portal.label}) page ${pageNumber} returned HTTP ${res.statusCode}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new Error(`GetCases (${portal.label}) page ${pageNumber} returned non-JSON (auth may have lapsed).`);
    }
    const d = (parsed as { d?: { Cases?: unknown; TotalCount?: number } }).d ?? (parsed as { Cases?: unknown; TotalCount?: number });
    const cases = d.Cases;
    if (!Array.isArray(cases)) {
      throw new Error(`PRE-FLIGHT FAIL: GetCases (${portal.label}) did not return a Cases array.`);
    }
    assertContract(cases as Record<string, unknown>[]);

    totalCount = typeof d.TotalCount === 'number' ? d.TotalCount : totalCount;
    collected.push(...(cases as Record<string, unknown>[]));
    pageNumber += 1;

    // Stop conditions: a short/empty page (last page), or we've reached the total,
    // or we hit the defensive page ceiling.
    if (cases.length === 0 || cases.length < pageSize || collected.length >= totalCount || pageNumber >= maxPages) {
      break;
    }
  }

  return {
    label: portal.label,
    cases: collected.map((c) => mapCaseToColumns(c, portal.label)),
    totalCount,
  };
}
