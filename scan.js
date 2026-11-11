// Bildschirm „Scannen“: Fotos aufnehmen, Seiten sortieren/drehen,
// Text erkennen, Vorschläge eintragen und verschlüsselt speichern.

import { el, todayISO, formatDate } from './dom.js';
import { prepareImage, renderPage, makeThumb } from './images.js';
import { saveDocument } from './docs.js';
import {
  fillFolderSelect, folderLabel, folderSingular, existingFolderId, askAndCreateFolder, onFoldersChanged, allFolders
} from './folders.js';
import { recognizeText } from './ocr.js';
import { suggestFromText } from './suggest.js';

const $ = (id) => document.getElementById(id);

let ctx = null;
let pages = [];      // { blob, url, rotation, ratio, ocr: { status, text } }
let busy = false;
let draftId = 0;     // wird beim Verwerfen erhöht → laufende Erkennung ignoriert
let ocrRunning = null;
let ocrError = false;
let dirty = {};      // Felder, die du selbst geändert hast, werden nicht überschrieben
let suggestion = null;
let lastFolderId = 'invoice';

const FIELDS = { category: 'doc-category', title: 'doc-title', date: 'doc-date', note: 'doc-note' };

export function initScan(context) {
  ctx = context;
  $('doc-date').value = todayISO();

  const pick = (inputId) => () => {
    if (busy) return;
    ctx.suspendAutoLock();
    $(inputId).click();
  };
  $('scan-camera').addEventListener('click', pick('input-camera'));
  $('scan-library').addEventListener('click', pick('input-library'));
  $('scan-add-camera').addEventListener('click', pick('input-camera'));
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
  $('scan-discard').addEventListener('click', () => {
    if (confirm('Diesen Scan verwerfen? Die Fotos werden gelöscht.')) clearScan();
  });
}

function setStatus(text) {
  $('scan-status').textContent = text;
}

async function addFiles(files) {
  busy = true;
  setStatus(files.length > 1 ? `${files.length} Bilder werden vorbereitet …` : 'Bild wird vorbereitet …');
  let failed = 0;
  for (const file of files) {
    try {
      const { blob, width, height } = await prepareImage(file);
      pages.push({ blob, url: URL.createObjectURL(blob), rotation: 0, ratio: height / width, ocr: { status: 'pending', text: '' } });
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  busy = false;
  setStatus(failed ? `${failed} Bild(er) konnten nicht gelesen werden.` : '');
  render();
  startOcr();
}

// ---------------------------------------------------------------------
// Seiten anzeigen
// ---------------------------------------------------------------------
function render() {
  const hasPages = pages.length > 0;
  $('scan-empty').hidden = hasPages;
  $('scan-draft').hidden = !hasPages;

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
        i > 0 ? el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Seite ${i + 1} nach vorne`, text: '←', onclick: () => move(i, -1) }) : null,
        el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Seite ${i + 1} drehen`, text: '↻', onclick: () => rotate(i) }),
        el('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Seite ${i + 1} löschen`, text: '✕', onclick: () => removePage(i) })
      )
    )
  )));
  $('scan-count').textContent = pages.length === 1 ? '1 Seite' : `${pages.length} Seiten`;
  renderOcrStatus();
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

function removePage(i) {
  URL.revokeObjectURL(pages[i].url);
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
        const text = await recognizeText(image, (p) => { ocrProgress = p; renderOcrStatus(); });
        if (myDraft !== draftId) return;
        if (page.rotation === rotation && pages.includes(page)) page.ocr = { status: 'done', text };
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

function renderOcrStatus() {
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

function mark(name) { $(FIELDS[name]).closest('label').classList.add('suggested'); }
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
    // Läuft die Texterkennung noch? Dann kurz warten, damit die Suche den Text kennt.
    if (ctx.isOcrEnabled() && pages.some((p) => p.ocr.status === 'pending' || p.ocr.status === 'running')) {
      button.textContent = 'Text wird noch erkannt …';
      await (ocrRunning || startOcr());
    }

    const date = $('doc-date').value || todayISO();
    const title = $('doc-title').value.trim() || `${folderSingular(category)} ${formatDate(date)}`;
    const note = $('doc-note').value.trim();
    const text = pages.map((p) => (p.ocr.status === 'done' ? p.ocr.text : '')).join('\n\n').trim();
    const sender = suggestion && suggestion.sender ? suggestion.sender : null;
    const filter = $('scan-filter').checked;

    button.textContent = 'Wird verschlüsselt …';
    const finished = [];
    for (const page of pages) finished.push(await renderPage(page.blob, page.rotation, filter));
    const thumb = await makeThumb(finished[0]);
    await saveDocument(key, { title, category, date, note, text, sender }, finished, thumb);

    lastFolderId = category;
    clearScan();
    setStatus(`✓ „${title}“ wurde in ${folderLabel(category)} gespeichert.`);
    ctx.onSaved();
  } catch (err) {
    console.error(err);
    error.textContent = 'Speichern fehlgeschlagen. Ist der Speicher voll?';
  } finally {
    busy = false;
    button.disabled = false;
    button.textContent = 'Verschlüsselt speichern';
  }
}

/** Entwurf leeren (auch beim Sperren, damit keine Fotos im Speicher bleiben). */
export function clearScan() {
  draftId++;
  ocrRunning = null;
  ocrError = false;
  pages.forEach((page) => URL.revokeObjectURL(page.url));
  pages = [];
  dirty = {};
  suggestion = null;
  $('scan-form').reset();
  Object.keys(FIELDS).forEach(unmark);
  $('doc-date').value = todayISO();
  if (allFolders().length) fillFolderSelect($('doc-category'), existingFolderId(lastFolderId), { allowNew: true });
  $('scan-filter').checked = true;
  $('scan-error').textContent = '';
  setStatus('');
  render();
}
