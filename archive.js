// Bildschirm „Ablage“: Kategorien → Liste → Dokument ansehen,
// bearbeiten, teilen oder löschen.

import { el, formatDate } from './dom.js';
import {
  CATEGORIES, categoryById, listDocuments, loadThumb, loadPages, updateMeta, deleteDocument
} from './docs.js';

const BACKUP_REMINDER_DAYS = 30;

let ctx = null;
let docs = [];
let view = { name: 'categories' };
let objectUrls = [];
let renderId = 0;          // verhindert, dass alte, langsame Ladevorgänge Neues überschreiben
let currentPageBlobs = []; // Seiten des geöffneten Dokuments (für „Teilen“)

const root = () => document.getElementById('archive-view');

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function releaseUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
  currentPageBlobs = [];
}

export function initArchive(context) {
  ctx = context;
}

/** Dokumente neu einlesen und aktuelle Ansicht zeichnen. */
export async function refreshArchive() {
  const key = ctx.getKey();
  if (!key) return;
  docs = await listDocuments(key);
  if (view.name === 'detail' && !docs.some((d) => d.id === view.id)) view = { name: 'categories' };
  render();
}

export function showCategories() {
  view = { name: 'categories' };
  render();
}

export function clearArchive() {
  releaseUrls();
  docs = [];
  view = { name: 'categories' };
  root().replaceChildren();
}

export const documentCount = () => docs.length;

function go(newView) {
  view = newView;
  render();
  document.querySelector('.app-main').scrollTop = 0;
}

function render() {
  releaseUrls();
  renderId++;
  if (view.name === 'list') renderList(view.category);
  else if (view.name === 'detail') renderDetail(view.id);
  else renderCategories();
}

// ---------------------------------------------------------------------
// Kategorien
// ---------------------------------------------------------------------
function renderCategories() {
  const count = (id) => docs.filter((d) => d.meta.category === id).length;
  const children = [];

  const reminder = backupReminder();
  if (reminder) children.push(reminder);

  children.push(el('div', { class: 'card' },
    el('button', { type: 'button', class: 'list-row', onclick: () => go({ name: 'list', category: 'all' }) },
      el('span', { class: 'dot dot-all' }),
      el('span', { class: 'grow', text: 'Alle Dokumente' }),
      el('span', { class: 'count', text: String(docs.length) }),
      el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
    ),
    ...CATEGORIES.map((c) => el('button', { type: 'button', class: 'list-row', onclick: () => go({ name: 'list', category: c.id }) },
      el('span', { class: `dot dot-${c.id}` }),
      el('span', { class: 'grow', text: c.label }),
      el('span', { class: 'count', text: String(count(c.id)) }),
      el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
    ))
  ));

  if (!docs.length) children.push(el('p', { class: 'hint center', text: 'Noch keine Dokumente abgelegt. Scanne dein erstes Dokument unter „Scannen“.' }));
  root().replaceChildren(...children);
}

function backupReminder() {
  if (!docs.length) return null;
  const last = ctx.getLastBackup();
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  if (days !== null && days < BACKUP_REMINDER_DAYS) return null;
  const text = days === null ? 'Du hast noch kein Backup gemacht.' : `Dein letztes Backup ist ${days} Tage alt.`;
  return el('button', { type: 'button', class: 'notice', onclick: ctx.goToBackup },
    el('strong', { text: 'Backup empfohlen' }),
    el('span', { text: `${text} Ohne Backup sind deine Dokumente weg, wenn das iPhone verloren geht. Hier tippen.` })
  );
}

// ---------------------------------------------------------------------
// Liste
// ---------------------------------------------------------------------
function backButton(label, target) {
  return el('button', { type: 'button', class: 'back-btn', onclick: () => go(target) }, '‹ ', label);
}

function renderList(category) {
  const myRender = renderId;
  const key = ctx.getKey();
  const label = category === 'all' ? 'Alle Dokumente' : categoryById(category).label;
  const items = category === 'all' ? docs : docs.filter((d) => d.meta.category === category);

  const rows = items.map((doc) => {
    const img = el('img', { class: 'thumb', alt: '' });
    loadThumb(key, doc).then((blob) => {
      if (myRender === renderId) img.src = trackUrl(blob);
    }).catch(() => {});
    return el('button', { type: 'button', class: 'doc-row', onclick: () => go({ name: 'detail', id: doc.id, from: category }) },
      el('span', { class: 'thumb-box' }, img),
      el('span', { class: 'doc-text' },
        el('span', { class: 'doc-title', text: doc.meta.title }),
        el('span', { class: 'doc-sub', text: [
          category === 'all' ? categoryById(doc.meta.category).singular : null,
          formatDate(doc.meta.date),
          doc.meta.pageCount === 1 ? '1 Seite' : `${doc.meta.pageCount} Seiten`
        ].filter(Boolean).join(' · ') })
      ),
      el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
    );
  });

  root().replaceChildren(
    backButton('Ablage', { name: 'categories' }),
    el('h2', { class: 'view-title', text: label }),
    rows.length ? el('div', { class: 'card' }, rows) : el('p', { class: 'hint center', text: 'Hier liegen noch keine Dokumente.' })
  );
}

// ---------------------------------------------------------------------
// Einzelnes Dokument
// ---------------------------------------------------------------------
function renderDetail(id) {
  const myRender = renderId;
  const key = ctx.getKey();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return renderCategories();
  const from = view.from || doc.meta.category;
  const fromLabel = from === 'all' ? 'Alle Dokumente' : categoryById(from).label;

  const pagesBox = el('div', { class: 'pages' }, el('p', { class: 'hint center', text: 'Seiten werden entschlüsselt …' }));
  const shareBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Teilen', disabled: true, onclick: () => share(doc) });

  loadPages(key, doc).then((blobs) => {
    if (myRender !== renderId) return;
    currentPageBlobs = blobs;
    shareBtn.disabled = false;
    pagesBox.replaceChildren(...blobs.map((blob, i) =>
      el('img', { class: 'page-img', src: trackUrl(blob), alt: `Seite ${i + 1} von ${blobs.length}` })
    ));
  }).catch((err) => {
    console.error(err);
    if (myRender === renderId) pagesBox.replaceChildren(el('p', { class: 'error', text: 'Seiten konnten nicht geladen werden.' }));
  });

  const c = categoryById(doc.meta.category);
  root().replaceChildren(
    backButton(fromLabel, { name: 'list', category: from }),
    el('h2', { class: 'view-title', text: doc.meta.title }),
    el('p', { class: 'doc-info' },
      el('span', { class: `dot dot-${c.id}` }), ` ${c.singular} · ${formatDate(doc.meta.date)} · `,
      doc.meta.pageCount === 1 ? '1 Seite' : `${doc.meta.pageCount} Seiten`
    ),
    doc.meta.note ? el('p', { class: 'doc-note', text: doc.meta.note }) : null,
    el('div', { class: 'button-row' },
      el('button', { type: 'button', class: 'btn-secondary', text: 'Bearbeiten', onclick: () => renderEdit(doc) }),
      shareBtn,
      el('button', { type: 'button', class: 'btn-secondary danger', text: 'Löschen', onclick: () => remove(doc, from) })
    ),
    el('div', { id: 'edit-slot' }),
    pagesBox
  );
}

function renderEdit(doc) {
  const slot = document.getElementById('edit-slot');
  if (slot.firstChild) { slot.replaceChildren(); return; }

  const category = el('select', {}, CATEGORIES.map((c) =>
    el('option', { value: c.id, text: c.singular, selected: c.id === doc.meta.category })
  ));
  const title = el('input', { type: 'text', value: doc.meta.title, maxlength: '120' });
  const date = el('input', { type: 'date', value: doc.meta.date });
  const note = el('textarea', { rows: '3', maxlength: '1000' });
  note.value = doc.meta.note || '';
  const error = el('p', { class: 'error', role: 'alert' });

  const form = el('form', { class: 'card form-card', novalidate: true },
    el('label', {}, 'Kategorie', category),
    el('label', {}, 'Titel', title),
    el('label', {}, 'Datum des Dokuments', date),
    el('label', {}, 'Notiz', note),
    error,
    el('button', { type: 'submit', class: 'btn-primary', text: 'Änderungen speichern' })
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!title.value.trim()) { error.textContent = 'Bitte gib einen Titel ein.'; return; }
    try {
      doc.meta = await updateMeta(ctx.getKey(), doc, {
        title: title.value.trim(), category: category.value, date: date.value || doc.meta.date, note: note.value.trim()
      });
      view = { name: 'detail', id: doc.id, from: view.from === 'all' ? 'all' : doc.meta.category };
      render();
    } catch (err) {
      console.error(err);
      error.textContent = 'Speichern fehlgeschlagen.';
    }
  });
  slot.replaceChildren(form);
  title.focus();
}

async function share(doc) {
  if (!currentPageBlobs.length) return;
  const safeTitle = doc.meta.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'Dokument';
  const files = currentPageBlobs.map((blob, i) => new File(
    [blob], currentPageBlobs.length === 1 ? `${safeTitle}.jpg` : `${safeTitle} - Seite ${i + 1}.jpg`, { type: 'image/jpeg' }
  ));
  if (!navigator.canShare || !navigator.canShare({ files })) {
    alert('Teilen wird auf diesem Gerät nicht unterstützt.');
    return;
  }
  ctx.suspendAutoLock();
  try {
    await navigator.share({ files, title: doc.meta.title });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      alert('Teilen hat nicht funktioniert.');
    }
  } finally {
    ctx.resumeAutoLock();
  }
}

async function remove(doc, from) {
  if (!confirm(`„${doc.meta.title}“ wirklich löschen?\n\nDas kann nicht rückgängig gemacht werden (außer über ein Backup).`)) return;
  try {
    await deleteDocument(doc);
    view = { name: 'list', category: from };
    await refreshArchive();
  } catch (err) {
    console.error(err);
    alert('Löschen fehlgeschlagen.');
  }
}
