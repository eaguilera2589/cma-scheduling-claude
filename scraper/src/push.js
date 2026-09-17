import { chromium } from 'playwright';
import { login } from './login.js';

/**
 * Reads one edited inspection record as JSON from argv[2] (n8n passes the
 * row it read back from the Google Sheet) and writes the scheduling fields
 * (appointment scheduled?, date, time, attempted-to-contact, comments) back
 * into the report on the portal.
 *
 * TODO: placeholder — needs the real report/edit-form markup from recon
 * before the field writes can be implemented.
 */
async function updateInspection(page, record) {
  throw new Error(
    'updateInspection() not implemented yet — needs the real report edit form ' +
    'markup from scraper/recon/ before selectors can be written.'
  );
}

const record = JSON.parse(process.argv[2] || '{}');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await login(page);
await updateInspection(page, record);
await browser.close();
