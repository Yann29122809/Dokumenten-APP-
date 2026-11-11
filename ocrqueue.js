// Warteschlange der Texterkennung – dauerhaft gespeichert.
//
//  - Nach dem Speichern kommen Seiten ohne Text in die Warteschlange.
//  - Abgearbeitet wird eine Seite nach der anderen, nur solange die App
//    entsperrt und im Vordergrund ist. Wird die App geschlossen, geht es
//    beim nächsten Öffnen an derselben Stelle weiter.
//  - Pro Seite werden Text und Wortpositionen verschlüsselt gespeichert.
//  - In der Warteschlange selbst stehen nur IDs und Status, kein Inhalt.

import * as db from './db.js';
import { encryptJSON, decryptBytes } from './crypto.js';
import { recognizePage } from './ocr.js';
import { renderPage, loadImage } from './images.js';

const MAX_TRIES = 2;

let ctx = null;
let running = false;
let stopRequested = false;
let state = { pending: 0, errors: 0, cancelled: 0, done: 0, total: 0, current: null, progress: 0 };
const listeners = new Set();

export const onQueueChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn({ ...state, running }));
export const queueState = () => ({ ...state, running });

export function initOcrQueue(context) {
  ctx = context;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
}

async function refreshCounts() {
  const jobs = await db.getAllJobs();
  state.pending = jobs.filter((j) => j.status === 'pending').length;
  state.errors = jobs.filter((j) => j.status === 'error').length;
  state.cancelled = jobs.filter((j) => j.status === 'cancelled').length;
  return jobs;
}

/** Seiten eines Dokuments zur Texterkennung vormerken. */
export async function enqueue(docId, pageIndexes) {
  if (!pageIndexes.length) return;
  const now = Date.now();
  await db.putJobs(pageIndexes.map((page, i) => ({
    id: db.pageKey(docId, page), docId, page, status: 'pending', tries: 0, added: now + i
  })));
  state.total += pageIndexes.length;
  await refreshCounts();
  emit();
  kick();
}

const canRun = () => ctx && ctx.getKey() && ctx.isEnabled() && document.visibilityState === 'visible';

/** Warteschlange starten (falls nicht schon aktiv). */
export async function kick() {
  if (running || !canRun()) return;
  running = true;
  stopRequested = false;
  try {
    let jobs = await refreshCounts();
    if (!state.total) state.total = state.pending;
    emit();
    for (;;) {
      if (stopRequested || !canRun()) break;
      jobs = (await db.getAllJobs()).filter((j) => j.status === 'pending').sort((a, b) => a.added - b.added);
      const job = jobs[0];
      if (!job) break;
      state.current = job;
      state.progress = 0;
      emit();
      await processJob(job);
      state.done++;
      await refreshCounts();
      state.current = null;
      emit();
    }
  } catch (err) {
    console.error('Warteschlange:', err);
  } finally {
    running = false;
    state.current = null;
    await refreshCounts().catch(() => {});
    if (!state.pending) { state.total = 0; state.done = 0; }
    emit();
  }
}

async function processJob(job) {
  const key = ctx.getKey();
  try {
    const [box] = (await db.getPages(job.docId, job.page + 1)).slice(job.page);
    if (!box) { await db.deleteJob(job.id); return; } // Dokument gelöscht
    const blob = new Blob([await decryptBytes(key, box)], { type: 'image/jpeg' });
    const img = await loadImage(blob);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const prepared = await renderPage(blob, 0, true); // Schwarz-Weiß hilft der Erkennung
    const { text, words } = await recognizePage(prepared, (p) => {
      state.progress = p.phase === 'reading' ? p.progress : 0;
      state.loading = p.phase === 'loading';
      emit();
    });
    if (!ctx.getKey()) return; // inzwischen gesperrt → später erneut
    await db.putPageText(job.docId, job.page,
      await encryptJSON(key, { text, source: 'ocr' }),
      await encryptJSON(key, { w, h, words }));
    await db.deleteJob(job.id);
    ctx.onPageDone(job.docId, job.page, text);
  } catch (err) {
    console.warn('Texterkennung fehlgeschlagen:', err);
    const tries = (job.tries || 0) + 1;
    await db.putJob({ ...job, tries, status: tries >= MAX_TRIES ? 'error' : 'pending', added: Date.now() });
    if (tries >= MAX_TRIES) return;
    // kurz warten, z. B. wenn offline
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Abbrechen: offene Seiten bleiben vorgemerkt, werden aber nicht mehr bearbeitet. */
export async function cancelAll() {
  stopRequested = true;
  const jobs = await db.getAllJobs();
  await db.putJobs(jobs.filter((j) => j.status === 'pending').map((j) => ({ ...j, status: 'cancelled' })));
  await refreshCounts();
  state.total = 0;
  state.done = 0;
  emit();
}

/** Wiederholen: fehlgeschlagene und abgebrochene Seiten erneut versuchen. */
export async function retryAll() {
  const jobs = await db.getAllJobs();
  await db.putJobs(jobs.filter((j) => j.status !== 'pending').map((j) => ({ ...j, status: 'pending', tries: 0, added: Date.now() })));
  await refreshCounts();
  state.total = state.pending;
  state.done = 0;
  emit();
  kick();
}

/** Beim Sperren anhalten. */
export function pauseQueue() {
  stopRequested = true;
}
