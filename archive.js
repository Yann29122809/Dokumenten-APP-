// Bildschirm „Ablage“: Ablageorte und Unterordner, Suche, Dokument ansehen,
// bearbeiten, als PDF teilen oder löschen.

import { el, formatDate } from './dom.js';
import { listDocuments, loadThumb, loadPages, updateMeta, deleteDocument } from './docs.js';
import {
  childFolders, folderById, folderPath, folderLabel, folderColor, descendantIds, existingFolderId,
  createFolder, renameFolder, deleteFolder, fillFolderSelect, askAndCreateFolder, onFoldersChanged
} from './folders.js';
import { imagesToPdf } from './makepdf.js';
import { recognizeText } from './ocr.js';
import { renderPage } from './images.js';
import { suggestFromText } from './suggest.js';

const BACKUP_REMINDER_DAYS = 30;

let ctx = null;
let docs = [];
let view = { name: 'root' };
let query = '';
let objectUrls = [];
let renderId = 0;   // verhindert, dass alte, langsame Ladevorgänge Neues überschreiben
let currentPdf = null;

const root = () => document.getElementById('archive-view');
// Leere Stellen (null) nicht als Text „null“ anzeigen
const show = (...children) => root().replaceChildren(...children.filter((c) => c !== null && c !== undefined && c !== false));

function trackUrl(blob) {
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return url;
}

function releaseUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls = [];
  currentPdf = null;
}

export function initArchive(context) {
  ctx = context;
  onFoldersChanged(() => { if (ctx.getKey() && view.name !== 'detail') render(); });
}

/** Dokumente neu einlesen und aktuelle Ansicht zeichnen. */
export async function refreshArchive() {
  const key = ctx.getKey();
  if (!key) return;
  docs = await listDocuments(key);
  if (view.name === 'detail' && !docs.some((d) => d.id === view.id)) view = { name: 'root' };
  if (view.name === 'folder' && !folderById(view.id)) view = { name: 'root' };
  render();
}

export function showRoot() {
  view = { name: 'root' };
  query = '';
  render();
}

export function clearArchive() {
  releaseUrls();
  docs = [];
  query = '';
  view = { name: 'root' };
  root().replaceChildren();
}

export const documentCount = () => docs.length;
export const getDocs = () => docs;

function go(newView) {
  view = newView;
  render();
  document.querySelector('.app-main').scrollTop = 0;
}

function render() {
  releaseUrls();
  renderId++;
  if (view.name === 'folder') renderFolder(view.id);
  else if (view.name === 'all') renderAll();
  else if (view.name === 'detail') renderDetail(view.id);
  else renderRoot();
}

// ---------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------
const pagesText = (n) => (n === 1 ? '1 Seite' : `${n} Seiten`);
const dot = (folderId) => el('span', { class: 'dot', style: { background: folderColor(folderId) } });

function countIn(folderId) {
  const ids = new Set(descendantIds(folderId));
  return docs.filter((d) => ids.has(d.meta.category)).length;
}

function folderRow(folder) {
  const subCount = childFolders(folder.id).length;
  return el('button', { type: 'button', class: 'list-row', onclick: () => go({ name: 'folder', id: folder.id }) },
    dot(folder.id),
    el('span', { class: 'grow' },
      el('span', { class: 'row-title', text: folder.name }),
      subCount ? el('span', { class: 'row-sub', text: subCount === 1 ? '1 Unterordner' : `${subCount} Unterordner` }) : null
    ),
    el('span', { class: 'count', text: String(countIn(folder.id)) }),
    el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
  );
}

function docRow(doc, showFolder, backView) {
  const myRender = renderId;
  const img = el('img', { class: 'thumb', alt: '' });
  loadThumb(ctx.getKey(), doc).then((blob) => {
    if (myRender === renderId) img.src = trackUrl(blob);
  }).catch(() => {});
  return el('button', { type: 'button', class: 'doc-row', onclick: () => go({ name: 'detail', id: doc.id, back: backView }) },
    el('span', { class: 'thumb-box' }, img),
    el('span', { class: 'doc-text' },
      el('span', { class: 'doc-title', text: doc.meta.title }),
      el('span', { class: 'doc-sub', text: [
        showFolder ? folderLabel(existingFolderId(doc.meta.category)) : null,
        formatDate(doc.meta.date),
        pagesText(doc.meta.pageCount)
      ].filter(Boolean).join(' · ') })
    ),
    el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
  );
}

function backButton(label, target) {
  return el('button', { type: 'button', class: 'back-btn', onclick: () => go(target) }, '‹ ', label);
}

function viewLabel(v) {
  if (!v || v.name === 'root') return 'Ablage';
  if (v.name === 'all') return 'Alle Dokumente';
  if (v.name === 'search') return 'Suche';
  if (v.name === 'folder') return folderById(v.id)?.name || 'Ablage';
  return 'Zurück';
}

// ---------------------------------------------------------------------
// Start: Suche + Ablageorte
// ---------------------------------------------------------------------
function renderRoot() {
  const results = el('div', { id: 'search-results' });
  const folderList = el('div', {});
  const search = el('input', {
    type: 'search', class: 'search-input', placeholder: 'Suchen: Titel, Text, Absender, Datum …',
    'aria-label': 'Dokumente durchsuchen', value: query, autocomplete: 'off', enterkeyhint: 'search'
  });

  const update = () => {
    query = search.value;
    const hits = searchDocs(query);
    folderList.hidden = Boolean(query.trim());
    if (!query.trim()) { results.replaceChildren(); return; }
    renderId++;
    releaseUrls();
    results.replaceChildren(
      el('p', { class: 'hint', text: hits.length === 1 ? '1 Treffer' : `${hits.length} Treffer` }),
      hits.length ? el('div', { class: 'card' }, hits.slice(0, 100).map((d) => docRow(d, true, { name: 'root' }))) : ''
    );
  };
  search.addEventListener('input', update);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') search.blur(); });

  const roots = childFolders(null);
  folderList.append(
    backupReminder() || '',
    el('div', { class: 'card' },
      el('button', { type: 'button', class: 'list-row', onclick: () => go({ name: 'all' }) },
        el('span', { class: 'dot dot-all' }),
        el('span', { class: 'grow', text: 'Alle Dokumente' }),
        el('span', { class: 'count', text: String(docs.length) }),
        el('span', { class: 'chevron', 'aria-hidden': 'true', text: '›' })
      ),
      ...roots.map(folderRow)
    ),
    el('button', { type: 'button', class: 'btn-secondary full', text: '+ Neuer Ablageort', onclick: async () => {
      const name = prompt('Name des neuen Ablageorts (z. B. „Krankenakte“):');
      if (name && name.trim()) await createFolder(ctx.getKey(), name);
    } }),
    docs.length ? '' : el('p', { class: 'hint center', text: 'Noch keine Dokumente abgelegt. Scanne dein erstes Dokument unter „Scannen“.' })
  );

  show(search, results, folderList);
  if (query) update();
}

const fold = (text) => (text || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');

function searchDocs(q) {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return docs.filter((d) => {
    const m = d.meta;
    const hay = fold([m.title, m.note, m.text, m.sender, folderLabel(existingFolderId(m.category)), formatDate(m.date), m.date].join(' \n '));
    return terms.every((t) => hay.includes(t));
  });
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
// Alle Dokumente
// ---------------------------------------------------------------------
function renderAll() {
  show(
    backButton('Ablage', { name: 'root' }),
    el('h2', { class: 'view-title', text: 'Alle Dokumente' }),
    docs.length
      ? el('div', { class: 'card' }, docs.map((d) => docRow(d, true, { name: 'all' })))
      : el('p', { class: 'hint center', text: 'Noch keine Dokumente.' })
  );
}

// ---------------------------------------------------------------------
// Ordner mit Unterordnern und Dokumenten
// ---------------------------------------------------------------------
function renderFolder(id) {
  const folder = folderById(id);
  if (!folder) return renderRoot();
  const path = folderPath(id);
  const parent = folder.parentId ? folderById(folder.parentId) : null;
  const subs = childFolders(id);
  const own = docs.filter((d) => d.meta.category === id);
  const key = ctx.getKey();

  const actions = el('div', { class: 'button-row' },
    el('button', { type: 'button', class: 'btn-secondary', text: '+ Unterordner', onclick: async () => {
      const name = prompt(`Name des Unterordners in „${folder.name}“\n(z. B. „Krankenhausaufenthalt März 2026“):`);
      if (name && name.trim()) await createFolder(key, name, id);
    } }),
    el('button', { type: 'button', class: 'btn-secondary', text: 'Umbenennen', onclick: async () => {
      const name = prompt('Neuer Name:', folder.name);
      if (name && name.trim()) await renameFolder(key, id, name);
    } }),
    el('button', { type: 'button', class: 'btn-secondary danger', text: 'Löschen', onclick: async () => {
      if (subs.length || own.length) {
        alert('Dieser Ordner ist nicht leer. Verschiebe oder lösche zuerst die Dokumente und Unterordner darin.');
        return;
      }
      if (!confirm(`Ordner „${folder.name}“ löschen?`)) return;
      await deleteFolder(key, id);
      go(parent ? { name: 'folder', id: parent.id } : { name: 'root' });
    } })
  );

  show(
    backButton(parent ? parent.name : 'Ablage', parent ? { name: 'folder', id: parent.id } : { name: 'root' }),
    el('h2', { class: 'view-title' }, dot(id), ' ', folder.name),
    path.length > 1 ? el('p', { class: 'doc-info', text: path.map((f) => f.name).join(' › ') }) : null,
    subs.length ? el('h3', { class: 'section-label', text: 'Unterordner' }) : null,
    subs.length ? el('div', { class: 'card' }, subs.map(folderRow)) : null,
    own.length ? el('h3', { class: 'section-label', text: 'Dokumente' }) : null,
    own.length ? el('div', { class: 'card' }, own.map((d) => docRow(d, false, { name: 'folder', id }))) : null,
    !subs.length && !own.length ? el('p', { class: 'hint center', text: 'Dieser Ordner ist noch leer.' }) : null,
    actions
  );
}

// ---------------------------------------------------------------------
// Einzelnes Dokument
// ---------------------------------------------------------------------
function renderDetail(id) {
  const myRender = renderId;
  const key = ctx.getKey();
  const doc = docs.find((d) => d.id === id);
  if (!doc) return renderRoot();
  const folderId = existingFolderId(doc.meta.category);
  const back = view.back || { name: 'folder', id: folderId };

  const pagesBox = el('div', { class: 'pages' }, el('p', { class: 'hint center', text: 'Seiten werden entschlüsselt …' }));
  const shareBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'PDF teilen', disabled: true, onclick: () => share(doc) });
  let pageBlobs = [];

  loadPages(key, doc).then(async (blobs) => {
    if (myRender !== renderId) return;
    pageBlobs = blobs;
    pagesBox.replaceChildren(...blobs.map((blob, i) =>
      el('img', { class: 'page-img', src: trackUrl(blob), alt: `Seite ${i + 1} von ${blobs.length}` })
    ));
    // PDF gleich vorbereiten – das iPhone öffnet „Teilen“ nur direkt nach dem Antippen
    const pdf = await imagesToPdf(blobs, doc.meta.title);
    if (myRender !== renderId) return;
    currentPdf = pdf;
    shareBtn.disabled = false;
  }).catch((err) => {
    console.error(err);
    if (myRender === renderId) pagesBox.replaceChildren(el('p', { class: 'error', text: 'Seiten konnten nicht geladen werden.' }));
  });

  const hasText = Boolean(doc.meta.text && doc.meta.text.trim());
  const ocrBtn = !hasText && ctx.isOcrEnabled()
    ? el('button', { type: 'button', class: 'btn-text', text: 'Text erkennen (für die Suche)', onclick: (e) => recognizeLater(doc, pageBlobs, e.currentTarget) })
    : null;

  show(
    backButton(viewLabel(back), back),
    el('h2', { class: 'view-title', text: doc.meta.title }),
    el('p', { class: 'doc-info' },
      dot(folderId), ` ${folderLabel(folderId)} · ${formatDate(doc.meta.date)} · ${pagesText(doc.meta.pageCount)}`
    ),
    doc.meta.note ? el('p', { class: 'doc-note', text: doc.meta.note }) : null,
    el('div', { class: 'button-row' },
      el('button', { type: 'button', class: 'btn-secondary', text: 'Bearbeiten', onclick: () => renderEdit(doc) }),
      shareBtn,
      el('button', { type: 'button', class: 'btn-secondary danger', text: 'Löschen', onclick: () => remove(doc, back) })
    ),
    el('div', { id: 'edit-slot' }),
    pagesBox,
    hasText
      ? el('details', { class: 'ocr-text' }, el('summary', { text: 'Erkannter Text' }), el('pre', { text: doc.meta.text }))
      : ocrBtn
  );
}

function renderEdit(doc) {
  const slot = document.getElementById('edit-slot');
  if (slot.firstChild) { slot.replaceChildren(); return; }

  const category = el('select', {});
  let selected = existingFolderId(doc.meta.category);
  fillFolderSelect(category, selected, { allowNew: true });
  category.addEventListener('change', async () => {
    if (category.value !== '__new') { selected = category.value; return; }
    const folder = await askAndCreateFolder(ctx.getKey(), selected);
    if (folder) selected = folder.id;
    fillFolderSelect(category, selected, { allowNew: true });
  });

  const title = el('input', { type: 'text', value: doc.meta.title, maxlength: '120' });
  const date = el('input', { type: 'date', value: doc.meta.date });
  const note = el('textarea', { rows: '3', maxlength: '1000' });
  note.value = doc.meta.note || '';
  const error = el('p', { class: 'error', role: 'alert' });

  const form = el('form', { class: 'card form-card', novalidate: true },
    el('label', {}, 'Ablageort', category),
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
        title: title.value.trim(), category: existingFolderId(selected), date: date.value || doc.meta.date, note: note.value.trim()
      });
      render();
    } catch (err) {
      console.error(err);
      error.textContent = 'Speichern fehlgeschlagen.';
    }
  });
  slot.replaceChildren(form);
  title.focus();
}

async function recognizeLater(doc, pageBlobs, button) {
  if (!pageBlobs.length) return;
  button.disabled = true;
  try {
    const texts = [];
    for (const [i, blob] of pageBlobs.entries()) {
      button.textContent = `Text wird erkannt … Seite ${i + 1} von ${pageBlobs.length}`;
      texts.push(await recognizeText(await renderPage(blob, 0, true)));
    }
    const text = texts.join('\n\n').trim();
    if (text.replace(/\s/g, '').length < 5) {
      button.textContent = 'Kein Text gefunden';
      return;
    }
    const s = suggestFromText(text, docs);
    doc.meta = await updateMeta(ctx.getKey(), doc, { text, sender: doc.meta.sender || (s && s.sender) || null });
    render();
  } catch (err) {
    console.error(err);
    button.textContent = 'Texterkennung nicht möglich – Internet beim ersten Mal nötig';
    button.disabled = false;
  }
}

async function share(doc) {
  if (!currentPdf) return;
  const safeTitle = doc.meta.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'Dokument';
  const file = new File([currentPdf], `${safeTitle}.pdf`, { type: 'application/pdf' });
  if (!navigator.canShare || !navigator.canShare({ files: [file] })) {
    // Ohne Teilen-Funktion (z. B. am Computer): herunterladen
    const url = trackUrl(currentPdf);
    const link = el('a', { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    return;
  }
  ctx.suspendAutoLock();
  try {
    await navigator.share({ files: [file], title: doc.meta.title });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      alert('Teilen hat nicht funktioniert.');
    }
  } finally {
    ctx.resumeAutoLock();
  }
}

async function remove(doc, back) {
  if (!confirm(`„${doc.meta.title}“ wirklich löschen?\n\nDas kann nicht rückgängig gemacht werden (außer über ein Backup).`)) return;
  try {
    await deleteDocument(doc);
    view = back;
    await refreshArchive();
  } catch (err) {
    console.error(err);
    alert('Löschen fehlgeschlagen.');
  }
}
