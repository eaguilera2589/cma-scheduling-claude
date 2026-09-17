import { chromium } from 'playwright';
import { login } from './login.js';

const BASE = 'https://preferred.losscontrol360.com';

/**
 * Writes one scheduling update back into a Loss Control 360 case, using the
 * same JSON API the case-detail page's "Attempted to Contact / Schedule an
 * Appointment" widget calls (confirmed live 2026-09-17 by reading the page's
 * own JS — see scraper/recon/03-case-detail.html around the #btnSchedule
 * click handler). This writes only to the case's Scheduling Summary Info —
 * never touch the separate general Case Notes log/API for this workflow.
 *
 * record shape (one row from the Google Sheet, after Enrique edits it):
 *   {
 *     CaseID: "guid",
 *     Action: "appointment" | "attempt",   // "Schedule Appointment? Y" -> appointment, else attempt
 *     Date: "MM/DD/YYYY",
 *     Time: "HH:MM AM/PM",
 *     ScheduledWith: "Insured" | "Agent" | ...,  // must match a SchedulingContactTypes.Name for this case
 *     Comments: "free text",
 *   }
 */
export async function pushScheduleUpdate(page, record) {
  const { CaseID, Action, Date: date, Time: time, ScheduledWith, Comments } = record;
  if (!CaseID) throw new Error('record.CaseID is required');
  if (Action !== 'appointment' && Action !== 'attempt') {
    throw new Error(`record.Action must be "appointment" or "attempt", got: ${Action}`);
  }

  // The user's account id is embedded in every authenticated page's "My
  // Account" link (../users/edit.aspx?userID=...) — same value the
  // scheduling widget submits as UserId.
  const userId = await page.evaluate(() => {
    const el = document.querySelector('a[href*="users/edit.aspx?userID="]');
    if (!el) return null;
    return new URL(el.href).searchParams.get('userID');
  });
  if (!userId) throw new Error('Could not find current user id on page — is the session logged in?');

  const notesRes = await page.request.get(`${BASE}/api/CaseScheduling/GetCaseScheduleNotes`, {
    params: { caseid: CaseID, systemrole: 'Inspector' },
  });
  if (!notesRes.ok()) throw new Error(`GetCaseScheduleNotes failed: ${notesRes.status()}`);
  const notes = await notesRes.json();

  const contactType = (notes.SchedulingContactTypes || []).find(
    (t) => t.Name.toLowerCase() === String(ScheduledWith || '').toLowerCase()
  );
  if (!contactType) {
    const options = (notes.SchedulingContactTypes || []).map((t) => t.Name).join(', ');
    throw new Error(`ScheduledWith "${ScheduledWith}" not a valid contact type for this case. Options: ${options}`);
  }

  const payload = {
    CaseID,
    UserId: userId,
    SchedulingContactId: contactType.SchedulingContactTypeID,
    ScheduleDate: date,
    ScheduleTime: time,
    NoteText: Comments || '',
    ScheduleType: Action === 'appointment' ? '1' : '0',
    SessionWith: -1,
  };

  const res = await page.request.post(`${BASE}/api/CaseScheduling/AddScheduleItem`, { form: payload });
  if (!res.ok()) throw new Error(`AddScheduleItem failed: ${res.status()} ${await res.text()}`);
  const data = await res.json();
  if (!data.Success) throw new Error(`AddScheduleItem reported failure: ${JSON.stringify(data)}`);
  return data;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const record = JSON.parse(process.argv[2] || '{}');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await login(page);
  const result = await pushScheduleUpdate(page, record);
  await browser.close();
  process.stdout.write(JSON.stringify(result, null, 2));
}
