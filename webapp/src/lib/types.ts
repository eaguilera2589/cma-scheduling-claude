/**
 * Shape of an inspection row as returned by /api/inspections.
 * All values are trimmed strings; a missing/blank cell is the empty string.
 *
 * The interface splits into two groups:
 * - Read-only columns, maintained by the n8n LC360 pull (PascalCase LC360
 *   keys in the sheet header row).
 * - The six human-edit columns (SixEditFields), which the webapp can also
 *   write back — see lib/sheets.ts updateInspectionFields().
 */

/** The six human-edit columns of the Inspections sheet. */
export interface SixEditFields {
  /** Sheet header: "Schedule Appointment (Y/N)" — "Y" | "N" | "". */
  scheduleAppointmentYN: string;
  /** Sheet header: "Date" — appointment date, "MM/DD/YYYY" | "". */
  date: string;
  /** Sheet header: "Time" — appointment time, "H:MM AM/PM" | "". */
  time: string;
  /** Sheet header: "Attempted to Contact" — usually "Insured" | "Agent" | "Other". */
  attemptedToContact: string;
  /** Sheet header: "Comments". */
  comments: string;
  /**
   * Sheet header: "Sync Status" — blank → "Ready to Sync" → "Synced" /
   * "Error: <reason>". The n8n Phase 2 workflow writes Synced/Error; the
   * webapp writes whatever the user selects (typically "Ready to Sync").
   */
  syncStatus: string;
}

export interface Inspection extends SixEditFields {
  caseNumber: string;
  insuredName: string;
  locationAddress: string;
  locationCity: string;
  locationState: string;
  /** Due date, "MM/DD/YYYY" (or "" if blank). */
  inspectionDue: string;
  /** Scheduled date, "MM/DD/YYYY". Empty string means NOT yet scheduled. */
  dateScheduledFor: string;
  /** "Preferred" | "Sutton" | "" */
  portal: string;
  /** "Y" | "" */
  rush: string;
  /** "Y" | "" */
  escalated: string;
  schedulingStatus: string;
  caseType: string;
  // ---- DB-only read fields (Phase 4 quick-lookup) -------------------------
  // Present in the Postgres `cases` table (maintained by the LC360 ingest);
  // the Google Sheet has no such headers, so in sheet mode these stay blank.
  // NEVER part of the six human-edit write path, and excluded from the
  // sheet→db upsert so a migrate run can never wipe the ingest's values.
  /**
   * "Contact at Insured" — DB column: contact_at_insured. Unlike its
   * neighbours below, the live sheet DOES carry this value (header
   * "PolicyContactName"), so sheet mode populates it too; see lib/sheets.ts.
   */
  contactAtInsured?: string;
  /** DB column: policy_number. */
  policyNumber?: string;
  /** DB column: phone (insured phone; LC360 precedence Cell→Home→Work). */
  phone?: string;
  /** DB column: agent_name. */
  agentName?: string;
  /** DB column: agent_number (agent phone; may be blank on some cases). */
  agentNumber?: string;
  /** DB column: caseid — the LC360 case GUID; refreshed by the LC360 ingest. */
  caseid?: string;
  /**
   * DB column: last_synced — Phase-2 write-back timestamp. NULL/blank until
   * the write-back workflow exists; nothing writes it yet.
   */
  lastSynced?: string;
}

export const EMPTY_INSPECTION: Inspection = {
  caseNumber: '',
  insuredName: '',
  locationAddress: '',
  locationCity: '',
  locationState: '',
  inspectionDue: '',
  dateScheduledFor: '',
  portal: '',
  rush: '',
  escalated: '',
  schedulingStatus: '',
  caseType: '',
  contactAtInsured: '',
  policyNumber: '',
  phone: '',
  agentName: '',
  agentNumber: '',
  caseid: '',
  lastSynced: '',
  scheduleAppointmentYN: '',
  date: '',
  time: '',
  attemptedToContact: '',
  comments: '',
  syncStatus: '',
};
