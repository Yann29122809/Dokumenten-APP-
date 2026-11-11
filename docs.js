// Dokumente verschlüsselt speichern, lesen, ändern und löschen.
// Alles – Titel, Kategorie, Datum, Notiz, Vorschaubild und Seiten – wird
// verschlüsselt abgelegt. Unverschlüsselt ist nur eine zufällige ID.

import { encryptBytes, decryptBytes, encryptJSON, decryptJSON } from './crypto.js';
import * as db from './db.js';

export const CATEGORIES = [
  { id: 'invoice',   label: 'Rechnungen',          singular: 'Rechnung' },
  { id: 'bank',      label: 'Bank',                singular: 'Bank' },
  { id: 'insurance', label: 'Versicherung',        singular: 'Versicherung' },
  { id: 'letter',    label: 'Briefe',              singular: 'Brief' },
  { id: 'payslip',   label: 'Gehaltsabrechnungen', singular: 'Gehaltsabrechnung' }
];

export const categoryById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES[3];

const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const jpeg = (bytes) => new Blob([bytes], { type: 'image/jpeg' });

/** Neues Dokument speichern. meta: { title, category, date, note } */
export async function saveDocument(key, meta, pageBlobs, thumbBlob) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const fullMeta = { ...meta, pageCount: pageBlobs.length, created: now, updated: now };

  const pages = [];
  for (const blob of pageBlobs) pages.push(await encryptBytes(key, await blobBytes(blob)));

  const record = {
    id,
    v: 1,
    meta: await encryptJSON(key, fullMeta),
    thumb: await encryptBytes(key, await blobBytes(thumbBlob))
  };
  await db.putDocWithPages(record, pages);
  return id;
}

/** Alle Dokumente mit entschlüsselten Angaben, neueste zuerst. */
export async function listDocuments(key) {
  const records = await db.getAllDocs();
  const docs = [];
  for (const record of records) {
    try {
      docs.push({ id: record.id, meta: await decryptJSON(key, record.meta), thumb: record.thumb });
    } catch (err) {
      console.error('Dokument konnte nicht entschlüsselt werden:', record.id, err);
    }
  }
  docs.sort((a, b) =>
    (b.meta.date || '').localeCompare(a.meta.date || '') || (b.meta.created || 0) - (a.meta.created || 0)
  );
  return docs;
}

export async function loadThumb(key, doc) {
  return jpeg(await decryptBytes(key, doc.thumb));
}

export async function loadPages(key, doc) {
  const boxes = await db.getPages(doc.id, doc.meta.pageCount);
  const blobs = [];
  for (const box of boxes) {
    if (!box) throw new Error('Seite fehlt');
    blobs.push(jpeg(await decryptBytes(key, box)));
  }
  return blobs;
}

export async function updateMeta(key, doc, changes) {
  const record = await db.getDoc(doc.id);
  const meta = { ...doc.meta, ...changes, updated: Date.now() };
  record.meta = await encryptJSON(key, meta);
  await db.putDoc(record);
  return meta;
}

export function deleteDocument(doc) {
  return db.deleteDoc(doc.id, doc.meta.pageCount);
}
