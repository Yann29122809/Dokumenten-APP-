// Bildschirm „Ablage“: Ablageorte und Unterordner, Suche, Dokument ansehen,
// bearbeiten, als PDF teilen oder löschen.

import { el, formatDate, toast } from './dom.js';
import { icon } from './icons.js';
import { listDocuments, loadThumb, loadPages, updateMeta, deleteDocument, loadPageWords, loadOriginal, moveToTrash, restoreFromTrash, purgeTrash, TRASH_DAYS } from './docs.js';
import { search as runSearch, setDocs as setSearchDocs, getPageTextsFor, hasText, fold, recentSearches, rememberSearch } from './search.js';
import { onQueueChange, queueState, cancelAll as cancelOcr, retryAll as retryOcr } from './ocrqueue.js';
import {
  childFolders, folderById, folderPath, folderLabel, folderColor, descendantIds, existingFolderId,
  createFolder, renameFolder, deleteFolder, fillFolderSelect, askAndCreateFolder, onFoldersChanged
} from './folders.js';
import { imagesToPdf } from './makepdf.js';
import { openDeadlines, dueLabel, dueClass, openInCalendar, shareCalendarFile, reminderOf, reminderChanges, reminderFields, suggestionCard, LEADS } from './deadlines.js';

const BACKUP_REMINDER_DAYS = 30;

let ctx = null;
let docs = [];        // ohne Papierkorb
let trashed = [];     // im Papierkorb
let view = { name: 'root' };
let query = '';
let searchFilter = { folder: '', period: '' };
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
  onQueueChange(() => updateQueueChip());
}

/** Dokumente neu einlesen und aktuelle Ansicht zeichnen. */
export async function refreshArchive() {
  const key = ctx.getKey();
  if (!key) return;
  const all = await listDocuments(key);
  // Älter als 30 Tage im Papierkorb → endgültig löschen
  if (await purgeTrash(all)) return refreshArchive();
  docs = all.filter((d) => !d.meta.trashedAt);
  trashed = all.filter((d) => d.meta.trashedAt).sort((a, b) => b.meta.trashedAt - a.meta.trashedAt);
  setSearchDocs(docs);
  if (view.name === 'detail' && !docs.some((d) => d.id === view.id)) view = { name: 'root' };
  if (view.name === 'folder' && !folderById(view.id)) view = { name: 'root' };
  render();
}

export function showRoot() {
  view = { name: 'root' };
  query = '';
  render();
}

/** Text einer Seite wurde im Hintergrund erkannt. */
export function pageTextReady(docId) {
  if (view.name === 'detail' && view.id === docId) render();
}

export function clearArchive() {
  releaseUrls();
  docs = [];
  trashed = [];
  query = '';
  view = { name: 'root' };
  root().replaceChildren();
}

export const documentCount = () => docs.length;
export const getDocs = () => docs;
export const getTrashed = () => trashed;

/** Dokument direkt öffnen (z. B. aus „Bald fällig“ auf der Startseite). */
export function openDoc(id) {
  go({ name: 'detail', id, back: { name: 'root' } });
}

/** Liste „Bald fällig“ (offene Erinnerungen, überfällige zuerst und rot). */
export function renderSoon(container, onOpen) {
  const open = openDeadlines(docs);
  container.hidden = !open.length;
  if (!open.length) { container.replaceChildren(); return; }
  container.replaceChildren(
    el('h3', { class: 'section-label', text: 'Bald fällig' }),
    el('div', { class: 'card' }, open.slice(0, 5).map((doc) => {
      const r = reminderOf(doc.meta);
      return el('button', { type: 'button', class: 'list-row', onclick: () => onOpen(doc.id) },
        el('span', { class: `due-icon ${dueClass(r.date)}` }, icon('clock')),
        el('span', { class: 'grow' },
          el('span', { class: 'row-title', text: doc.meta.title }),
          el('span', { class: `row-sub due ${dueClass(r.date)}`, text: [r.kind, dueLabel(r.date), r.amount].filter(Boolean).join(' · ') })
        ),
        icon('right', 'icon chevron-icon'));
    })),
    open.length > 5 ? el('p', { class: 'hint', text: `… und ${open.length - 5} weitere in der Ablage` }) : ''
  );
}

/** Papierkorb-Liste (in den Einstellungen). */
export function renderTrash(container, onChange) {
  if (!trashed.length) {
    container.replaceChildren(el('p', { class: 'hint inline-form', text: 'Der Papierkorb ist leer.' }));
    return;
  }
  const days = (d) => Math.max(0, TRASH_DAYS - Math.floor((Date.now() - d.meta.trashedAt) / 86400000));
  container.replaceChildren(
    ...trashed.map((doc) => el('div', { class: 'trash-row' },
      el('span', { class: 'doc-text' },
        el('span', { class: 'doc-title', text: doc.meta.title }),
        el('span', { class: 'doc-sub', text: `${folderLabel(existingFolderId(doc.meta.category))} · wird in ${days(doc)} Tagen gelöscht` })
      ),
      el('button', { type: 'button', class: 'btn-text', text: 'Zurückholen', onclick: async () => {
        await restoreFromTrash(ctx.getKey(), doc);
        await refreshArchive();
        toast('Wiederhergestellt');
        onChange();
      } }),
      el('button', { type: 'button', class: 'btn-text danger', text: 'Löschen', onclick: async () => {
        if (!confirm(`„${doc.meta.title}“ endgültig löschen? Das kann nicht rückgängig gemacht werden.`)) return;
        await deleteDocument(doc);
        await refreshArchive();
        toast('Endgültig gelöscht');
        onChange();
      } })
    )),
    el('button', { type: 'button', class: 'btn-text danger inline-form', text: 'Papierkorb leeren', onclick: async () => {
      if (!confirm(`${trashed.length} Dokument(e) endgültig löschen? Das kann nicht rückgängig gemacht werden.`)) return;
      for (const doc of [...trashed]) await deleteDocument(doc);
      await refreshArchive();
      toast('Papierkorb geleert');
      onChange();
    } })
  );
}

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
  // Startseite („Bald fällig“) aktualisieren
  document.dispatchEvent(new Event('dokumente:changed'));
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

/** Ordner als farbige Kachel */
function folderTile(folder) {
  const subCount = childFolders(folder.id).length;
  const count = countIn(folder.id);
  return el('button', {
    type: 'button', class: 'tile', style: { '--tile': folderColor(folder.id) },
    onclick: () => go({ name: 'folder', id: folder.id })
  },
    el('span', { class: 'tile-icon' }, icon('folder')),
    el('span', { class: 'tile-name', text: folder.name }),
    el('span', { class: 'tile-meta', text: [
      count === 1 ? '1 Dokument' : `${count} Dokumente`,
      subCount ? (subCount === 1 ? '1 Ordner' : `${subCount} Ordner`) : null
    ].filter(Boolean).join(' · ') })
  );
}

function newTile(label, onclick) {
  return el('button', { type: 'button', class: 'tile tile-new', onclick },
    el('span', { class: 'tile-icon' }, icon('folderPlus')),
    el('span', { class: 'tile-name', text: label })
  );
}

/** Vorschaubild laden (entschlüsselt) */
function thumbImg(doc) {
  const myRender = renderId;
  const img = el('img', { class: 'thumb', alt: '' });
  loadThumb(ctx.getKey(), doc).then((blob) => {
    if (myRender === renderId) img.src = trackUrl(blob);
  }).catch(() => {});
  return img;
}

/** Dokument als Karte mit großem Vorschaubild */
function docCard(doc, showFolder, backView) {
  const rem = reminderOf(doc.meta);
  const due = rem && !rem.done;
  return el('button', { type: 'button', class: 'doc-card', onclick: () => go({ name: 'detail', id: doc.id, back: backView }) },
    el('span', { class: 'doc-card-thumb' },
      thumbImg(doc),
      due ? el('span', { class: `due-badge ${dueClass(rem.date)}` }, icon('clock'), dueLabel(rem.date)) : null,
      doc.meta.pageCount > 1 ? el('span', { class: 'pages-badge', text: String(doc.meta.pageCount) }) : null
    ),
    el('span', { class: 'doc-card-title', text: doc.meta.title }),
    el('span', { class: 'doc-card-sub' },
      showFolder ? dot(existingFolderId(doc.meta.category)) : null,
      [showFolder ? folderById(existingFolderId(doc.meta.category))?.name : null, formatDate(doc.meta.date)].filter(Boolean).join(' · ')
    )
  );
}

/** Dokument als Zeile (für Suchtreffer) */
function docRow(doc, showFolder, backView) {
  return el('button', { type: 'button', class: 'doc-row', onclick: () => go({ name: 'detail', id: doc.id, back: backView }) },
    el('span', { class: 'thumb-box' }, thumbImg(doc)),
    el('span', { class: 'doc-text' },
      el('span', { class: 'doc-title', text: doc.meta.title }),
      el('span', { class: 'doc-sub', text: [
        showFolder ? folderLabel(existingFolderId(doc.meta.category)) : null,
        formatDate(doc.meta.date),
        pagesText(doc.meta.pageCount)
      ].filter(Boolean).join(' · ') })
    ),
    icon('right', 'icon chevron-icon')
  );
}

function backButton(label, target) {
  return el('button', { type: 'button', class: 'back-btn', onclick: () => go(target) }, icon('back'), label);
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
    type: 'search', class: 'search-input', placeholder: 'Titel, Text, Absender, Betrag, Datum …',
    'aria-label': 'Dokumente durchsuchen', value: query, autocomplete: 'off', enterkeyhint: 'search'
  });
  const searchBox = el('label', { class: 'search-box' }, icon('search'), search);

  // Filter: Ordner (inkl. Unterordner) und Zeitraum
  const folderSelect = el('select', { class: 'filter-select', 'aria-label': 'Ordner' },
    el('option', { value: '', text: 'Alle Ordner' }),
    ...flatFolders().map((f) => el('option', { value: f.id, text: f.label, selected: f.id === searchFilter.folder }))
  );
  const year = new Date().getFullYear();
  const periodSelect = el('select', { class: 'filter-select', 'aria-label': 'Zeitraum' },
    ...[['', 'Jeder Zeitraum'], ['30', 'Letzte 30 Tage'], ['365', 'Letzte 12 Monate'], [`y${year}`, String(year)], [`y${year - 1}`, String(year - 1)], ['older', `Vor ${year - 1}`]]
      .map(([v, t]) => el('option', { value: v, text: t, selected: v === searchFilter.period }))
  );
  const filters = el('div', { class: 'search-filters' }, folderSelect, periodSelect);
  const recent = el('div', { class: 'recent-searches' });

  const showRecent = () => {
    const items = recentSearches();
    recent.hidden = Boolean(search.value.trim()) || !items.length;
    recent.replaceChildren(
      el('span', { class: 'hint', text: 'Zuletzt gesucht' }),
      ...items.map((q) => el('button', { type: 'button', class: 'chip', text: q, onclick: () => { search.value = q; update(); } }))
    );
  };

  const update = () => {
    query = search.value;
    searchFilter = { folder: folderSelect.value, period: periodSelect.value };
    const active = Boolean(query.trim());
    folderList.hidden = active;
    filters.hidden = !active;
    showRecent();
    if (!active) { results.replaceChildren(); return; }
    renderId++;
    releaseUrls();
    const hits = runSearch(query, buildFilter());
    results.replaceChildren(
      el('p', { class: 'hint', text: hits.length === 1 ? '1 Treffer' : `${hits.length} Treffer` }),
      hits.length ? el('div', { class: 'card' }, hits.slice(0, 60).map((h) => searchRow(h))) : el('p', { class: 'hint center', text: 'Nichts gefunden. Tipp: weniger oder kürzere Wörter versuchen.' })
    );
  };
  search.addEventListener('input', update);
  search.addEventListener('focus', showRecent);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { search.blur(); rememberSearch(ctx.getKey(), search.value); } });
  search.addEventListener('change', () => rememberSearch(ctx.getKey(), search.value));
  folderSelect.addEventListener('change', update);
  periodSelect.addEventListener('change', update);

  const roots = childFolders(null);
  folderList.append(
    backupReminder() || '',
    deadlinesCard() || '',
    el('h3', { class: 'section-label', text: 'Ablageorte' }),
    el('div', { class: 'tile-grid' },
      el('button', { type: 'button', class: 'tile tile-all', onclick: () => go({ name: 'all' }) },
        el('span', { class: 'tile-icon' }, icon('stack')),
        el('span', { class: 'tile-name', text: 'Alle Dokumente' }),
        el('span', { class: 'tile-meta', text: docs.length === 1 ? '1 Dokument' : `${docs.length} Dokumente` })
      ),
      ...roots.map(folderTile),
      newTile('Neuer Ablageort', async () => {
        const name = prompt('Name des neuen Ablageorts (z. B. „Krankenakte“):');
        if (name && name.trim()) {
          await createFolder(ctx.getKey(), name);
          toast(`Ablageort „${name.trim()}“ angelegt`);
        }
      })
    ),
    docs.length ? '' : el('p', { class: 'hint center', text: 'Noch keine Dokumente abgelegt. Scanne dein erstes Dokument unter „Scannen“.' })
  );

  show(queueChip(), searchBox, recent, filters, results, folderList);
  filters.hidden = !query.trim();
  showRecent();
  if (query) update();
}

function flatFolders() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const f of childFolders(parentId)) {
      out.push({ id: f.id, label: `${'  '.repeat(depth)}${f.name}` });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function buildFilter() {
  const f = {};
  if (searchFilter.folder) f.folderIds = new Set(descendantIds(searchFilter.folder));
  const p = searchFilter.period;
  const iso = (d) => d.toISOString().slice(0, 10);
  if (p === '30' || p === '365') f.from = iso(new Date(Date.now() - Number(p) * 86400000));
  else if (p && p.startsWith('y')) { f.from = `${p.slice(1)}-01-01`; f.to = `${p.slice(1)}-12-31`; }
  else if (p === 'older') f.to = `${new Date().getFullYear() - 2}-12-31`;
  return f;
}

/** Ein Suchtreffer mit Vorschaubild, Ordner und Textausschnitt. */
function searchRow(hit) {
  const { doc, snippet } = hit;
  return el('button', { type: 'button', class: 'doc-row search-hit', onclick: () => {
    rememberSearch(ctx.getKey(), query);
    go({ name: 'detail', id: doc.id, back: { name: 'root' }, page: hit.page, terms: hit.terms });
  } },
    el('span', { class: 'thumb-box' }, thumbImg(doc)),
    el('span', { class: 'doc-text' },
      el('span', { class: 'doc-title', text: doc.meta.title }),
      el('span', { class: 'doc-sub', text: [folderLabel(existingFolderId(doc.meta.category)), formatDate(doc.meta.date)].join(' · ') }),
      snippet ? el('span', { class: 'snippet' }, snippet.before, el('mark', { text: snippet.hit }), snippet.after,
        doc.meta.pageCount > 1 ? el('span', { class: 'snippet-page', text: ` · Seite ${hit.page + 1}` }) : null) : null
    ),
    icon('right', 'icon chevron-icon')
  );
}

/** Kleiner Hinweis, solange die Texterkennung im Hintergrund arbeitet. */
function queueChip() {
  const chip = el('div', { id: 'queue-chip', class: 'queue-chip', role: 'status' });
  fillQueueChip(chip);
  return chip;
}

function updateQueueChip() {
  const chip = document.getElementById('queue-chip');
  if (chip) fillQueueChip(chip);
}

function fillQueueChip(chip) {
  const q = queueState();
  if (q.pending > 0 || q.running) {
    const total = Math.max(q.total, q.pending + q.done);
    const nr = Math.min(total, q.done + 1);
    chip.hidden = false;
    chip.className = 'queue-chip';
    chip.replaceChildren(
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('span', { class: 'grow', text: q.loading ? 'Texterkennung wird geladen …' : `Text wird erkannt: Seite ${nr} von ${total}${q.progress ? ` (${Math.round(q.progress * 100)} %)` : ''}` }),
      el('button', { type: 'button', class: 'btn-text', text: 'Abbrechen', onclick: () => cancelOcr() })
    );
  } else if (q.errors > 0 || q.cancelled > 0) {
    const n = q.errors + q.cancelled;
    chip.hidden = false;
    chip.className = 'queue-chip is-error';
    chip.replaceChildren(
      el('span', { class: 'grow', text: `${n === 1 ? '1 Seite' : `${n} Seiten`} ohne Text${q.errors ? ' (Fehler)' : ' (abgebrochen)'}` }),
      el('button', { type: 'button', class: 'btn-text', text: 'Wiederholen', onclick: () => retryOcr() })
    );
  } else {
    chip.hidden = true;
    chip.replaceChildren();
  }
}

function deadlinesCard() {
  const open = openDeadlines(docs);
  if (!open.length) return null;
  return el('div', {},
    el('h3', { class: 'section-label', text: 'Bald fällig' }),
    el('div', { class: 'card' }, open.slice(0, 8).map((doc) =>
      el('button', { type: 'button', class: 'list-row', onclick: () => go({ name: 'detail', id: doc.id, back: { name: 'root' } }) },
        el('span', { class: `due-icon ${dueClass(reminderOf(doc.meta).date)}` }, icon('clock')),
        el('span', { class: 'grow' },
          el('span', { class: 'row-title', text: doc.meta.title }),
          el('span', { class: `row-sub due ${dueClass(reminderOf(doc.meta).date)}`, text: `${reminderOf(doc.meta).kind} · ${dueLabel(reminderOf(doc.meta).date)}` })
        ),
        icon('right', 'icon chevron-icon')
      )
    )),
    open.length > 8 ? el('p', { class: 'hint', text: `… und ${open.length - 8} weitere` }) : ''
  );
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
      ? el('div', { class: 'doc-grid' }, docs.map((d) => docCard(d, true, { name: 'all' })))
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

  const addSub = async () => {
    const name = prompt(`Name des Unterordners in „${folder.name}“\n(z. B. „Krankenhausaufenthalt März 2026“):`);
    if (name && name.trim()) {
      await createFolder(key, name, id);
      toast(`Unterordner „${name.trim()}“ angelegt`);
    }
  };

  const actions = el('div', { class: 'action-bar' },
    subs.length ? null : actionButton('folderPlus', 'Unterordner', addSub),
    actionButton('edit', 'Umbenennen', async () => {
      const name = prompt('Neuer Name:', folder.name);
      if (name && name.trim()) await renameFolder(key, id, name);
    }),
    actionButton('trash', 'Löschen', async () => {
      if (subs.length || own.length) {
        alert('Dieser Ordner ist nicht leer. Verschiebe oder lösche zuerst die Dokumente und Unterordner darin.');
        return;
      }
      if (!confirm(`Ordner „${folder.name}“ löschen?`)) return;
      await deleteFolder(key, id);
      toast('Ordner gelöscht');
      go(parent ? { name: 'folder', id: parent.id } : { name: 'root' });
    }, 'danger')
  );

  show(
    backButton(parent ? parent.name : 'Ablage', parent ? { name: 'folder', id: parent.id } : { name: 'root' }),
    el('div', { class: 'folder-head', style: { '--tile': folderColor(id) } },
      el('span', { class: 'tile-icon' }, icon('folder')),
      el('span', {},
        el('h2', { class: 'view-title', text: folder.name }),
        path.length > 1 ? el('span', { class: 'folder-path', text: path.slice(0, -1).map((f) => f.name).join(' › ') }) : null
      )
    ),
    subs.length ? el('h3', { class: 'section-label', text: 'Unterordner' }) : null,
    subs.length ? el('div', { class: 'tile-grid' }, ...subs.map(folderTile), newTile('Neuer Unterordner', addSub)) : null,
    own.length ? el('h3', { class: 'section-label', text: 'Dokumente' }) : null,
    own.length ? el('div', { class: 'doc-grid' }, own.map((d) => docCard(d, false, { name: 'folder', id }))) : null,
    !own.length ? el('p', { class: 'hint center', text: subs.length ? 'Keine Dokumente direkt in diesem Ordner.' : 'Dieser Ordner ist noch leer.' }) : null,
    actions
  );
}

function actionButton(iconName, label, onclick, extraClass = '') {
  return el('button', { type: 'button', class: `action-btn ${extraClass}`, onclick }, icon(iconName), el('span', { text: label }));
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
  const shareBtn = actionButton('share', 'PDF teilen', () => share(doc));
  shareBtn.disabled = true;
  let pageBlobs = [];

  const target = view.page || 0;
  const terms = view.terms || null;
  loadPages(key, doc).then(async (blobs) => {
    if (myRender !== renderId) return;
    pageBlobs = blobs;
    const wraps = blobs.map((blob, i) =>
      el('div', { class: 'page-wrap', id: `page-${i}` },
        el('img', { class: 'page-img', src: trackUrl(blob), alt: `Seite ${i + 1} von ${blobs.length}` }))
    );
    pagesBox.replaceChildren(...wraps);
    // Von der Suche gekommen: zur richtigen Seite springen und das Wort markieren
    if (terms) {
      highlightWords(doc, target, terms, wraps[target], myRender);
      setTimeout(() => wraps[target] && wraps[target].scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
    }
    // PDF gleich vorbereiten – das iPhone öffnet „Teilen“ nur direkt nach dem Antippen.
    // Importierte PDFs werden unverändert im Original geteilt.
    let pdf = null;
    if (doc.meta.source === 'import') {
      const original = await loadOriginal(key, doc).catch(() => null);
      if (original && original.type === 'application/pdf') pdf = original.blob;
    }
    if (!pdf) pdf = await imagesToPdf(blobs, doc.meta.title);
    if (myRender !== renderId) return;
    currentPdf = pdf;
    shareBtn.disabled = false;
  }).catch((err) => {
    console.error(err);
    if (myRender === renderId) pagesBox.replaceChildren(el('p', { class: 'error', text: 'Seiten konnten nicht geladen werden.' }));
  });

  const pageTextList = getPageTextsFor(doc.id);
  const withText = hasText(doc.id);
  const queued = queueState().pending > 0;
  const ocrBtn = !withText && ctx.isOcrEnabled()
    ? el('button', { type: 'button', class: 'btn-text with-icon', onclick: async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = 'Vorgemerkt – Text wird im Hintergrund erkannt';
      await ctx.enqueueOcr(doc.id, Array.from({ length: doc.meta.pageCount }, (_, i) => i));
    } }, icon('text'), queued ? 'Text erkennen (wird vorgemerkt)' : 'Text erkennen (für die Suche)')
    : null;

  show(
    backButton(viewLabel(back), back),
    el('h2', { class: 'view-title', text: doc.meta.title }),
    el('p', { class: 'doc-info' },
      dot(folderId), ` ${folderLabel(folderId)} · ${formatDate(doc.meta.date)} · ${pagesText(doc.meta.pageCount)}`
    ),
    doc.meta.note ? el('p', { class: 'doc-note', text: doc.meta.note }) : null,
    reminderOf(doc.meta) ? dueBox(doc) : (doc.meta.reminderSuggestion ? reminderSuggestionBox(doc) : null),
    el('div', { class: 'action-bar' },
      actionButton('edit', 'Bearbeiten', () => renderEdit(doc)),
      shareBtn,
      actionButton('trash', 'Löschen', () => remove(doc, back), 'danger')
    ),
    el('div', { id: 'edit-slot' }),
    pagesBox,
    withText
      ? el('details', { class: 'ocr-text' }, el('summary', { text: 'Erkannter Text' }),
        ...pageTextList.map((t, i) => el('div', {},
          pageTextList.length > 1 ? el('h4', { class: 'ocr-page', text: `Seite ${i + 1}` }) : null,
          el('pre', { text: t || '(noch kein Text)' }))))
      : ocrBtn
  );
}

function dueBox(doc) {
  const r = reminderOf(doc.meta);
  const done = Boolean(r.done);
  const withTitle = ctx.calendarWithTitle();
  const leads = (r.lead || []).slice().sort((a, b) => b - a).map((d) => (LEADS.find((l) => l.days === d) || {}).label).filter(Boolean);
  return el('div', { class: `due-box ${done ? 'is-done' : dueClass(r.date)}` },
    el('div', { class: 'due-head' },
      el('strong', {}, icon(done ? 'checkCircle' : 'clock'), done ? `${r.kind}: erledigt` : `${r.kind}: ${formatDate(r.date)}`),
      done ? null : el('span', { text: dueLabel(r.date) })
    ),
    el('p', { class: 'due-details', text: [r.amount ? `Betrag ${r.amount}` : null, leads.length ? `Erinnern: ${leads.join(', ')}` : null].filter(Boolean).join(' · ') }),
    el('div', { class: 'due-actions' },
      done ? null : el('button', { type: 'button', class: 'btn-secondary with-icon', onclick: () => {
        ctx.suspendAutoLock();
        openInCalendar(doc, withTitle);
        setTimeout(ctx.resumeAutoLock, 1500);
      } }, icon('calendar'), 'In Kalender'),
      el('button', { type: 'button', class: 'btn-secondary with-icon', onclick: async () => {
        doc.meta = await updateMeta(ctx.getKey(), doc, reminderChanges({ ...r, done: !done }));
        toast(done ? 'Wieder offen' : 'Erledigt', 'ok', {
          label: 'Rückgängig',
          onClick: async () => { doc.meta = await updateMeta(ctx.getKey(), doc, reminderChanges({ ...r, done })); render(); }
        });
        render();
      } }, icon(done ? 'clock' : 'check'), done ? 'Wieder offen' : 'Erledigt')
    ),
    done ? null : el('button', { type: 'button', class: 'btn-text small', text: 'Klappt der Kalender nicht? Über das Teilen-Menü', onclick: async () => {
      ctx.suspendAutoLock();
      try {
        if (!(await shareCalendarFile(doc, withTitle))) alert('Teilen wird auf diesem Gerät nicht unterstützt.');
      } catch (err) {
        console.error(err);
      } finally {
        ctx.resumeAutoLock();
      }
    } })
  );
}

/** Vorschlag aus dem Import – wird erst nach Bestätigung zur Erinnerung. */
function reminderSuggestionBox(doc) {
  const s = doc.meta.reminderSuggestion;
  const proposal = { date: s.date, kind: s.kind || 'Zahlung', amount: s.amount || null, lead: [1, 0], done: false };
  return suggestionCard(proposal, {
    onAccept: async () => {
      doc.meta = await updateMeta(ctx.getKey(), doc, reminderChanges(proposal));
      toast('Erinnerung gesetzt');
      render();
    },
    onEdit: () => renderEdit(doc, proposal),
    onDismiss: async () => {
      doc.meta = await updateMeta(ctx.getKey(), doc, { reminderSuggestion: null });
      render();
    }
  });
}

function renderEdit(doc, proposal = null) {
  const slot = document.getElementById('edit-slot');
  if (slot.firstChild && !proposal) { slot.replaceChildren(); return; }

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
  const reminder = reminderFields(proposal || reminderOf(doc.meta));
  const error = el('p', { class: 'error', role: 'alert' });

  const form = el('form', { class: 'card form-card', novalidate: true },
    el('label', {}, 'Ablageort', category),
    el('label', {}, 'Titel', title),
    el('label', {}, 'Datum des Dokuments', date),
    el('label', {}, 'Notiz', note),
    el('div', { class: 'edit-reminder' }, el('span', { class: 'lead-title', text: 'Erinnerung' }), reminder.node),
    error,
    el('button', { type: 'submit', class: 'btn-primary', text: 'Änderungen speichern' })
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!title.value.trim()) { error.textContent = 'Bitte gib einen Titel ein.'; return; }
    try {
      doc.meta = await updateMeta(ctx.getKey(), doc, {
        title: title.value.trim(), category: existingFolderId(selected), date: date.value || doc.meta.date, note: note.value.trim(),
        ...reminderChanges(reminder.read())
      });
      toast('Änderungen gespeichert');
      render();
    } catch (err) {
      console.error(err);
      error.textContent = 'Speichern fehlgeschlagen.';
    }
  });
  slot.replaceChildren(form);
  title.focus();
}

/** Gefundene Wörter auf dem Seitenbild markieren. */
async function highlightWords(doc, index, terms, wrap, myRender) {
  if (!wrap) return;
  try {
    const data = await loadPageWords(ctx.getKey(), doc, index);
    if (!data || !data.words || myRender !== renderId) return;
    const wanted = terms.filter((t) => t.length >= 2 && !/^dt\d|^\d+d\d\d$/.test(t));
    const boxes = data.words.filter(([word]) => {
      const w = fold(word).replace(/[^\p{L}\p{N}]/gu, '');
      return w.length >= 2 && wanted.some((t) => w.includes(t) || (t.length >= 5 && t.includes(w) && w.length >= 4));
    });
    for (const [, x0, y0, x1, y1] of boxes.slice(0, 40)) {
      wrap.append(el('span', { class: 'word-mark', style: {
        left: `${(x0 / data.w) * 100}%`, top: `${(y0 / data.h) * 100}%`,
        width: `${((x1 - x0) / data.w) * 100}%`, height: `${((y1 - y0) / data.h) * 100}%`
      } }));
    }
  } catch (err) {
    console.warn('Markierung nicht möglich', err);
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
  try {
    await moveToTrash(ctx.getKey(), doc);
    toast('In den Papierkorb gelegt', 'ok', {
      label: 'Rückgängig',
      onClick: async () => {
        await restoreFromTrash(ctx.getKey(), doc);
        await refreshArchive();
        toast('Wiederhergestellt');
      }
    });
    view = back;
    await refreshArchive();
  } catch (err) {
    console.error(err);
    alert('Löschen fehlgeschlagen.');
  }
}
