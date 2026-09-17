/**
 * Extracts rows from the "My Inspections" Kendo grid (#slCasesGrid) on
 * https://preferred.losscontrol360.com/pages/Inspectors/. The grid splits
 * into a locked table (Case Number, Policy Number) and a scrollable content
 * table (everything else), correlated per-row by a shared data-uid — a
 * standard Kendo UI "locked columns" layout. Rows needing scheduling carry
 * the CSS class `RequiresScheduling` (confirmed live 2026-09-17).
 */
export async function scrapeGridRows(page) {
  return page.evaluate(() => {
    const grid = document.getElementById('slCasesGrid');
    if (!grid) throw new Error('#slCasesGrid not found — page structure may have changed');

    const fieldsOf = (sel) =>
      [...grid.querySelectorAll(`${sel} th[data-field]`)].map((th) => th.getAttribute('data-field'));
    const lockedFields = fieldsOf('.k-grid-header-locked');
    const contentFields = fieldsOf('.k-grid-header-wrap');

    const contentRowsByUid = new Map();
    for (const tr of grid.querySelectorAll('.k-grid-content tbody tr')) {
      contentRowsByUid.set(tr.getAttribute('data-uid'), tr);
    }

    const rows = [];
    for (const lockedTr of grid.querySelectorAll('.k-grid-content-locked tbody tr')) {
      const uid = lockedTr.getAttribute('data-uid');
      const contentTr = contentRowsByUid.get(uid);
      if (!contentTr) continue;

      const requiresScheduling =
        lockedTr.className.includes('RequiresScheduling') || contentTr.className.includes('RequiresScheduling');

      const caseLink = lockedTr.querySelector('a[href*="CaseID="]');
      const caseId = caseLink ? new URL(caseLink.href).searchParams.get('CaseID') : null;

      const record = {
        CaseID: caseId,
        PortalLink: caseLink ? caseLink.href : null,
        RequiresScheduling: requiresScheduling,
      };
      lockedFields.forEach((f, i) => {
        record[f] = lockedTr.querySelectorAll('td')[i]?.innerText.trim() ?? '';
      });
      contentFields.forEach((f, i) => {
        record[f] = contentTr.querySelectorAll('td')[i]?.innerText.trim() ?? '';
      });
      rows.push(record);
    }
    return rows;
  });
}
