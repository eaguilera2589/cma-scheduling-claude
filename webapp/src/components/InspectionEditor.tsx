'use client';

import { useEffect, useState } from 'react';
import type { Inspection, SixEditFields } from '@/lib/types';
import { CONTACT_TYPES, SYNC_STATUS_FIXED } from '@/lib/validation';
import {
  isoDateToSheet,
  optionsWithCurrent,
  sheetDateToInput,
  sheetTimeToInput,
  timeInputToSheet,
} from '@/lib/editFields';
import SyncStatusPill from './SyncStatusPill';

interface Props {
  row: Inspection;
  onClose: () => void;
  onSaved: (caseNumber: string, updated: Partial<SixEditFields>) => void;
}

const LABEL_CLASS = 'block text-xs font-medium uppercase tracking-wide text-slate-500';
const INPUT_CLASS =
  'w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none';

/**
 * Modal editor for the six human-edit fields of one case. Only fields that
 * actually changed are PATCHed, so exotic existing values (e.g. an
 * "Error: ..." Sync Status) are never rewritten by a no-op save.
 */
export default function InspectionEditor({ row, onClose, onSaved }: Props) {
  // Existing values in picker form where parseable; otherwise the raw text
  // stays in a fallback text input so it survives untouched.
  const initialDateIso = sheetDateToInput(row.date);
  const dateFallback = row.date.trim() !== '' && initialDateIso === '';
  const initialTimeInput = sheetTimeToInput(row.time);
  const timeFallback = row.time.trim() !== '' && initialTimeInput === '';

  const [yn, setYn] = useState(row.scheduleAppointmentYN);
  const [dateIso, setDateIso] = useState(initialDateIso);
  const [dateRaw, setDateRaw] = useState(row.date);
  const [timeInput, setTimeInput] = useState(initialTimeInput);
  const [timeRaw, setTimeRaw] = useState(row.time);
  const [contact, setContact] = useState(row.attemptedToContact);
  const [comments, setComments] = useState(row.comments);
  const [sync, setSync] = useState(row.syncStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Diff the form against the loaded row, in canonical sheet format. */
  function changedFields(): { edits: Partial<SixEditFields>; problem?: string } {
    const edits: Partial<SixEditFields> = {};

    const initialDate = dateFallback ? row.date : isoDateToSheet(initialDateIso);
    const candidateDate = dateFallback ? dateRaw : dateIso === '' ? '' : isoDateToSheet(dateIso);
    if (!dateFallback && dateIso !== '' && candidateDate === '') {
      return { edits, problem: 'Date is invalid; pick a real calendar date.' };
    }
    if (candidateDate !== initialDate) edits.date = candidateDate;

    const initialTime = timeFallback ? row.time : timeInputToSheet(initialTimeInput);
    const candidateTime = timeFallback ? timeRaw : timeInput === '' ? '' : timeInputToSheet(timeInput);
    if (!timeFallback && timeInput !== '' && candidateTime === '') {
      return { edits, problem: 'Time is invalid.' };
    }
    if (candidateTime !== initialTime) edits.time = candidateTime;

    if (yn !== row.scheduleAppointmentYN) edits.scheduleAppointmentYN = yn;
    if (contact !== row.attemptedToContact) edits.attemptedToContact = contact;
    if (comments !== row.comments) edits.comments = comments;
    if (sync !== row.syncStatus) edits.syncStatus = sync;
    return { edits };
  }

  async function save() {
    setError(null);
    const { edits, problem } = changedFields();
    if (problem) {
      setError(problem);
      return;
    }
    if (Object.keys(edits).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/inspections/${encodeURIComponent(row.caseNumber)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(edits),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        updated?: Partial<SixEditFields>;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? `Save failed with status ${res.status}.`);
        return;
      }
      onSaved(row.caseNumber, data?.updated ?? edits);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const syncOptions = optionsWithCurrent([...SYNC_STATUS_FIXED], sync);
  const contactOptions = optionsWithCurrent(['', ...CONTACT_TYPES], contact);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit case ${row.caseNumber}`}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white shadow-xl"
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              Case {row.caseNumber || '—'}
              <span className="ml-2 font-normal text-slate-500">{row.insuredName}</span>
            </p>
            <p className="mt-1">
              <SyncStatusPill status={row.syncStatus} />
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {error}
            </div>
          )}

          <div>
            <span className={LABEL_CLASS}>Schedule Appointment (Y/N)</span>
            <div className="mt-1 inline-flex rounded-md border border-slate-300 p-0.5" role="group">
              {[
                { value: '', label: '—' },
                { value: 'Y', label: 'Y' },
                { value: 'N', label: 'N' },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  aria-pressed={yn === opt.value}
                  disabled={saving}
                  onClick={() => setYn(opt.value)}
                  className={`rounded px-3 py-1 text-sm font-medium ${
                    yn === opt.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="editor-date">
                Date
              </label>
              {dateFallback ? (
                <input
                  id="editor-date"
                  type="text"
                  className={`mt-1 ${INPUT_CLASS}`}
                  value={dateRaw}
                  disabled={saving}
                  onChange={(e) => setDateRaw(e.target.value)}
                  placeholder="MM/DD/YYYY"
                />
              ) : (
                <input
                  id="editor-date"
                  type="date"
                  className={`mt-1 ${INPUT_CLASS}`}
                  value={dateIso}
                  disabled={saving}
                  onChange={(e) => setDateIso(e.target.value)}
                />
              )}
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="editor-time">
                Time
              </label>
              {timeFallback ? (
                <input
                  id="editor-time"
                  type="text"
                  className={`mt-1 ${INPUT_CLASS}`}
                  value={timeRaw}
                  disabled={saving}
                  onChange={(e) => setTimeRaw(e.target.value)}
                  placeholder="H:MM AM/PM"
                />
              ) : (
                <input
                  id="editor-time"
                  type="time"
                  className={`mt-1 ${INPUT_CLASS}`}
                  value={timeInput}
                  disabled={saving}
                  onChange={(e) => setTimeInput(e.target.value)}
                />
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor="editor-contact">
                Attempted to Contact
              </label>
              <select
                id="editor-contact"
                className={`mt-1 ${INPUT_CLASS}`}
                value={contact}
                disabled={saving}
                onChange={(e) => setContact(e.target.value)}
              >
                {contactOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === '' ? '— (blank)' : opt}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL_CLASS} htmlFor="editor-sync">
                Sync Status
              </label>
              <select
                id="editor-sync"
                className={`mt-1 ${INPUT_CLASS}`}
                value={sync}
                disabled={saving}
                onChange={(e) => setSync(e.target.value)}
              >
                {syncOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt === '' ? '— (blank)' : opt}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS} htmlFor="editor-comments">
              Comments
            </label>
            <textarea
              id="editor-comments"
              className={`mt-1 ${INPUT_CLASS} min-h-20`}
              rows={3}
              value={comments}
              disabled={saving}
              onChange={(e) => setComments(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
