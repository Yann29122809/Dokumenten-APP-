// Bildschirm „Scannen“: Fotos aufnehmen, Seiten sortieren/drehen,
// Angaben eintragen und verschlüsselt speichern.

import { el, todayISO, formatDate } from './dom.js';
import { prepareImage, renderPage, makeThumb } from './images.js';
import { CATEGORIES, categoryById, saveDocument } from './docs.js';

const $ = (id) => document.getElementById(id);

let ctx = null;
let pages = []; // { blob, url, rotation }
let busy = false;

export function initScan(context) {
  ctx = context;

  const select = $('doc-category');
  CATEGORIES.forEach((c) => select.append(el('option', { value: c.id, text: c.singular })));
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
      pages.push({ blob, url: URL.createObjectURL(blob), rotation: 0, ratio: height / width });
    } catch (err) {
      console.error(err);
      failed++;
    }
  }
  busy = false;
  setStatus(failed ? `${failed} Bild(er) konnten nicht gelesen werden.` : '');
  render();
}

function render() {
  const hasPages = pages.length > 0;
  $('scan-empty').hidden = hasPages;
  $('scan-draft').hidden = !hasPages;

  const filter = $('scan-filter').checked;
  const grid = $('scan-pages');
  grid.replaceChildren(...pages.map((page, i) => el('figure', { class: 'page-tile' },
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
  render();
}

function move(i, delta) {
  const j = i + delta;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  render();
}

function removePage(i) {
  URL.revokeObjectURL(pages[i].url);
  pages.splice(i, 1);
  render();
}

async function onSave(event) {
  event.preventDefault();
  const key = ctx.getKey();
  if (!key || busy || !pages.length) return;

  const error = $('scan-error');
  error.textContent = '';
  const category = $('doc-category').value;
  const date = $('doc-date').value || todayISO();
  const title = $('doc-title').value.trim() || `${categoryById(category).singular} ${formatDate(date)}`;
  const note = $('doc-note').value.trim();
  const filter = $('scan-filter').checked;

  const button = $('scan-save');
  busy = true;
  button.disabled = true;
  button.textContent = 'Wird verschlüsselt …';
  try {
    const finished = [];
    for (const page of pages) finished.push(await renderPage(page.blob, page.rotation, filter));
    const thumb = await makeThumb(finished[0]);
    await saveDocument(key, { title, category, date, note }, finished, thumb);
    clearScan();
    setStatus(`✓ „${title}“ wurde in ${categoryById(category).label} gespeichert.`);
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
  pages.forEach((page) => URL.revokeObjectURL(page.url));
  pages = [];
  $('scan-form').reset();
  $('doc-date').value = todayISO();
  $('scan-filter').checked = true;
  $('scan-error').textContent = '';
  setStatus('');
  render();
}
