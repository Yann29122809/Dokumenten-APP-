// Erinnerungen (Fristen): Modell, Anzeige, Eingabefelder und Kalender (.ics).
//
// Eine Erinnerung gehört zu einem Dokument und steht verschlüsselt in
// dessen Angaben: meta.reminder = { date, kind, amount, lead: [7, 1, 0], done }
// Ältere Dokumente hatten nur meta.dueDate/meta.dueDone – die werden hier
// gelesen, als wären sie eine Erinnerung (keine Umstellung der Daten nötig).
//
// Wichtig: Die App schlägt Erinnerungen nur VOR. Gesetzt wird eine
// Erinnerung erst, wenn du sie bestätigst oder selbst einträgst.

import { el, formatDate, todayISO } from './dom.js';

export const KINDS = ['Zahlung', 'Kündigung', 'Widerspruch', 'Ablauf', 'Frist', 'Sonstiges'];
export const LEADS = [
  { days: 7, label: '7 Tage vorher' },
  { days: 3, label: '3 Tage vorher' },
  { days: 1, label: '1 Tag vorher' },
  { days: 0, label: 'Am Tag selbst' }
];
export const DEFAULT_LEAD = [1, 0];

/** Erinnerung eines Dokuments (auch aus dem alten Format) oder null. */
export function reminderOf(meta) {
  if (meta.reminder && meta.reminder.date) return meta.reminder;
  if (meta.dueDate) return { date: meta.dueDate, kind: 'Frist', amount: null, lead: DEFAULT_LEAD, done: Boolean(meta.dueDone) };
  return null;
}

/** Änderungen für updateMeta – alte Felder werden mitgeführt. */
export function reminderChanges(reminder) {
  return {
    reminder: reminder || null,
    dueDate: reminder ? reminder.date : null,
    dueDone: reminder ? Boolean(reminder.done) : false,
    reminderSuggestion: null
  };
}

function startOfDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysUntil(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((startOfDay(iso) - today) / 86400000);
}

export function dueLabel(iso) {
  const days = daysUntil(iso);
  if (days < -1) return `seit ${-days} Tagen überfällig`;
  if (days === -1) return 'seit gestern überfällig';
  if (days === 0) return 'heute fällig';
  if (days === 1) return 'morgen fällig';
  if (days < 14) return `in ${days} Tagen`;
  return `am ${formatDate(iso)}`;
}

export function dueClass(iso) {
  const days = daysUntil(iso);
  if (days < 0) return 'is-overdue';
  if (days <= 3) return 'is-soon';
  return '';
}

/** Offene Erinnerungen, früheste zuerst (ohne Papierkorb). */
export function openDeadlines(docs) {
  return docs
    .filter((d) => !d.meta.trashedAt)
    .map((d) => ({ doc: d, r: reminderOf(d.meta) }))
    .filter((x) => x.r && !x.r.done)
    .sort((a, b) => a.r.date.localeCompare(b.r.date))
    .map((x) => x.doc);
}

// ---------------------------------------------------------------------
// Eingabefelder (beim Scannen und beim Bearbeiten)
// ---------------------------------------------------------------------
/**
 * Felder für eine Erinnerung. Ergebnis: { node, read(), set(reminder), isActive() }
 * read() liefert null, wenn keine Erinnerung gesetzt ist.
 */
export function reminderFields(initial = null) {
  let active = Boolean(initial);
  const date = el('input', { type: 'date', 'aria-label': 'Datum der Erinnerung' });
  const kind = el('select', { 'aria-label': 'Art' }, KINDS.map((k) => el('option', { value: k, text: k })));
  const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: 'z. B. 89,90 €', maxlength: '30', 'aria-label': 'Betrag' });
  const leadBoxes = LEADS.map((l) => el('label', { class: 'check lead' },
    el('input', { type: 'checkbox', value: String(l.days) }), l.label));
  const addBtn = el('button', { type: 'button', class: 'btn-text with-icon reminder-add', text: '+ Erinnerung hinzufügen' });
  const removeBtn = el('button', { type: 'button', class: 'btn-text danger small', text: 'Erinnerung entfernen' });
  const fields = el('div', { class: 'reminder-fields' },
    el('div', { class: 'reminder-grid' },
      el('label', {}, 'Fällig am', date),
      el('label', {}, 'Art', kind)
    ),
    el('label', {}, 'Betrag (optional)', amount),
    el('div', { class: 'lead-group' }, el('span', { class: 'lead-title', text: 'Erinnern' }), ...leadBoxes),
    removeBtn
  );
  const node = el('div', { class: 'reminder-editor' }, addBtn, fields);

  const set = (r) => {
    active = Boolean(r);
    const value = r || { date: '', kind: 'Zahlung', amount: '', lead: DEFAULT_LEAD };
    date.value = value.date || '';
    kind.value = KINDS.includes(value.kind) ? value.kind : 'Frist';
    amount.value = value.amount || '';
    const lead = value.lead && value.lead.length ? value.lead : DEFAULT_LEAD;
    leadBoxes.forEach((box) => { box.firstChild.checked = lead.includes(Number(box.firstChild.value)); });
    fields.hidden = !active;
    addBtn.hidden = active;
  };
  addBtn.addEventListener('click', () => {
    set({ date: '', kind: 'Zahlung', amount: '', lead: DEFAULT_LEAD });
    date.focus();
  });
  removeBtn.addEventListener('click', () => set(null));
  set(initial);

  return {
    node,
    set,
    isActive: () => active,
    read: () => {
      if (!active || !date.value) return null;
      const lead = leadBoxes.filter((b) => b.firstChild.checked).map((b) => Number(b.firstChild.value));
      return {
        date: date.value,
        kind: kind.value,
        amount: amount.value.trim() || null,
        lead: lead.length ? lead : [0],
        done: initial ? Boolean(initial.done) && initial.date === date.value : false
      };
    }
  };
}

/** Karte „Erinnerung vorgeschlagen“ – nichts wird ohne Bestätigung gesetzt. */
export function suggestionCard(suggestion, { onAccept, onEdit, onDismiss }) {
  return el('div', { class: 'reminder-suggestion' },
    el('div', { class: 'rs-text' },
      el('strong', { text: 'Erinnerung vorschlagen?' }),
      el('span', { text: [suggestion.kind, formatDate(suggestion.date), suggestion.amount].filter(Boolean).join(' · ') })
    ),
    el('div', { class: 'rs-actions' },
      el('button', { type: 'button', class: 'btn-secondary', text: 'Übernehmen', onclick: onAccept }),
      el('button', { type: 'button', class: 'btn-text', text: 'Ändern', onclick: onEdit }),
      el('button', { type: 'button', class: 'btn-text', text: 'Nein danke', onclick: onDismiss })
    )
  );
}

// ---------------------------------------------------------------------
// Kalender
// ---------------------------------------------------------------------
const icsText = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Zeilen dürfen höchstens 75 Zeichen lang sein (Standard für Kalenderdateien)
function fold(line) {
  const parts = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = ' ' + rest.slice(74);
  }
  parts.push(rest);
  return parts.join('\r\n');
}

function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Erinnerung um 9 Uhr, „days“ Tage vor dem (ganztägigen) Termin
function trigger(days) {
  if (days <= 0) return 'PT9H';
  return days === 1 ? '-PT15H' : `-P${days - 1}DT15H`;
}

/**
 * Kalenderdatei für eine Erinnerung.
 * withTitle = false → neutral: ohne Titel, Beträge und Nummern.
 */
export function buildIcs(doc, withTitle) {
  const r = reminderOf(doc.meta) || { date: todayISO(), kind: 'Frist', lead: DEFAULT_LEAD };
  const day = r.date.replace(/-/g, '');
  const end = new Date(startOfDay(r.date).getTime() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const endDay = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;
  const summary = withTitle ? `${r.kind}: ${doc.meta.title}` : 'Frist – Folio';
  const description = withTitle
    ? [r.amount ? `Betrag: ${r.amount}` : null, 'Details in Folio.'].filter(Boolean).join('\n')
    : 'Ein Dokument in Folio hat eine Frist. Öffne die App für Details.';

  const alarms = [...new Set(r.lead && r.lead.length ? r.lead : DEFAULT_LEAD)].sort((a, b) => b - a).flatMap((days) => [
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    `TRIGGER:${trigger(days)}`,
    'END:VALARM'
  ]);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Folio//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@folio`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${endDay}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    'TRANSP:TRANSPARENT',
    ...alarms,
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Kalenderdatei über das Teilen-Menü weitergeben (z. B. an „Kalender“). */
export async function shareCalendarFile(doc, withTitle) {
  const file = new File([buildIcs(doc, withTitle)], 'Erinnerung.ics', { type: 'text/calendar' });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return true;
}

/** Kalenderdatei direkt öffnen – das iPhone zeigt dann „Zum Kalender hinzufügen“. */
export function openInCalendar(doc, withTitle) {
  const blob = new Blob([buildIcs(doc, withTitle)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
