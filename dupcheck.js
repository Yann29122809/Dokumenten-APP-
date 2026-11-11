// Ablauf der Duplikat-Prüfung:
//  - Beim Speichern (Scan und Import) wird nichts unterbrochen. Findet die App
//    ein mögliches Duplikat, merkt sie das Paar vor („offene Prüfung“).
//  - In der Ablage erscheint dann oben ein Hinweis, am Reiter eine Markierung.
//    Antippen öffnet die Prüfung: links wischen = kein Duplikat (wird gemerkt,
//    damit nie wieder gefragt wird), rechts wischen = Duplikat (eines bleibt,
//    das andere kommt in den Papierkorb).
//  - Nach dem Entsperren werden Fingerabdrücke älterer Dokumente nebenbei
//    nachgeholt und der Bestand auf neue Paare geprüft.
// Nichts wird automatisch gelöscht: Papierkorb 30 Tage, Rückgängig 5 Sekunden.

import {
  makeFingerprint, fingerprintFor, findMatches, compareFingerprints, isDecided,
  rememberNotDuplicate, forgetDecision, addPending, removePending, getPending
} from './duplicates.js';
import { openDuplicateReview } from './dupreview.js';
import { updateMeta, loadThumb, loadOriginal, moveToTrash, restoreFromTrash } from './docs.js';
import { folderLabel, existingFolderId } from './folders.js';
import { makeThumb } from './images.js';
import { toast } from './dom.js';

let ctx = null;
let backfillRunning = false;
let reviewRunning = false;

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

/** Ganzen Bestand vergleichen und neue Paare vormerken. Ergebnis: Anzahl neu. */
export async function findAllPairs(onStatus = () => {}) {
  await backfillFingerprints((n, total) => onStatus(`Fingerabdrücke: ${n} von ${total}`));
  const docs = ctx.getDocs().filter((d) => d.meta.fp);
  onStatus('Dokumente werden verglichen …');
  const pairs = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (isDecided(docs[i].id, docs[j].id)) continue;
      const r = compareFingerprints(docs[i].meta.fp, docs[j].meta.fp, docs[i].meta, docs[j].meta);
      if (r) pairs.push({ a: docs[i].id, b: docs[j].id, level: r.level });
    }
    if (i % 25 === 24) await new Promise((r) => setTimeout(r, 0));
  }
  return ctx.getKey() ? addPending(ctx.getKey(), pairs) : 0;
}

/**
 * Vor dem Speichern: Fingerabdruck berechnen. Es wird nie unterbrochen –
 * mögliche Duplikate werden nach dem Speichern zur Prüfung vorgemerkt.
 * Ergebnis: { decision: 'save', extraMeta, afterSave(newId) }
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
  const extraMeta = { fp, size: candidate.sizeBytes || first.blob.size, pixels: (first.width || 0) * (first.height || 0) };
  return {
    decision: 'save',
    extraMeta,
    afterSave: async (newId) => {
      const matches = findMatches(fp, meta, ctx.getDocs(), newId);
      if (!matches.length) return;
      const added = await addPending(ctx.getKey(), matches.map((m) => ({ a: newId, b: m.doc.id, level: m.level })));
      if (added) {
        toast('Mögliches Duplikat gefunden', 'ok', { label: 'Prüfen', onClick: () => ctx.openReview() });
      }
    }
  };
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

/** Offene Prüfungen nacheinander zeigen. */
export async function reviewPending() {
  if (reviewRunning || !ctx.getKey()) return;
  reviewRunning = true;
  try {
    const queue = [...getPending()];
    for (const [index, pair] of queue.entries()) {
      if (!ctx.getKey()) break;
      const docs = ctx.getDocs();
      const a = docs.find((d) => d.id === pair.a);
      const b = docs.find((d) => d.id === pair.b);
      if (!a || !b) { await removePending(ctx.getKey(), pair.a, pair.b); continue; }

      const cmp = compareFingerprints(a.meta.fp, b.meta.fp, a.meta, b.meta) || { level: pair.level, differences: [] };
      const cardA = await cardFor(a, 'Neuer');
      const cardB = await cardFor(b, 'Älter');
      const result = await openDuplicateReview({
        mode: 'stored', level: cmp.level, differences: cmp.differences, a: cardA, b: cardB,
        progress: `${index + 1} von ${queue.length}`
      });
      [cardA, cardB].forEach((c) => c.thumbUrl && URL.revokeObjectURL(c.thumbUrl));

      if (result.action === 'skip') continue; // bleibt in der Liste

      if (result.action === 'keep') {
        await rememberNotDuplicate(ctx.getKey(), a.id, b.id);
        await removePending(ctx.getKey(), a.id, b.id);
        toast('Gemerkt: kein Duplikat', 'ok', {
          label: 'Rückgängig',
          onClick: async () => {
            await forgetDecision(ctx.getKey(), a.id, b.id);
            await addPending(ctx.getKey(), [pair]);
          }
        });
        continue;
      }

      // Duplikat: ausgewähltes behalten, das andere in den Papierkorb, Angaben übernehmen
      const kept = result.keep === 'a' ? a : b;
      const removed = result.keep === 'a' ? b : a;
      const before = { ...kept.meta };
      const merged = {};
      if (!kept.meta.note && removed.meta.note) merged.note = removed.meta.note;
      if (!kept.meta.reminder && removed.meta.reminder) merged.reminder = removed.meta.reminder;
      if (!kept.meta.dueDate && removed.meta.dueDate) { merged.dueDate = removed.meta.dueDate; merged.dueDone = removed.meta.dueDone; }
      if (!kept.meta.sender && removed.meta.sender) merged.sender = removed.meta.sender;
      if (!kept.meta.tags && removed.meta.tags) merged.tags = removed.meta.tags;
      if (Object.keys(merged).length) kept.meta = await updateMeta(ctx.getKey(), kept, merged);
      await moveToTrash(ctx.getKey(), removed);
      await removePending(ctx.getKey(), a.id, b.id);
      await ctx.refresh();
      toast('In den Papierkorb gelegt', 'ok', {
        label: 'Rückgängig',
        onClick: async () => {
          await restoreFromTrash(ctx.getKey(), removed);
          if (Object.keys(merged).length) await updateMeta(ctx.getKey(), kept, before);
          await addPending(ctx.getKey(), [pair]);
          await ctx.refresh();
          toast('Wiederhergestellt');
        }
      });
    }
  } finally {
    reviewRunning = false;
    await ctx.refresh();
  }
}

/** Button „Duplikate suchen“: Bestand prüfen und gleich zur Prüfung. */
export async function scanAllDuplicates(onStatus = () => {}) {
  const added = await findAllPairs(onStatus);
  const open = getPending().length;
  if (!open) { onStatus('Keine Duplikate gefunden'); return 0; }
  onStatus(added ? `${added} neu gefunden` : `${open} offen`);
  await reviewPending();
  onStatus(getPending().length ? `${getPending().length} offen` : 'Alles geprüft');
  return open;
}

/** Offene Paare mit den aktuellen Regeln erneut prüfen (entfernt Fehlalarme). */
export async function revalidatePending() {
  const docs = new Map(ctx.getDocs().map((d) => [d.id, d]));
  for (const p of [...getPending()]) {
    const a = docs.get(p.a);
    const b = docs.get(p.b);
    const still = a && b && a.meta.fp && b.meta.fp && compareFingerprints(a.meta.fp, b.meta.fp, a.meta, b.meta);
    if (!still) await removePending(ctx.getKey(), p.a, p.b);
  }
}
