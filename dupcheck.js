// Ablauf der Duplikat-Prüfung:
//  - beim Speichern (Scan und Import): neues Dokument gegen den Bestand
//  - „Duplikate suchen“ in den Einstellungen: Bestand in kleinen Portionen
//  - Fingerabdrücke älterer Dokumente werden nach dem Entsperren nebenbei
//    nachgeholt (verschlüsselt in den Angaben gespeichert)
// Nichts wird automatisch gelöscht: Entfernte Dokumente kommen 30 Tage
// in den Papierkorb, jede Aktion lässt sich 5 Sekunden rückgängig machen.

import { makeFingerprint, fingerprintFor, findMatches, compareFingerprints, isDecided, rememberNotDuplicate, forgetDecision } from './duplicates.js';
import { openDuplicateReview } from './dupreview.js';
import { updateMeta, loadThumb, loadOriginal, moveToTrash, restoreFromTrash } from './docs.js';
import { folderLabel, existingFolderId } from './folders.js';
import { makeThumb } from './images.js';
import { toast } from './dom.js';

let ctx = null;
let backfillRunning = false;

export function initDupCheck(context) {
  ctx = context;
}

const docText = (doc) => (ctx.getPageTexts(doc.id) || []).join('\n') || doc.meta.text || '';

async function originalBytes(doc) {
  if (doc.meta.source !== 'import') return null;
  const original = await loadOriginal(ctx.getKey(), doc).catch(() => null);
  return original ? new Uint8Array(await original.blob.arrayBuffer()) : null;
}

/** Fehlende Fingerabdrücke im Hintergrund berechnen (5 Dokumente pro Schritt). */
export async function backfillFingerprints(onProgress = () => {}) {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const todo = ctx.getDocs().filter((d) => !d.meta.fp);
    for (let i = 0; i < todo.length; i++) {
      const key = ctx.getKey();
      if (!key) break;
      const doc = todo[i];
      try {
        const fp = await fingerprintFor(key, doc, docText(doc), originalBytes);
        doc.meta = await updateMeta(key, doc, { fp });
      } catch (err) {
        console.warn('Fingerabdruck nicht möglich', err);
      }
      onProgress(i + 1, todo.length);
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 30)); // kurz Luft lassen
    }
  } finally {
    backfillRunning = false;
  }
}

async function cardFor(doc, label) {
  const thumb = await loadThumb(ctx.getKey(), doc).catch(() => null);
  return {
    label,
    title: doc.meta.title,
    folder: folderLabel(existingFolderId(doc.meta.category)),
    date: doc.meta.date,
    pages: doc.meta.pageCount,
    size: doc.meta.size || null,
    pixels: doc.meta.pixels || null,
    thumbUrl: thumb ? URL.createObjectURL(thumb) : null
  };
}

/**
 * Vor dem Speichern prüfen.
 * candidate: { kind, bytes?, pages: [{ blob, width, height }], texts: [{ text }], meta, sizeBytes, onUndoSkip? }
 * Ergebnis: { decision: 'save' | 'skip' | 'later', fp, afterSave(newId) }
 */
export async function checkBeforeSave(candidate) {
  const first = candidate.pages[0];
  const thumb = await makeThumb(first.blob);
  const text = (candidate.texts || []).map((t) => (t && t.text) || '').join('\n');
  const fp = await makeFingerprint({
    fileBytes: candidate.kind === 'pdf' ? candidate.bytes : null,
    firstPage: first.blob,
    thumb,
    text,
    meta: candidate.meta
  });
  const meta = { ...candidate.meta, pageCount: candidate.pages.length };
  const matches = findMatches(fp, meta, ctx.getDocs());
  const extraMeta = { fp, size: candidate.sizeBytes || first.blob.size, pixels: (first.width || 0) * (first.height || 0) };
  if (!matches.length) return { decision: 'save', extraMeta, afterSave: () => {} };

  const match = matches[0];
  const newThumbUrl = URL.createObjectURL(thumb);
  const result = await openDuplicateReview({
    mode: 'new',
    level: match.level,
    differences: match.differences,
    a: { label: 'Neu', title: meta.title, folder: folderLabel(existingFolderId(meta.category)), date: meta.date, pages: meta.pageCount, size: extraMeta.size, pixels: extraMeta.pixels, thumbUrl: newThumbUrl },
    b: await cardFor(match.doc, 'Schon vorhanden')
  });
  URL.revokeObjectURL(newThumbUrl);

  if (result.action === 'skip') return { decision: 'later', extraMeta, afterSave: () => {} };
  if (result.action === 'duplicate') {
    toast('Nicht gespeichert – Duplikat', 'ok', candidate.onUndoSkip ? { label: 'Rückgängig', onClick: candidate.onUndoSkip } : null);
    return { decision: 'skip', extraMeta, afterSave: () => {} };
  }
  // Kein Duplikat: Entscheidung für dieses Paar merken
  return {
    decision: 'save',
    extraMeta,
    afterSave: async (newId, newDoc) => {
      await rememberNotDuplicate(ctx.getKey(), newId, match.doc.id);
      toast('Beide behalten', 'ok', {
        label: 'Rückgängig',
        onClick: async () => {
          await forgetDecision(ctx.getKey(), newId, match.doc.id);
          const doc = ctx.getDocs().find((d) => d.id === newId) || newDoc;
          if (doc) await moveToTrash(ctx.getKey(), doc);
          await ctx.refresh();
          toast('Neues Dokument in den Papierkorb gelegt');
        }
      });
    }
  };
}

/** Ganzen Bestand prüfen (Button „Duplikate suchen“). */
export async function scanAllDuplicates(onStatus = () => {}) {
  onStatus('Fingerabdrücke werden berechnet …');
  await backfillFingerprints((n, total) => onStatus(`Fingerabdrücke: ${n} von ${total}`));
  const docs = ctx.getDocs().filter((d) => d.meta.fp);
  onStatus('Dokumente werden verglichen …');
  const pairs = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (isDecided(docs[i].id, docs[j].id)) continue;
      const r = compareFingerprints(docs[i].meta.fp, docs[j].meta.fp, docs[i].meta, docs[j].meta);
      if (r) pairs.push({ a: docs[i], b: docs[j], ...r });
    }
    if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
  }
  if (!pairs.length) { onStatus('Keine Duplikate gefunden'); return 0; }

  let handled = 0;
  for (const [index, pair] of pairs.entries()) {
    if (!ctx.getKey()) break;
    // Schon in diesem Durchgang entfernt?
    const current = ctx.getDocs();
    if (!current.some((d) => d.id === pair.a.id) || !current.some((d) => d.id === pair.b.id)) continue;
    const cardA = await cardFor(pair.a, 'Dokument A');
    const cardB = await cardFor(pair.b, 'Dokument B');
    onStatus(`Prüfen: ${index + 1} von ${pairs.length}`);
    const result = await openDuplicateReview({ mode: 'stored', level: pair.level, differences: pair.differences, a: cardA, b: cardB, progress: `${index + 1} von ${pairs.length}` });
    [cardA, cardB].forEach((c) => c.thumbUrl && URL.revokeObjectURL(c.thumbUrl));
    if (result.action === 'skip') continue;
    handled++;
    if (result.action === 'keep') {
      await rememberNotDuplicate(ctx.getKey(), pair.a.id, pair.b.id);
      toast('Beide behalten', 'ok', { label: 'Rückgängig', onClick: () => forgetDecision(ctx.getKey(), pair.a.id, pair.b.id) });
      continue;
    }
    // Duplikat: eines behalten, das andere in den Papierkorb – Angaben übernehmen
    const kept = result.keep === 'a' ? pair.a : pair.b;
    const removed = result.keep === 'a' ? pair.b : pair.a;
    const before = { ...kept.meta };
    const merged = {};
    if (!kept.meta.note && removed.meta.note) merged.note = removed.meta.note;
    if (!kept.meta.dueDate && removed.meta.dueDate) { merged.dueDate = removed.meta.dueDate; merged.dueDone = removed.meta.dueDone; }
    if (!kept.meta.sender && removed.meta.sender) merged.sender = removed.meta.sender;
    if (!kept.meta.tags && removed.meta.tags) merged.tags = removed.meta.tags;
    if (Object.keys(merged).length) kept.meta = await updateMeta(ctx.getKey(), kept, merged);
    await moveToTrash(ctx.getKey(), removed);
    await ctx.refresh();
    toast('In den Papierkorb gelegt', 'ok', {
      label: 'Rückgängig',
      onClick: async () => {
        await restoreFromTrash(ctx.getKey(), removed);
        if (Object.keys(merged).length) await updateMeta(ctx.getKey(), kept, before);
        await ctx.refresh();
        toast('Wiederhergestellt');
      }
    });
  }
  onStatus(handled ? `${handled} Paar(e) bearbeitet` : 'Fertig');
  return pairs.length;
}
