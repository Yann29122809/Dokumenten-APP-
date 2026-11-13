// Ordner-Export: alle Dokumente als normale PDF-Dateien in einer ZIP,
// sortiert wie in der App (Ordner → Unterordner → Dokumente).
//
// WICHTIG: Der Export liest nur. Er ändert keine Dokumente, Ordner oder
// Einstellungen. Die Dateien in der ZIP sind NICHT verschlüsselt.
//
// Aufbau der ZIP:
//   Folio Backup (JJJJ-MM-TT)/
//     Inhaltsverzeichnis.csv
//     LIESMICH.txt
//     Rechnungen/…           (jeder Ordner, auch leere)
//     Ohne Ordner/…          (nur falls nötig)
//     Eingang/…              (nur falls nötig)
//     Papierkorb/…           (nur falls nötig)

import { decryptBytes, decryptJSON } from './crypto.js';
import * as db from './db.js';
import { listDocuments, loadPages, loadOriginal } from './docs.js';
import { childFolders, folderById } from './folders.js';
import { imagesToPdf } from './makepdf.js';
import { prepareImage } from './images.js';
import { reminderOf } from './deadlines.js';
import { tagsOf } from './tags.js';
import { formatDate, todayISO } from './dom.js';
import { ZipWriter, ZipTooLargeError } from './zipwriter.js';

export const MAX_FILE_NAME = 90;   // Zeichen ohne „.pdf“
export const MAX_FOLDER_NAME = 60;

export class ExportLockedError extends Error {}

// ---------------------------------------------------------------------
// Namen
// ---------------------------------------------------------------------
/** Ungültige Zeichen ersetzen, Leerzeichen glätten, kürzen. */
export function safeName(text, max, fallback) {
  let s = String(text || '')
    .normalize('NFC')
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')           // keine versteckten Dateien („.name“)
    .replace(/[. ]+$/, '');        // Windows mag keinen Punkt/Leerzeichen am Ende
  const chars = Array.from(s);     // Emojis nicht in der Mitte zerschneiden
  if (chars.length > max) s = chars.slice(0, max).join('').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `${s}-`; // reservierte Windows-Namen
  return s || fallback;
}

/** Freien Namen in einem Ordner finden: „Name“, „Name (2)“, „Name (3)“ … */
export function uniqueName(taken, base, ext = '') {
  let name = `${base}${ext}`;
  for (let n = 2; taken.has(name.toLocaleLowerCase('de')); n++) name = `${base} (${n})${ext}`;
  taken.add(name.toLocaleLowerCase('de'));
  return name;
}

const isoDate = (meta) => meta.date || (meta.created ? new Date(meta.created).toISOString().slice(0, 10) : todayISO());

// ---------------------------------------------------------------------
// Inhaltsverzeichnis (CSV für Excel: UTF-8 mit BOM, Semikolon)
// ---------------------------------------------------------------------
function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  // Schutz vor „Formeln“ in Excel (z. B. ein Titel, der mit = beginnt)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reminderText(meta) {
  const r = reminderOf(meta);
  if (!r) return '';
  return [r.kind, formatDate(r.date), r.done ? '(erledigt)' : ''].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------
// PDFs erzeugen
// ---------------------------------------------------------------------
async function documentPdf(key, doc) {
  // Importierte PDFs unverändert übernehmen (mit Textebene, beste Qualität)
  let original = null;
  try { original = await loadOriginal(key, doc); } catch { original = null; }
  if (original && /pdf/i.test(original.type || '')) return original.blob;
  const pages = await loadPages(key, doc);
  if (!pages.length) throw new Error('keine Seiten');
  return imagesToPdf(pages, doc.meta.title || 'Dokument');
}

async function inboxPdf(key, record, info) {
  const bytes = await decryptBytes(key, record.file);
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head === '%PDF-') return new Blob([bytes], { type: 'application/pdf' });
  // Bild → wie beim Scannen vorbereiten (JPEG, max. 2000 Pixel) → PDF
  const image = await prepareImage(new File([bytes], info.name || 'Bild', { type: info.type || 'image/jpeg' }));
  return imagesToPdf([image.blob], info.name || 'Eingang');
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------
/**
 * getKey()   – aktueller Schlüssel (null = App wurde gesperrt → Abbruch)
 * onProgress({ done, total, label })
 * Ergebnis: { blob, fileName, docCount, folderCount, failed: [{ path, title, reason }] }
 */
export async function exportFolderZip({ getKey, onProgress = () => {} }) {
  const needKey = () => {
    const key = getKey();
    if (!key) throw new ExportLockedError('Die App wurde gesperrt – Export abgebrochen.');
    return key;
  };

  const today = todayISO();
  const rootName = `Folio Backup (${today})`;
  const zip = new ZipWriter();
  zip.addFolder(rootName);

  // ---------- 1. Inhalte einsammeln (nur lesen) ----------
  const docs = await listDocuments(needKey());
  const inbox = [];
  for (const record of await db.getAllInbox()) {
    try {
      inbox.push({ record, info: await decryptJSON(needKey(), record.info) });
    } catch (err) {
      if (err instanceof ExportLockedError) throw err;
      inbox.push({ record, info: null });
    }
  }
  inbox.sort((a, b) => (a.record.added || 0) - (b.record.added || 0));

  // ---------- 2. Ordnerstruktur aufbauen ----------
  // Jeder Ordner bekommt einen Pfad und eine eigene Namensliste (für doppelte Namen)
  const dirs = new Map(); // Ordner-ID → { path, taken }
  const rootTaken = new Set(['inhaltsverzeichnis.csv', 'liesmich.txt']);
  let folderCount = 0;
  const walk = (parentId, parentPath, taken) => {
    for (const folder of childFolders(parentId)) {
      const name = uniqueName(taken, safeName(folder.name, MAX_FOLDER_NAME, 'Ordner'));
      const path = `${parentPath}/${name}`;
      const entry = { path, taken: new Set() };
      dirs.set(folder.id, entry);
      zip.addFolder(path);
      folderCount++;
      walk(folder.id, path, entry.taken);
    }
  };
  walk(null, rootName, rootTaken);

  const special = {};
  const specialDir = (label) => {
    if (!special[label]) {
      const path = `${rootName}/${uniqueName(rootTaken, label)}`;
      special[label] = { path, taken: new Set() };
      zip.addFolder(path);
      folderCount++;
    }
    return special[label];
  };

  // Reihenfolge: Ordner der Reihe nach, dann Ohne Ordner, Eingang, Papierkorb
  const active = docs.filter((d) => !d.meta.trashedAt);
  const trashed = docs.filter((d) => d.meta.trashedAt);
  const jobs = [];
  for (const doc of active) {
    const dir = folderById(doc.meta.category) ? dirs.get(doc.meta.category) : null;
    jobs.push({ kind: 'doc', doc, dir: dir || 'Ohne Ordner' });
  }
  for (const item of inbox) jobs.push({ kind: 'inbox', item, dir: 'Eingang' });
  for (const doc of trashed) jobs.push({ kind: 'doc', doc, dir: 'Papierkorb' });

  // ---------- 3. Dokumente nacheinander als PDF in die ZIP ----------
  const rows = [['Pfad', 'Titel', 'Datum', 'Betrag', 'Frist', 'Tags', 'Garantie bis', 'Notiz']];
  const failed = [];
  let docCount = 0;
  const total = jobs.length;
  onProgress({ done: 0, total });

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const key = needKey();
    const dir = typeof job.dir === 'string' ? specialDir(job.dir) : job.dir;
    let title;
    let date;
    let meta = null;
    if (job.kind === 'doc') {
      meta = job.doc.meta;
      title = meta.title || 'Dokument';
      date = isoDate(meta);
    } else {
      const info = job.item.info || { name: 'Unbekannte Datei' };
      title = (info.name || 'Datei').replace(/\.[a-z0-9]{2,5}$/i, '');
      date = new Date(job.item.record.added || Date.now()).toISOString().slice(0, 10);
    }
    const base = safeName(`${date} ${title}`, MAX_FILE_NAME, `${date} Dokument`);
    const fileName = uniqueName(dir.taken, base, '.pdf');
    const fullPath = `${dir.path}/${fileName}`;
    const relPath = fullPath.slice(rootName.length + 1);

    onProgress({ done: i, total, label: title });
    try {
      if (job.kind === 'inbox' && !job.item.info) throw new Error('Eintrag nicht lesbar');
      const pdf = job.kind === 'doc' ? await documentPdf(key, job.doc) : await inboxPdf(key, job.item.record, job.item.info);
      await zip.addFile(fullPath, pdf);
      docCount++;
      rows.push(meta
        ? [relPath, title, formatDate(meta.date), meta.amount || (reminderOf(meta) || {}).amount || '', reminderText(meta),
          tagsOf(meta).join(', '), meta.warrantyUntil ? formatDate(meta.warrantyUntil) : '', meta.note || '']
        : [relPath, title, '', '', '', '', '', '']);
    } catch (err) {
      if (err instanceof ExportLockedError || err instanceof ZipTooLargeError) throw err;
      if (!getKey()) throw new ExportLockedError('Die App wurde gesperrt – Export abgebrochen.');
      console.error('Export: übersprungen', title, err);
      dir.taken.delete(fileName.toLocaleLowerCase('de'));
      failed.push({ path: relPath, title, reason: (err && err.message) || 'unbekannter Fehler' });
    }
    // Speicher freigeben und der Oberfläche Zeit zum Zeichnen geben
    await pause();
  }
  onProgress({ done: total, total });

  // ---------- 4. Inhaltsverzeichnis und LIESMICH ----------
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  await zip.addFile(`${rootName}/Inhaltsverzeichnis.csv`, csv);

  const now = new Date();
  const lines = [
    'Folio – Ordner-Export',
    '=====================',
    '',
    `Exportiert am: ${now.toLocaleDateString('de-DE')} um ${now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`,
    `Dokumente: ${docCount}`,
    `Ordner: ${folderCount}`,
    '',
    'ACHTUNG: Diese Dateien sind NICHT verschlüsselt.',
    'Bewahre sie nur an einem sicheren Ort auf (z. B. verschlüsselter USB-Stick).',
    '',
    'Aufbau:',
    '- Jeder Ordner der App ist hier ein Ordner, Unterordner sind Unterordner.',
    '- Jedes Dokument ist ein PDF: „JJJJ-MM-TT Titel.pdf“ (Datum des Dokuments).',
    '- „Ohne Ordner“: Dokumente, deren Ordner es nicht mehr gibt.',
    '- „Eingang“: importierte Dateien, die noch nicht einsortiert sind.',
    '- „Papierkorb“: gelöschte Dokumente (in der App noch 30 Tage wiederherstellbar).',
    '- Inhaltsverzeichnis.csv: alle Dokumente mit Datum, Betrag, Frist, Tags, Garantie und Notiz (öffnet in Excel/Numbers).',
    '',
    'Zum Wiederherstellen in Folio bitte das verschlüsselte Backup (.dokbak) benutzen –',
    'dieser Export ist zum Anschauen und Aufbewahren gedacht.'
  ];
  if (failed.length) {
    lines.push('', `Übersprungen (${failed.length}) – diese Dokumente konnten nicht exportiert werden:`);
    failed.forEach((f) => lines.push(`- ${f.path} (${f.reason})`));
  }
  await zip.addFile(`${rootName}/LIESMICH.txt`, lines.join('\r\n') + '\r\n');

  return {
    blob: zip.finish(),
    fileName: `Folio-Backup-${today}.zip`,
    docCount,
    folderCount,
    failed
  };
}
