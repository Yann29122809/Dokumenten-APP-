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

/** Neues Dokument speichern. */
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
