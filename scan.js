// Bildschirm „Scannen“: Fotos aufnehmen, Seiten sortieren/drehen,
// Text erkennen, Vorschläge eintragen und verschlüsselt speichern.

import { el, todayISO, formatDate, formatBytes, toast } from './dom.js';
import { icon } from './icons.js';
import { prepareImage, renderPage, makeThumb, loadImage } from './images.js';
import { saveDocument } from './docs.js';
import {
  fillFolderSelect, folderLabel, folderSingular, existingFolderId, askAndCreateFolder, onFoldersChanged, allFolders
} from './folders.js';
import { recognizePage } from './ocr.js';
import { detectDocument, warpImage, fullQuad } from './crop.js';
import { openCropper } from './cropper.js';
import { suggestFromText } from './suggest.js';
import { reminderFields, reminderChanges } from './deadlines.js';
import { imagesToPdf } from './makepdf.js';
import { tagEditor, allTags } from './tags.js';

const $ = (id) => document.getElementById(id);

let ctx = null;
// Seite: { original, origUrl, origW, origH, quad, autoQuad, blob, url, rotation, ratio, ocr: { status, text } }
let pages = [];
let busy = false;
let preparing = 0;   // Bilder, die gerade eingelesen werden (Platzhalter mit Animation)
let draftId = 0;     // wird beim Verwerfen erhöht → laufende Erkennung ignoriert
let ocrRunning = null;
let ocrError = false;
let dirty = {};      // Felder, die du selbst geändert hast, werden nicht überschrieben
let suggestion = null;
let lastFolderId = 'invoice';

const FIELDS = { category: 'doc-category', title: 'doc-title', date: 'doc-date', note: 'doc-note', amount: 'doc-amount' };
let reminder = null;          // Eingabefelder der Erinnerung
let tags = null;              // Tag-Eingabe
let reminderDismissed = false; // Vorschlag abgelehnt

export function initScan(context) {
  ctx = context;
  reminder = reminderFields(null);
  $('reminder-slot').replaceChildren(reminder.node);
  tags = tagEditor([], []);
  $('scan-tags-slot').replaceChildren(tags.node);
  $('doc-date').value = todayISO();

  const pick = (inputId) => () => {
    if (busy) return;
    ctx.suspendAutoLock();
    $(inputId).click();
  };
  $('scan-camera').addEventListener('click', pick('input-camera'));
  $('scan-library').addEventListener('click', pick('input-library'));
  // Weitere Seite: eigene Live-Kamera, sonst die iPhone-Kamera
  $('scan-add-camera').addEventListener('click', () => {
    if (busy) return;
    if (ctx.openCamera) ctx.openCamera(); else pick('input-camera')();
  });
  $('scan-add-library').addEventListener('click', pick('input-library'));

  ['input-camera', 'input-library'].forEach((id) => {
    const input = $(id);
    input.addEventListener('change', async () => {
      ctx.resumeAutoLock();
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length) await addFiles(files);
    });
    input.addEventListener('cancel', () => ctx.resumeAutoLock());
  });

  // Merken, welche Felder du selbst bearbeitet hast
  for (const [name, id] of Object.entries(FIELDS)) {
    $(id).addEventListener('input', () => { dirty[name] = true; unmark(name); });
  }
  $('doc-title').addEventListener('input', renderSummary);

  const select = $('doc-category');
  select.addEventListener('change', async () => {
    dirty.category = true;
    unmark('category');
    if (select.value !== '__new') { lastFolderId = select.value; return; }
    const folder = await askAndCreateFolder(ctx.getKey(), lastFolderId);
    if (folder) lastFolderId = folder.id;
    fillFolderSelect(select, lastFolderId, { allowNew: true });
  });

  onFoldersChanged(() => {
    if (!allFolders().length) { select.replaceChildren(); return; }
    fillFolderSelect(select, existingFolderId(select.value || lastFolderId), { allowNew: true });
  });

  $('scan-filter').addEventListener('change', render);
  $('scan-form').addEventListener('submit', onSave);
  $('scan-later').addEventListener('click', onLater);
  $('scan-discard').addEventListener('click', () => {
    if (confirm('Diesen Scan verwerfen? Die Fotos werden gelöscht.')) clearScan();
  });
}

function setStatus(text) {
  $('scan-status').textContent = text;
}

// Fotos aus der Live-Kamera kommen einzeln und schnell hintereinander –
// sie werden der Reihe nach eingelesen.
let captureChain = Promise.resolve();
export function addCapturedFile(file) {
  const myDraft = draftId;
  preparingQueued++;
  render();
  captureChain = captureChain.then(async () => {
    preparingQueued--;
    if (myDraft !== draftId) return;
    await addFiles([file]);
  }).catch((err) => console.error(err));
  return captureChain;
}
let preparingQueued = 0;

async function addFiles(files) {
  busy = true;
  setStatus(files.length > 1 ? `${files.length} Bilder werden vorbereitet …` : 'Bild wird vorbereitet …');
  let failed = 0;
  preparing = files.length;
  render();
  for (const file of files) {
    try {
      const original = await prepareImage(file);
      const page = {
        original: original.blob, origUrl: URL.createObjectURL(original.blob), origW: original.width, origH: original.height,
        quad: null, autoQuad: null, blob: original.blob, url: null, rotation: 0, ratio: original.height / original.width,
        ocr: { status: 'pending', text: '' }
      };
      // Blatt automatisch finden und gerade ziehen
      if (ctx.isAutoCropEnabled()) {
        try {
          setStatus('Blatt wird gesucht und gerade gezogen …');
          page.autoQuad = await detectDocument(original.blob);
          if (page.autoQuad) await applyCrop(page, page.autoQuad);
        } catch (err) {
          console.warn('Zuschneiden nicht möglich:', err);
        }
      }
      if (!page.url) page.url = page.origUrl;
      pages.push(page);
    } catch (err) {
      console.error(err);
      failed++;
    }
    preparing = Math.max(0, preparing - 1);
    render();
  }
  preparing = 0;
  busy = false;
  setStatus(failed ? `${failed} Bild(er) konnten nicht gelesen werden.` : '');
  render();
  startOcr();
}

// ---------------------------------------------------------------------
// Seiten anzeigen
// ---------------------------------------------------------------------
function render() {
  // Vorschläge für Tags aus den vorhandenen Dokumenten
  if (tags && ctx.getKey()) tags.setSuggestions(allTags(ctx.getDocs()).map((t) => t.tag));
  const waiting = preparing + preparingQueued;
  const hasPages = pages.length > 0 || waiting > 0;
  $('scan-empty').hidden = hasPages;
  $('scan-draft').hidden = !hasPages;
  if (ctx.onDraftChange) ctx.onDraftChange(hasPages);

  const filter = $('scan-filter').checked;
  $('scan-pages').replaceChildren(...pages.map((page, i) => el('figure', { class: 'page-tile' },
    el('div', { class: 'page-frame' },
      el('img', {
        src: page.url,
        alt: `Seite ${i + 1}`,
        class: filter ? 'scan-filter' : '',
        style: { transform: `rotate(${page.rotation}deg) scale(${previewScale(page)})` }
      })
    ),
    el('figcaption', {},
      el('span', { text: `Seite ${i + 1}` }),
      el('span', { class: 'tile-actions' },
        i > 0 ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Seite ${i + 1} nach vorne`, onclick: () => move(i, -1) }, icon('left')) : null,
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Seite ${i + 1} zuschneiden`, onclick: () => crop(i) }, icon('crop')),
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Seite ${i + 1} drehen`, onclick: () => rotate(i) }, icon('rotate')),
        el('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Seite ${i + 1} löschen`, onclick: () => removePage(i) }, icon('trash'))
      )
    )
  )));
  // Platzhalter für Bilder, die gerade eingelesen werden
  for (let i = 0; i < waiting; i++) {
    $('scan-pages').append(el('figure', { class: 'page-tile' },
      el('div', { class: 'page-frame scanning' }, el('span', { class: 'scan-label', text: 'Wird eingelesen …' })),
      el('figcaption', {}, el('span', { text: 'Neue Seite' }))));
  }
  renderSummary();
  renderOcrStatus();
}

// Kopfkarte: Vorschau, Titel, Seitenzahl und Größe
let summaryUrl = null;
function renderSummary() {
  const n = pages.length;
  const size = pages.reduce((sum, p) => sum + (p.blob ? p.blob.size : 0), 0);
  $('scan-count').textContent = [n === 1 ? '1 Seite' : `${n} Seiten`, size ? formatBytes(size) : null].filter(Boolean).join(' · ');
  $('scan-sum-title').textContent = $('doc-title').value.trim() || 'Neuer Scan';
  const box = $('scan-thumb');
  const first = pages[0];
  box.classList.toggle('is-stack', n > 1);
  if (!first) { box.replaceChildren(); summaryUrl = null; return; }
  if (summaryUrl === first.url && box.firstChild) return;
  summaryUrl = first.url;
  box.replaceChildren(el('img', { src: first.url, alt: '', class: $('scan-filter').checked ? 'scan-filter' : '' }));
}

// Damit ein gedrehtes Bild genau in den Rahmen (Seitenverhältnis 3:4) passt
function previewScale(page) {
  if (page.rotation % 180 === 0) return 1;
  const frameW = 1;
  const frameH = 4 / 3;
  const shownW = Math.min(frameW, frameH / page.ratio);
  const shownH = shownW * page.ratio;
  return Math.min(1, frameW / shownH, frameH / shownW);
}

async function applyCrop(page, quad) {
  const isFull = quad.every(([x, y], i) => {
    const [fx, fy] = fullQuad(page.origW, page.origH)[i];
    return Math.abs(x - fx) < 2 && Math.abs(y - fy) < 2;
  });
  if (page.url && page.url !== page.origUrl) URL.revokeObjectURL(page.url);
  if (isFull) {
    page.quad = null;
    page.blob = page.original;
    page.url = page.origUrl;
    page.ratio = page.origH / page.origW;
    return;
  }
  const result = await warpImage(page.original, quad);
  page.quad = quad;
  page.blob = result.blob;
  page.url = URL.createObjectURL(result.blob);
  page.ratio = result.height / result.width;
}

async function crop(i) {
  const page = pages[i];
  const quad = await openCropper({ url: page.origUrl, width: page.origW, height: page.origH, quad: page.quad, autoQuad: page.autoQuad });
  if (!quad || !pages.includes(page)) return;
  busy = true;
  setStatus('Wird zugeschnitten …');
  try {
    await applyCrop(page, quad);
    page.ocr = { status: 'pending', text: '' };
  } catch (err) {
    console.error(err);
    setStatus('Zuschneiden hat nicht geklappt.');
  } finally {
    busy = false;
  }
  if ($('scan-status').textContent === 'Wird zugeschnitten …') setStatus('');
  render();
  startOcr();
}

function rotate(i) {
  pages[i].rotation = (pages[i].rotation + 90) % 360;
  pages[i].ocr = { status: 'pending', text: '' }; // gedreht → Text neu erkennen
  render();
  startOcr();
}

function move(i, delta) {
  const j = i + delta;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  render();
  applySuggestion();
}

function releasePage(page) {
  if (page.url && page.url !== page.origUrl) URL.revokeObjectURL(page.url);
  URL.revokeObjectURL(page.origUrl);
}

function removePage(i) {
  releasePage(pages[i]);
  pages.splice(i, 1);
  render();
  applySuggestion();
}

// ---------------------------------------------------------------------
// Texterkennung
// ---------------------------------------------------------------------
let ocrProgress = null;

function startOcr() {
  if (!ctx.isOcrEnabled() || ocrRunning) return ocrRunning;
  ocrError = false;
  const myDraft = draftId;
  ocrRunning = (async () => {
    for (;;) {
      if (myDraft !== draftId) return;
      const page = pages.find((p) => p.ocr.status === 'pending');
      if (!page) return;
      const rotation = page.rotation;
      page.ocr.status = 'running';
      renderOcrStatus();
      try {
        const image = await renderPage(page.blob, rotation, true);
        const { text, words } = await recognizePage(image, (p) => { ocrProgress = p; renderOcrStatus(); });
        const dims = await loadImage(image);
        if (myDraft !== draftId) return;
        if (page.rotation === rotation && pages.includes(page)) {
          page.ocr = { status: 'done', text, words, w: dims.naturalWidth, h: dims.naturalHeight };
        }
      } catch (err) {
        console.error(err);
        if (myDraft !== draftId) return;
        pages.forEach((p) => { if (p.ocr.status !== 'done') p.ocr.status = 'error'; });
        ocrError = true;
        return;
      } finally {
        ocrProgress = null;
      }
      applySuggestion();
      renderOcrStatus();
    }
  })().finally(() => {
    if (myDraft !== draftId) return;
    ocrRunning = null;
    // Falls genau jetzt eine neue Seite dazukam
    if (!ocrError && pages.some((p) => p.ocr.status === 'pending')) startOcr();
    renderOcrStatus();
  });
  return ocrRunning;
}

// Scanner-Animation auf den Seiten, deren Text gerade erkannt wird
function updateScanMarks() {
  const frames = document.querySelectorAll('#scan-pages .page-tile .page-frame');
  pages.forEach((page, i) => {
    const frame = frames[i];
    if (!frame) return;
    const active = ctx.isOcrEnabled() && !ocrError && ['pending', 'running'].includes(page.ocr.status);
    frame.classList.toggle('scanning', active);
    let label = frame.querySelector('.scan-label');
    if (active && !label) frame.append(el('span', { class: 'scan-label', text: 'Text wird gelesen …' }));
    if (!active && label) label.remove();
  });
}

function renderOcrStatus() {
  updateScanMarks();
  const chip = $('scan-text-chip');
  chip.hidden = !(pages.length && pages.every((p) => p.ocr.status === 'done') && pages.some((p) => p.ocr.text.replace(/\s/g, '').length > 10));
  const box = $('ocr-status');
  box.className = 'ocr-status';
  if (!ctx.isOcrEnabled() || !pages.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;

  if (ocrError) {
    box.classList.add('is-error');
    box.replaceChildren(
      el('span', { text: 'Texterkennung nicht möglich – beim ersten Mal ist Internet nötig.' }),
      el('button', { type: 'button', class: 'btn-text', text: 'Erneut versuchen', onclick: () => {
        pages.forEach((p) => { if (p.ocr.status === 'error') p.ocr.status = 'pending'; });
        startOcr();
        renderOcrStatus();
      } })
    );
    return;
  }

  const total = pages.length;
  const done = pages.filter((p) => p.ocr.status === 'done').length;
  if (done < total) {
    const current = Math.min(total, done + 1);
    let text = `Text wird erkannt … Seite ${current} von ${total}`;
    if (ocrProgress && ocrProgress.phase === 'loading') text = 'Texterkennung wird geladen (beim ersten Mal ca. 5 MB) …';
    else if (ocrProgress) text += ` (${Math.round(ocrProgress.progress * 100)} %)`;
    box.replaceChildren(el('span', { class: 'spinner', 'aria-hidden': 'true' }), el('span', { text }));
    return;
  }

  box.classList.add('is-done');
  const hasText = pages.some((p) => p.ocr.text.replace(/\s/g, '').length > 10);
  box.replaceChildren(el('span', {
    text: !hasText
      ? 'Kein Text erkannt. Bitte Angaben selbst eintragen.'
      : suggestion ? '✓ Text erkannt – Vorschläge sind markiert. Bitte kurz prüfen.' : '✓ Text erkannt.'
  }));
}

function mark(name) { $(FIELDS[name]).closest('label').classList.add('suggested'); if (name === 'title') renderSummary(); }
function unmark(name) { $(FIELDS[name]).closest('label').classList.remove('suggested'); }

function applySuggestion() {
  const text = pages.filter((p) => p.ocr.status === 'done').map((p) => p.ocr.text).join('\n\n');
  suggestion = suggestFromText(text, ctx.getDocs());
  if (!suggestion) return;

  if (suggestion.folderId && !dirty.category) {
    $('doc-category').value = suggestion.folderId;
    mark('category');
  }
  if (suggestion.date && !dirty.date) {
    $('doc-date').value = suggestion.date;
    mark('date');
  }
  if (suggestion.title && !dirty.title) {
    $('doc-title').value = suggestion.title;
    mark('title');
  }
  if (suggestion.note && !dirty.note) {
    $('doc-note').value = suggestion.note;
    mark('note');
  }
  if (suggestion.amount && !dirty.amount) {
    $('doc-amount').value = suggestion.amount;
    mark('amount');
  }
  // Erinnerung nur vorschlagen – gesetzt wird sie erst nach „Übernehmen“
  renderReminderSuggestion();
}

function dueText(kind, iso) {
  const date = formatDate(iso);
  const words = { Zahlung: 'zahlbar bis', 'Kündigung': 'kündbar bis', Widerspruch: 'Widerspruch bis', Ablauf: 'läuft ab am' };
  return `${words[kind] || 'Frist bis'} ${date}`;
}

// „Frist erkannt“ + Schalter „Erinnerung 7 Tage vorher“ (aus, bis du ihn einschaltest)
function renderReminderSuggestion() {
  const slot = $('reminder-suggestion-slot');
  const s = suggestion;
  const row = $('scan-due-row');
  if (!s || !s.dueDate) { row.hidden = true; slot.replaceChildren(); return; }
  const kind = s.dueKind || 'Zahlung';
  row.hidden = false;
  $('scan-due-text').textContent = dueText(kind, s.dueDate);
  if (reminderDismissed) { slot.replaceChildren(); return; }
  const proposal = { date: s.dueDate, kind, amount: s.amount || null, lead: [7, 1, 0] };
  const current = reminder.read();
  const toggle = el('input', { type: 'checkbox', class: 'f-switch', 'aria-label': 'Erinnerung 7 Tage vorher' });
  toggle.checked = Boolean(current && current.date === proposal.date);
  toggle.addEventListener('change', () => reminder.set(toggle.checked ? proposal : null));
  slot.replaceChildren(el('label', { class: 'f-card erk-switch' },
    el('span', { class: 'f-grow' },
      el('span', { class: 'f-row-title', text: 'Erinnerung 7 Tage vorher' }),
      el('span', { class: 'f-row-sub', text: 'Unter „Heute“ · Kalender-Datei mit neutralem Titel' })
    ),
    toggle
  ));
}

// ---------------------------------------------------------------------
// Speichern
// ---------------------------------------------------------------------
async function onSave(event) {
  event.preventDefault();
  const key = ctx.getKey();
  if (!key || busy || !pages.length) return;

  const error = $('scan-error');
  error.textContent = '';
  const category = existingFolderId($('doc-category').value);
  const button = $('scan-save');
  busy = true;
  button.disabled = true;

  try {
    const date = $('doc-date').value || todayISO();
    const title = $('doc-title').value.trim() || `${folderSingular(category)} ${formatDate(date)}`;
    const note = $('doc-note').value.trim();
    const amount = $('doc-amount').value.trim() || null;
    const tagList = tags.read();
    const warrantyUntil = $('doc-warranty').value || null;
    // Fertig erkannte Seiten gleich mitspeichern, die übrigen erledigt die Warteschlange
    const texts = pages.map((p) => (p.ocr.status === 'done' ? { text: p.ocr.text, words: p.ocr.words, w: p.ocr.w, h: p.ocr.h } : null));
    const sender = suggestion && suggestion.sender ? suggestion.sender : null;
    const filter = $('scan-filter').checked;
    const confirmedReminder = reminder.read();

    button.textContent = 'Wird verschlüsselt …';
    const finished = [];
    for (const page of pages) finished.push(await renderPage(page.blob, page.rotation, filter));
    const thumb = await makeThumb(finished[0]);
    const meta = { title, category, date, note, sender, ...(amount ? { amount } : {}), ...(tagList.length ? { tags: tagList } : {}), ...(warrantyUntil ? { warrantyUntil } : {}), ...reminderChanges(confirmedReminder) };
    const missing = texts.map((t, i) => (t ? null : i)).filter((i) => i !== null);
    const doSave = async (extraMeta = {}) => {
      const id = await saveDocument(key, { ...meta, ...extraMeta }, finished, thumb, { texts });
      await ctx.onSaved(id, texts);
      if (missing.length && ctx.isOcrEnabled()) ctx.enqueueOcr(id, missing);
      return id;
    };

    // Duplikatprüfung vor dem Speichern
    let check = { decision: 'save', extraMeta: {}, afterSave: () => {} };
    if (ctx.checkDuplicate) {
      button.textContent = 'Wird geprüft …';
      const dims = await loadImage(finished[0]);
      check = await ctx.checkDuplicate({
        kind: 'scan',
        pages: finished.map((blob, i) => (i === 0 ? { blob, width: dims.naturalWidth, height: dims.naturalHeight } : { blob })),
        texts,
        meta,
        sizeBytes: finished.reduce((sum, b) => sum + b.size, 0),
        // „Rückgängig“ nach „Duplikat“: doch speichern
        onUndoSkip: async () => { await doSave(check.extraMeta); toast('Doch gespeichert'); }
      });
    }
    if (check.decision === 'later') {
      setStatus('Noch nicht gespeichert – du kannst den Scan weiter bearbeiten.');
      return;
    }
    if (check.decision === 'skip') {
      clearScan();
      setStatus('Nicht gespeichert, weil das Dokument schon vorhanden ist.');
      return;
    }

    button.textContent = 'Wird verschlüsselt …';
    const docId = await doSave(check.extraMeta);
    await check.afterSave(docId);
    lastFolderId = category;
    clearScan();
    setStatus(`„${title}“ liegt jetzt in ${folderLabel(category)}.`);
    if (!document.querySelector('.toast.has-action.is-visible')) toast('Verschlüsselt gespeichert');
  } catch (err) {
    console.error(err);
    error.textContent = 'Speichern fehlgeschlagen. Ist der Speicher voll?';
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Ablegen';
  }
}

// „Später sortieren“: Seiten unsortiert in den Eingang legen (verschlüsselt).
// Eine Seite als Bild, mehrere Seiten als ein PDF. Einsortieren später unter „Heute“.
async function onLater() {
  if (busy || !pages.length || !ctx.sendToInbox) return;
  const button = $('scan-later');
  busy = true;
  button.disabled = true;
  button.textContent = 'Wird in den Eingang gelegt …';
  try {
    const filter = $('scan-filter').checked;
    const finished = [];
    for (const page of pages) finished.push(await renderPage(page.blob, page.rotation, filter));
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const name = `Scan ${stamp}`;
    const file = finished.length === 1
      ? new File([finished[0]], `${name}.jpg`, { type: 'image/jpeg' })
      : new File([await imagesToPdf(finished, name)], `${name}.pdf`, { type: 'application/pdf' });
    busy = false;
    clearScan();
    await ctx.sendToInbox(file);
  } catch (err) {
    console.error(err);
    $('scan-error').textContent = 'Konnte nicht in den Eingang gelegt werden.';
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Später sortieren';
  }
}

/** Gibt es einen Scan, der noch nicht abgelegt ist? */
export const hasDraft = () => pages.length > 0;

/** Entwurf leeren (auch beim Sperren, damit keine Fotos im Speicher bleiben). */
export function clearScan() {
  draftId++;
  ocrRunning = null;
  ocrError = false;
  pages.forEach(releasePage);
  pages = [];
  dirty = {};
  suggestion = null;
  reminderDismissed = false;
  if (reminder) reminder.set(null);
  if (tags) tags.set([]);
  $('reminder-suggestion-slot').replaceChildren();
  $('scan-form').reset();
  Object.keys(FIELDS).forEach(unmark);
  $('doc-date').value = todayISO();
  if (allFolders().length) fillFolderSelect($('doc-category'), existingFolderId(lastFolderId), { allowNew: true });
  $('scan-filter').checked = true;
  $('scan-error').textContent = '';
  $('scan-due-row').hidden = true;
  summaryUrl = null;
  setStatus('');
  render();
}
