import { chromium } from 'playwright';
import { login } from './login.js';
import { scrapeGridRows } from './grid.js';

/**
 * Logs in, scrapes the "My Inspections" grid, and prints inspections that
 * still need scheduling as a JSON array on stdout — n8n's Execute Command
 * node pipes this straight into the Google Sheets node.
 */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await login(page);
await page.goto('https://preferred.losscontrol360.com/pages/Inspectors/', { waitUntil: 'networkidle' });

const rows = await scrapeGridRows(page);
await browser.close();

const needsScheduling = rows.filter((r) => r.RequiresScheduling);
process.stdout.write(JSON.stringify(needsScheduling, null, 2));
