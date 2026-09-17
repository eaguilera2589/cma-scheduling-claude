import 'dotenv/config';

const BASE_URL = process.env.LC360_BASE_URL || 'https://preferred.losscontrol360.com';

/**
 * Logs into PreferredReports / Loss Control 360.
 * Confirmed live 2026-09-17: login form posts to /Login/Login (ASP.NET MVC,
 * anti-forgery token, no 2FA/CAPTCHA) with fields #UserName / #Password and
 * an <input type="image"> submit button.
 */
export async function login(page) {
  const username = process.env.LC360_USERNAME;
  const password = process.env.LC360_PASSWORD;
  if (!username || !password) {
    throw new Error('LC360_USERNAME / LC360_PASSWORD not set (see .env.example)');
  }

  await page.goto(`${BASE_URL}/Login/Login`, { waitUntil: 'networkidle' });
  await page.fill('#UserName', username);
  await page.fill('#Password', password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('input[type="image"]'),
  ]);

  if (page.url().includes('/Login/Login')) {
    throw new Error('Login appears to have failed — still on the login page after submit');
  }
}
