/**
 * Shape of an inspection row as returned by /api/inspections.
 * All values are trimmed strings; a missing/blank cell is the empty string.
 */
export interface Inspection {
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
};
