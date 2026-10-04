#!/usr/bin/env node
/**
 * format-sheet.js — one-shot formatter for the CMA Inspections Google Sheet.
 *
 * Applies scheduling-staff-friendly formatting to the "Inspections" tab:
 *   1. Freezes the header row.
 *   2. Sets a basic filter over the whole data range.
 *   3. Hides low-value columns.
 *   4. Adds conditional formatting (Rush/Escalated red, Sync Status colors).
 *   5. Adds dropdown data validation on the human-edit columns.
 *   6. Appends/maintains a "Days Until Due" formula column.
 *   7. Maintains a "Needs Scheduling" QUERY tab (DateScheduledFor is blank).
 *   8. Maintains a "Scheduled" QUERY tab (DateScheduledFor is not blank).
 *
 * Idempotent: re-running replaces filters/validation/rules in place, reuses
 * an existing "Days Until Due" column, and never duplicates QUERY tabs.
 *
 * Usage: npm install && node format-sheet.js
 */

'use strict';

const fs = require('fs');
const { google } = require('googleapis');

// ---------------------------------------------------------------------------
// Configuration (internal tool — paths/IDs hardcoded per the task brief)
// ---------------------------------------------------------------------------
const SERVICE_ACCOUNT_KEY_PATH =
  '/opt/workspace/secrets/google/CAIsecretsgoogleservice-account.json';
const SPREADSHEET_ID = '1XDgnaqlHMRFGeiBzm7fnrjM9-sZXan7rRhG2pOqVkF0';
const MAIN_TAB = 'Inspections';
const NEEDS_TAB = 'Needs Scheduling';
const SCHEDULED_TAB = 'Scheduled';
const DAYS_COL_HEADER = 'Days Until Due';

// Columns whose header must exist in row 1 and be hidden.
const HIDE_COLUMNS = [
  'PolicyNumber', 'CaseID', 'PolicyContactName', 'Underwriter', 'FieldRep',
  'PayAmount', 'TotalRecs', 'OpenCriticalRecs', 'InsuredWorkPhone',
  'LocationCounty', 'Ordered', 'PlannedFor', 'LastCalledOn',
  'LastContactAttemptName', 'DateLastContactAttempt', 'CaseLink', 'LastSynced',
];

// Columns used by conditional-format formulas (must exist).
const RUSH_COL = 'Rush';
const ESCALATED_COL = 'Escalated';
const SYNC_STATUS_COL = 'Sync Status';
const INSPECTION_DUE_COL = 'InspectionDue';
const DATE_SCHEDULED_FOR_COL = 'DateScheduledFor';

// Dropdown validation per human-edit column (must exist).
const VALIDATION_COLUMNS = {
  'Schedule Appointment (Y/N)': ['Y', 'N'],
  'Sync Status': ['', 'Ready to Sync', 'Synced'],
  'Attempted to Contact': ['Insured', 'Agent', 'Other'],
};

const COLORS = {
  red: { red: 0xf2 / 255, green: 0x8b / 255, blue: 0x82 / 255 }, // #f28b82
  grey: { red: 0xe0 / 255, green: 0xe0 / 255, blue: 0xe0 / 255 }, // #e0e0e0
  pink: { red: 0xf4 / 255, green: 0xc7 / 255, blue: 0xc3 / 255 }, // #f4c7c3
  yellow: { red: 0xfe / 255, green: 0xf7 / 255, blue: 0xe0 / 255 }, // #fef7e0
};

const SPREADSHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** 0-based column index -> A1 letter (0 -> A, 26 -> AA, ...). */
function colToLetter(n) {
  let s = '';
  let i = n;
  while (i >= 0) {
    s = String.fromCharCode(65 + (i % 26)) + s;
    i = Math.floor(i / 26) - 1;
  }
  return s;
}

/** Quote a sheet title for use inside an A1 range. */
function quoteTitle(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

function log(msg) {
  console.log(msg);
}

function die(err) {
  const status = err?.response?.status;
  const detail = err?.response?.data?.error?.message || err?.message || err;
  console.error(`FAILED${status ? ` (HTTP ${status})` : ''}: ${detail}`);
  if (status && !err?.response?.data?.error?.message) {
    console.error(JSON.stringify(err?.response?.data ?? {}, null, 2));
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- Auth (JWT service account) ------------------------------------------
  const sa = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_KEY_PATH, 'utf8'));
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [SPREADSHEETS_SCOPE],
  });
  await jwt.authorize();
  const sheets = google.sheets({ version: 'v4', auth: jwt });
  log(`Authenticated as ${sa.client_email}`);

  // --- Sheet metadata (ids, grid sizes) ------------------------------------
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties(sheetId,title,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount)',
  });
  const sheetProps = new Map(
    meta.data.sheets.map((s) => [s.properties.title, s.properties])
  );
  const mainProps = sheetProps.get(MAIN_TAB);
  if (!mainProps) {
    throw new Error(`Sheet tab "${MAIN_TAB}" not found in the spreadsheet.`);
  }
  const mainId = mainProps.sheetId;
  log(`Found "${MAIN_TAB}" (sheetId=${mainId})`);

  // --- Read headers (row 1) dynamically ------------------------------------
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTitle(MAIN_TAB)}!1:1`,
  });
  const rawHeaders = (headerRes.data.values && headerRes.data.values[0]) || [];
  const headers = rawHeaders.map((h) => String(h ?? '').trim());
  if (headers.filter(Boolean).length === 0) {
    throw new Error(`Row 1 of "${MAIN_TAB}" is empty — cannot locate columns.`);
  }

  const exactIndex = new Map();
  const ciIndex = new Map();
  headers.forEach((h, i) => {
    if (!h) return;
    if (!exactIndex.has(h)) exactIndex.set(h, i);
    const k = h.toLowerCase();
    if (!ciIndex.has(k)) ciIndex.set(k, i);
  });

  /** Column index for a header name (exact match, then case-insensitive). */
  function colOf(name) {
    if (exactIndex.has(name)) return exactIndex.get(name);
    const ci = ciIndex.get(name.toLowerCase());
    if (ci !== undefined) return ci;
    throw new Error(
      `Required column "${name}" not found in row 1 of "${MAIN_TAB}". ` +
        `Headers seen: ${headers.filter(Boolean).join(', ')}`
    );
  }

  // Validate every column the script depends on, listing all problems at once.
  const missing = [];
  for (const name of [
    ...HIDE_COLUMNS,
    ...Object.keys(VALIDATION_COLUMNS),
    RUSH_COL, ESCALATED_COL, SYNC_STATUS_COL,
    INSPECTION_DUE_COL, DATE_SCHEDULED_FOR_COL,
  ]) {
    try { colOf(name); } catch { missing.push(name); }
  }
  if (missing.length) {
    throw new Error(
      `Missing expected columns in row 1 of "${MAIN_TAB}": ${missing.join(', ')}`
    );
  }

  // Days Until Due: reuse if present, otherwise append after the last header.
  let daysIdx = exactIndex.get(DAYS_COL_HEADER);
  const addingDaysCol = daysIdx === undefined;
  if (addingDaysCol) daysIdx = headers.length;

  const finalCols = Math.max(headers.length, daysIdx + 1); // columns formatting covers
  const rushL = colToLetter(colOf(RUSH_COL));
  const escL = colToLetter(colOf(ESCALATED_COL));
  const syncL = colToLetter(colOf(SYNC_STATUS_COL));
  const dueL = colToLetter(colOf(INSPECTION_DUE_COL));
  const schedL = colToLetter(colOf(DATE_SCHEDULED_FOR_COL));
  const daysL = colToLetter(daysIdx);
  log(`Column map resolved: Rush=${rushL} Escalated=${escL} SyncStatus=${syncL} ` +
      `InspectionDue=${dueL} DateScheduledFor=${schedL} DaysUntilDue=${daysL}` +
      (addingDaysCol ? ' (new)' : ' (existing)'));

  // --- Last data row --------------------------------------------------------
  // Use column A's last non-empty row (n8n writes every data row densely);
  // fall back to the grid's reported size if column A reads empty.
  const colARes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTitle(MAIN_TAB)}!A:A`,
  });
  const aRows = colARes.data.values || [];
  const gridRows = mainProps.gridProperties?.rowCount || 0;
  const lastRow = Math.max(aRows.length || gridRows, 2);
  log(`Data range: rows 1..${lastRow}, columns 1..${finalCols} (A:${colToLetter(finalCols - 1)})`);

  // Ranges reused below. Note conditional formats cover data rows only (2..lastRow).
  const allRows = (endCol) => ({
    sheetId: mainId,
    startRowIndex: 0,
    endRowIndex: lastRow,
    startColumnIndex: 0,
    endColumnIndex: endCol,
  });
  const dataRows = (endCol) => ({ ...allRows(endCol), startRowIndex: 1 });

  // --- Step 1: clear existing conditional formats over the data -------------
  // Separate call so a "nothing to delete" error on a pristine sheet is
  // tolerated and does not abort the rest of the work.
  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          { deleteConditionalFormatRule: { sheetId: mainId, range: allRows(finalCols) } },
        ],
      },
    });
    log('Cleared pre-existing conditional format rules.');
  } catch (err) {
    log(`No pre-existing conditional formats to clear (${err?.response?.status || err?.message}).`);
  }

  // --- Step 2: write the Days Until Due column ------------------------------
  // Formulas written via values.update are stored per-cell as entered, so each
  // row's formula must carry its own row number (relative refs do NOT shift).
  const formulaForRow = (r) => `=IF($${dueL}${r}="","",$${dueL}${r}-TODAY())`;
  if (addingDaysCol) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteTitle(MAIN_TAB)}!${daysL}1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[DAYS_COL_HEADER]] },
    });
    log(`Wrote "${DAYS_COL_HEADER}" header at ${daysL}1.`);
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${quoteTitle(MAIN_TAB)}!${daysL}2:${daysL}${lastRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: Array.from({ length: lastRow - 1 }, (_, i) => [formulaForRow(i + 2)]),
    },
  });
  log(`Filled ${DAYS_COL_HEADER} formulas in ${daysL}2:${daysL}${lastRow}.`);

  // --- Step 3: main formatting batch ----------------------------------------
  // Conditional-format rules are appended lowest-priority-first; the last rule
  // created takes precedence in Sheets, so Rush/Escalated red wins over the
  // Sync Status colors.
  const cfRules = [
    { // lowest priority: Synced grey
      ranges: [dataRows(finalCols)],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: `=$${syncL}2="Synced"` }],
        },
        format: { backgroundColor: COLORS.grey },
      },
    },
    {
      ranges: [dataRows(finalCols)],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: `=$${syncL}2="Ready to Sync"` }],
        },
        format: { backgroundColor: COLORS.yellow },
      },
    },
    {
      ranges: [dataRows(finalCols)],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: `=LEFT($${syncL}2,5)="Error"` }],
        },
        format: { backgroundColor: COLORS.pink },
      },
    },
    { // highest priority (added last): Rush/Escalated red
      ranges: [dataRows(finalCols)],
      booleanRule: {
        condition: {
          type: 'CUSTOM_FORMULA',
          values: [{ userEnteredValue: `=OR($${rushL}2="Y",$${escL}2="Y")` }],
        },
        format: { backgroundColor: COLORS.red },
      },
    },
  ];

  const requests = [
    // 1. Freeze the header row.
    {
      updateSheetProperties: {
        sheetId: mainId,
        properties: { gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // 4. Conditional formatting (delete happened in its own batch above).
    ...cfRules.map((rule) => ({ updateConditionalFormat: { sheetId: mainId, rule } })),
    // 2. Basic filter over header + data.
    { setBasicFilter: { filter: { range: allRows(finalCols) } } },
    // 3. Hide low-value columns.
    ...HIDE_COLUMNS.map((name) => {
      const i = colOf(name);
      return {
        updateDimensionProperties: {
          range: { sheetId: mainId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
          properties: { hidden: true },
          fields: 'hidden',
        },
      };
    }),
    // 5. Dropdown validation on human-edit columns (skip the header cell).
    ...Object.entries(VALIDATION_COLUMNS).map(([name, options]) => ({
      setDataValidation: {
        range: {
          sheetId: mainId,
          startRowIndex: 1,
          endRowIndex: lastRow,
          startColumnIndex: colOf(name),
          endColumnIndex: colOf(name) + 1,
        },
        data: {
          condition: {
            type: 'ONE_OF_LIST',
            values: options.map((v) => ({ userEnteredValue: v })),
          },
          inputMessage: '',
          showCustomUi: true,
          strict: false,
        },
      },
    })),
    // 6. Keep Days Until Due a plain integer (the subtraction can otherwise
    //    auto-format as a date serial).
    {
      repeatCell: {
        range: {
          sheetId: mainId,
          startRowIndex: 1,
          endRowIndex: lastRow,
          startColumnIndex: daysIdx,
          endColumnIndex: daysIdx + 1,
        },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    },
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
  log('Applied freeze, filter, hidden columns, conditional formats, dropdowns.');

  // --- Step 4: QUERY tabs ----------------------------------------------------
  // A column letter in QUERY is valid because the range starts at column A.
  const queryEndIdx = Math.max(colOf(DATE_SCHEDULED_FOR_COL), finalCols - 1, 77);
  const queryRange = `Inspections!A:${colToLetter(queryEndIdx)}`;

  const toCreate = [NEEDS_TAB, SCHEDULED_TAB].filter((t) => !sheetProps.has(t));
  if (toCreate.length) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
    res.data.replies.forEach((r, i) => {
      sheetProps.set(toCreate[i], { sheetId: r.addSheet.sheetId, title: toCreate[i] });
      log(`Created tab "${toCreate[i]}".`);
    });
  } else {
    log('QUERY tabs already exist — refreshing formulas in place.');
  }

  const queryTabs = [
    { title: NEEDS_TAB, where: `WHERE ${schedL} IS BLANK` },
    { title: SCHEDULED_TAB, where: `WHERE ${schedL} IS NOT BLANK` },
  ];
  for (const { title, where } of queryTabs) {
    const query = `=QUERY(${queryRange}, "${where}", 1)`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${quoteTitle(title)}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[query]] },
    });
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            updateCells: {
              range: {
                sheetId: sheetProps.get(title).sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: finalCols,
              },
              cell: { textFormat: { bold: true } },
              fields: 'textFormat.bold',
            },
          },
        ],
      },
    });
    log(`Tab "${title}" -> ${query}`);
  }

  log('Done. All formatting applied successfully.');
}

main().catch(die);
