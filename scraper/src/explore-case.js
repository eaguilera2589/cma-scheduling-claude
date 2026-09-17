import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { login } from './login.js';

// One-off: dump a single case detail page so we can find the scheduling
// edit fields. Pass a CaseID as argv[2], or it defaults to one seen in the
// landing-page recon.
const caseId = process.argv[2] || '68b73b8d-5339-4ec0-9e63-e3a0e0c55838';
const OUT_DIR = new URL('../recon/', import.meta.url);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await login(page);
await page.goto(`https://preferred.losscontrol360.com/pages/cases/default.aspx?CaseID=${caseId}`, { waitUntil: 'networkidle' });
await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('03-case-detail.html', OUT_DIR), await page.content());
await page.screenshot({ path: new URL('03-case-detail.png', OUT_DIR).pathname, fullPage: true });
console.log('saved recon/03-case-detail.{html,png} — url:', page.url());
await browser.close();
