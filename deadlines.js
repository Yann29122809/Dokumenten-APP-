// Fristen: Anzeige („in 3 Tagen“) und Kalender-Einträge (.ics-Datei).
// Der Kalender-Eintrag wird auf dem iPhone erzeugt und an die Kalender-App
// übergeben – es gibt keinen Server dazwischen.

import { formatDate } from './dom.js';

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

/** Offene Fristen, früheste zuerst. */
export function openDeadlines(docs) {
  return docs
    .filter((d) => d.meta.dueDate && !d.meta.dueDone)
    .sort((a, b) => a.meta.dueDate.localeCompare(b.meta.dueDate));
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

/**
 * Kalenderdatei für eine Frist.
 * withTitle = false → neutraler Eintrag ohne Inhalt des Dokuments.
 */
export function buildIcs(doc, withTitle) {
  const day = doc.meta.dueDate.replace(/-/g, '');
  const end = new Date(startOfDay(doc.meta.dueDate).getTime() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  const endDay = `${end.getFullYear()}${pad(end.getMonth() + 1)}${pad(end.getDate())}`;
  const summary = withTitle ? `Frist: ${doc.meta.title}` : 'Frist – Dokumente-App';
  const description = withTitle
    ? [doc.meta.note, 'Details in der Dokumente-App.'].filter(Boolean).join('\n')
    : 'Ein Dokument in deiner Dokumente-App hat heute eine Frist. Öffne die App für Details.';

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dokumente-App//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@dokumente-app`,
    `DTSTAMP:${utcStamp()}`,
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${endDay}`,
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    'TRANSP:TRANSPARENT',
    // Erinnerung am Vortag um 9 Uhr …
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    'TRIGGER:-PT15H',
    'END:VALARM',
    // … und am Tag selbst um 9 Uhr
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    'TRIGGER:PT9H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/**
 * Frist an den Kalender übergeben. Auf dem iPhone öffnet sich der
 * Kalender-Dialog „Hinzufügen“. Muss direkt nach dem Antippen laufen.
 */
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

/** Alternative: Kalenderdatei über das Teilen-Menü weitergeben. */
export async function shareCalendarFile(doc, withTitle) {
  const file = new File([buildIcs(doc, withTitle)], 'Frist.ics', { type: 'text/calendar' });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) return false;
  try {
    await navigator.share({ files: [file] });
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }
  return true;
}
