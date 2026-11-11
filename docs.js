// Dokumente verschlüsselt speichern, lesen, ändern und löschen.
// Alles – Titel, Ablageort, Datum, Notiz, erkannter Text, Vorschaubild und
// Seiten – wird verschlüsselt abgelegt. Unverschlüsselt ist nur eine zufällige ID.
//
// Angaben (meta): { title, category (= Ordner-ID), date, note, text, sender,
//                   pageCount, created, updated }

import { encryptBytes, decryptBytes, encryptJSON, decryptJSON } from './crypto.js';
import * as db from './db.js';

const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const jpeg = (bytes) => new Blob([bytes], { type: 'image/jpeg' });

/**
 * Neues Dokument speichern.
 * options.texts: je Seite { text, words, w, h } oder null (dann später erkennen)
 * options.file:  { bytes, type, name } – Originaldatei (z. B. PDF), unverändert
 */
export async function saveDocument(key, meta, pageBlobs, thumbBlob, options = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const fullMeta = { ...meta, pageCount: pageBlobs.length, created: now, updated: now };

  const pages = [];
  for (const blob of pageBlobs) pages.push(await encryptBytes(key, await blobBytes(blob)));

  const texts = [];
  const words = [];
  for (const t of options.texts || []) {
    texts.push(t ? await encryptJSON(key, { text: t.text || '', source: t.source || 'ocr' }) : null);
    words.push(t && t.words ? await encryptJSON(key, { w: t.w, h: t.h, words: t.words }) : null);
  }
  const file = options.file
    ? { ...(await encryptBytes(key, options.file.bytes)), info: await encryptJSON(key, { type: options.file.type, name: options.file.name, size: options.file.bytes.byteLength }) }
    : null;

  const record = {
    id,
    v: 1,
    meta: await encryptJSON(key, fullMeta),
    thumb: await encryptBytes(key, await blobBytes(thumbBlob))
  };
  await db.putDocWithPages(record, pages, { texts, words, file });
  return id;
}

/** Wörter mit Position einer Seite (für die Markierung im Bild) oder null. */
export async function loadPageWords(key, doc, index) {
  const box = await db.getPageWords(doc.id, index);
  return box ? decryptJSON(key, box) : null;
}

/** Originaldatei (z. B. PDF) oder null. */
export async function loadOriginal(key, doc) {
  const box = await db.getFile(doc.id);
  if (!box) return null;
  const info = await decryptJSON(key, box.info);
  return { ...info, blob: new Blob([await decryptBytes(key, box)], { type: info.type }) };
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

// ---------------------------------------------------------------------
// Papierkorb: Gelöschtes bleibt 30 Tage, dann wird es endgültig entfernt
// ---------------------------------------------------------------------
export const TRASH_DAYS = 30;

export async function moveToTrash(key, doc) {
  doc.meta = await updateMeta(key, doc, { trashedAt: Date.now() });
  return doc.meta;
}

export async function restoreFromTrash(key, doc) {
  doc.meta = await updateMeta(key, doc, { trashedAt: null });
  return doc.meta;
}

/** Endgültig löschen, was länger als 30 Tage im Papierkorb liegt. */
export async function purgeTrash(docs) {
  const limit = Date.now() - TRASH_DAYS * 86400000;
  let removed = 0;
  for (const doc of docs) {
    if (doc.meta.trashedAt && doc.meta.trashedAt < limit) {
      await deleteDocument(doc);
      removed++;
    }
  }
  return removed;
}
