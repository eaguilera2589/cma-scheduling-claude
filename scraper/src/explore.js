import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { login } from './login.js';

/**
 * One-time recon: log in and save the post-login landing page (HTML +
 * screenshot) plus any inspections/reports list we can find by following
 * obvious nav links. Run this once real credentials are available, then use
 * its output (scraper/recon/) to write the real selectors in pull.js/push.js
 * — the authenticated site structure is unknown until this has run.
 */
const OUT_DIR = new URL('../recon/', import.meta.url);

async function dump(page, name) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL(`${name}.html`, OUT_DIR), await page.content());
  await page.screenshot({ path: new URL(`${name}.png`, OUT_DIR).pathname, fullPage: true });
  console.log(`saved recon/${name}.{html,png} — url: ${page.url()}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await login(page);
await dump(page, '01-landing');

// Best-effort: click through to whatever looks like the inspections/reports
// list so we capture that page too. Adjust once we see the real landing page.
const candidates = ['Inspections', 'Reports', 'Assignments', 'My Reports'];
for (const text of candidates) {
  const link = page.getByRole('link', { name: text, exact: false }).first();
  if (await link.count()) {
    await Promise.all([page.waitForLoadState('networkidle'), link.click()]);
    await dump(page, `02-${text.replace(/\s+/g, '-').toLowerCase()}`);
    break;
  }
}

await browser.close();
