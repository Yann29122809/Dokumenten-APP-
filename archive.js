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
  document.body.classList.remove('doc-open');
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
  document.body.classList.toggle('doc-open', view.name === 'detail');
  if (view.name === 'folder') renderFolder(view.id);
  else if (view.name === 'all') renderAll();
  else if (view.name === 'collection') renderCollection(view.id);
  else if (view.name === 'detail') renderDetail(view.id);
  else renderRoot();
  // Startseite („Bald fällig“) aktualisieren
  document.dispatchEvent(new Event('dokumente:changed'));
}

// ---------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------
const pagesText = (n) => (n === 1 ? '1 Seite' : `${n} Seiten`);

// Ordnerfarben (Fläche / Symbol) nach DESIGN.md; weitere aus derselben Reihe
const FOLDER_COLORS = {
  bank: ['#DDF5E7', '#17653A'], invoice: ['#FCEBD9', '#8A4B12'], insurance: ['#DEEBFB', '#1B4E8C'],
  letter: ['#ECE9FE', '#3C3489'], payslip: ['#FFF1D6', '#8A5300']
};
const MORE_COLORS = [['#EFE3F8', '#6A2E94'], ['#FDE4EC', '#9B2C5A'], ['#DFF3F4', '#1C6B70'], ['#EEF2DA', '#4F6416'], ['#FBE7DE', '#8C3A1A']];

export function folderPalette(folderId) {
  const top = folderPath(folderId)[0];
  if (!top) return MORE_COLORS[0];
  if (FOLDER_COLORS[top.id]) return FOLDER_COLORS[top.id];
  if (/kranken|arzt|gesundheit|medizin|klinik/i.test(top.name)) return MORE_COLORS[0];
  let h = 0;
  for (const c of top.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return MORE_COLORS[h % MORE_COLORS.length];
}

const folderChip = (folderId, extra = '') => {
  const [bg, fg] = folderPalette(folderId);
  return el('span', { class: `f-chip ${extra}`, style: { background: bg, color: fg }, text: folderById(folderId)?.name || 'Ablage' });
};
const dot = (folderId) => el('span', { class: 'dot', style: { background: folderColor(folderId) } });

function countIn(folderId) {
  const ids = new Set(descendantIds(folderId));
  return docs.filter((d) => ids.has(d.meta.category)).length;
}

/** Ordner als farbige Kachel */
function folderTile(folder) {
  const subCount = childFolders(folder.id).length;
  const count = countIn(folder.id);
  const [bg, fg] = folderPalette(folder.id);
  return el('button', {
    type: 'button', class: 'tile f-tile',
    onclick: () => go({ name: 'folder', id: folder.id })
  },
    el('span', { class: 'tile-icon', style: { background: bg, color: fg } }, icon('folder')),
    el('span', { class: 'tile-name', text: folder.name }),
    el('span', { class: 'tile-meta', text: [
      count === 1 ? '1 Dokument' : `${count} Dokumente`,
      subCount ? (subCount === 1 ? '1 Ordner' : `${subCount} Ordner`) : null
    ].filter(Boolean).join(' · ') })
  );
}

function newTile(label, onclick) {
  return el('button', { type: 'button', class: 'tile f-tile tile-new', onclick },
    el('span', { class: 'tile-icon' }, icon('plus')),
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
  return el('button', { type: 'button', class: 'back-btn', onclick: () => (target.name === 'search' ? ctx.openSearch() : go(target)) }, icon('back'), label);
}

const COLLECTIONS = {
  soon: { label: 'Bald fällig', icon: 'bell', cls: 'is-warn' },
  year: { label: 'Dieses Jahr', icon: 'calendar2', cls: 'is-primary' },
  contracts: { label: 'Verträge', icon: 'stack', cls: 'is-ok' }
};

/** Automatische Sammlungen – nur aus echten Daten berechnet. */
function collectionDocs(id) {
  const year = String(new Date().getFullYear());
  if (id === 'soon') return openDeadlines(docs);
  if (id === 'year') return docs.filter((d) => (d.meta.date || '').startsWith(year));
  if (id === 'contracts') {
    return docs.filter((d) => {
      const r = reminderOf(d.meta);
      if (r && ['Kündigung', 'Ablauf'].includes(r.kind)) return true;
      const text = `${d.meta.title} ${(getPageTextsFor(d.id) || []).join(' ').slice(0, 3000)}`;
      return /vertrag|police|versicherungsschein|vertragsnummer/i.test(text);
    });
  }
  return [];
}

function viewLabel(v) {
  if (!v || v.name === 'root') return 'Ablage';
  if (v.name === 'collection') return COLLECTIONS[v.id]?.label || 'Ablage';
  if (v.name === 'all') return 'Alle Dokumente';
  if (v.name === 'search') return 'Suche';
  if (v.name === 'folder') return folderById(v.id)?.name || 'Ablage';
  return 'Zurück';
}

// ---------------------------------------------------------------------
// Start: Suche + Ablageorte
// ---------------------------------------------------------------------
function renderRoot() {
  const roots = childFolders(null);
  const addFolder = async () => {
    const name = prompt('Name des neuen Ablageorts (z. B. „Krankenakte“):');
    if (name && name.trim()) {
      await createFolder(ctx.getKey(), name);
      toast(`Ablageort „${name.trim()}“ angelegt`);
    }
  };
  const collections = Object.entries(COLLECTIONS).map(([id, c]) =>
    el('button', { type: 'button', class: `collection ${c.cls}`, onclick: () => go({ name: 'collection', id }) },
      icon(c.icon),
      el('span', {},
        el('span', { class: 'collection-count', text: String(collectionDocs(id).length) }),
        el('span', { class: 'collection-label', text: c.label })
      )
    ));

  show(
    el('div', { class: 'f-head' },
      el('h1', { class: 'f-title f-grow', text: 'Ablage' }),
      el('button', { type: 'button', class: 'f-icon-btn is-primary', 'aria-label': 'Neuer Ablageort', onclick: addFolder }, icon('plus'))
    ),
    el('button', { type: 'button', class: 'search-field', onclick: () => ctx.openSearch() }, icon('search'), 'Titel, Text, Absender, Datum'),
    dupBanner(),
    queueChip(),
    backupReminder(),
    el('div', { class: 'f-block' },
      el('h2', { class: 'f-overline', text: 'Automatische Sammlungen' }),
      el('div', { class: 'collections' }, collections)
    ),
    el('div', { class: 'f-block' },
      el('h2', { class: 'f-overline', text: 'Ablageorte' }),
      el('div', { class: 'tile-grid' },
        el('button', { type: 'button', class: 'tile f-tile', onclick: () => go({ name: 'all' }) },
          el('span', { class: 'tile-icon', style: { background: 'var(--f-primary)', color: '#fff' } }, icon('stack')),
          el('span', { class: 'tile-name', text: 'Alle Dokumente' }),
          el('span', { class: 'tile-meta', text: docs.length === 1 ? '1 Dokument' : `${docs.length} Dokumente` })
        ),
        ...roots.map(folderTile),
        newTile('Neuer Ablageort', addFolder)
      )
    ),
    docs.length ? null : el('p', { class: 'hint center', text: 'Noch keine Dokumente abgelegt. Tippe unten auf den Scan-Knopf.' })
  );
}

function renderCollection(id) {
  const c = COLLECTIONS[id];
  const list = collectionDocs(id);
  const empty = {
    soon: 'Keine offenen Fristen. Erkennt Folio beim Scannen eine Frist, kannst du sie als Erinnerung übernehmen.',
    year: 'Aus diesem Jahr gibt es noch keine Dokumente.',
    contracts: 'Noch keine Verträge erkannt. Dazu zählen Dokumente mit Kündigungs- oder Ablauffrist oder mit „Vertrag“, „Police“ oder „Versicherungsschein“ im Text.'
  }[id];
  show(
    backButton('Ablage', { name: 'root' }),
    el('h2', { class: 'view-title', text: c.label }),
    list.length
      ? el('div', { class: 'doc-grid' }, list.map((d) => docCard(d, true, { name: 'collection', id })))
      : el('p', { class: 'hint center', text: empty })
  );
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

/** Hinweis „Mögliche Duplikate gefunden“ – antippen öffnet die Prüfung. */
function dupBanner() {
  const box = el('div', { id: 'dup-banner' });
  fillDupBanner(box);
  return box;
}

function fillDupBanner(box) {
  const n = ctx.getPendingCount();
  box.hidden = !n;
  if (!n) { box.replaceChildren(); return; }
  box.replaceChildren(el('button', { type: 'button', class: 'dup-banner', onclick: () => ctx.openReview() },
    el('span', { class: 'dup-banner-icon' }, icon('stack'), el('span', { class: 'dup-banner-count', text: String(n) })),
    el('span', { class: 'grow' },
      el('strong', { text: n === 1 ? 'Mögliches Duplikat gefunden' : `${n} mögliche Duplikate gefunden` }),
      el('span', { text: 'Tippen zum Prüfen – nach links wischen: behalten, nach rechts: Duplikat' })
    ),
    icon('right', 'icon chevron-icon')));
}

/** Von außen aufrufen, wenn sich die offenen Prüfungen ändern. */
export function updateDupBanner() {
  const box = document.getElementById('dup-banner');
  if (box) fillDupBanner(box);
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
  const target = view.page || 0;
  const terms = view.terms || null;
  const count = doc.meta.pageCount;

  // ---------- Kopf: Zurück · Titel · Teilen ----------
  const subtitle = el('div', { class: 'doc-head-sub', text: `${folderById(folderId)?.name || ''} · Seite ${target + 1} von ${count}` });
  const shareBtn = el('button', { type: 'button', class: 'f-icon-btn', 'aria-label': 'Als PDF teilen', disabled: true, onclick: () => share(doc) }, icon('share'));
  const head = el('div', { class: 'doc-head' },
    el('button', { type: 'button', class: 'f-icon-btn', 'aria-label': `Zurück zu ${viewLabel(back)}`, onclick: () => (back.name === 'search' ? ctx.openSearch() : go(back)) }, icon('back')),
    el('div', { class: 'doc-head-text' }, el('div', { class: 'doc-head-title', text: doc.meta.title }), subtitle),
    shareBtn
  );

  // ---------- Seiten zum Wischen mit Punkten ----------
  const scroller = el('div', { class: 'doc-pages', 'aria-label': 'Seiten' }, el('p', { class: 'hint center doc-loading', text: 'Seiten werden entschlüsselt …' }));
  const dots = el('div', { class: 'doc-dots', 'aria-hidden': 'true' },
    ...Array.from({ length: count }, (_, i) => el('span', { class: i === target ? 'is-active' : '' })));
  const setPage = (i) => {
    subtitle.textContent = `${folderById(folderId)?.name || ''} · Seite ${i + 1} von ${count}`;
    [...dots.children].forEach((d, k) => d.classList.toggle('is-active', k === i));
  };
  scroller.addEventListener('scroll', () => {
    const i = Math.round(scroller.scrollLeft / Math.max(1, scroller.clientWidth));
    setPage(Math.min(count - 1, Math.max(0, i)));
  }, { passive: true });

  loadPages(key, doc).then(async (blobs) => {
    if (myRender !== renderId) return;
    const wraps = blobs.map((blob, i) =>
      el('div', { class: 'doc-page' },
        el('div', { class: 'page-wrap', id: `page-${i}` },
          el('img', { class: 'page-img', src: trackUrl(blob), alt: `Seite ${i + 1} von ${blobs.length}` })))
    );
    scroller.replaceChildren(...wraps);
    if (terms) {
      const word = terms.find((t) => t.length >= 3 && !/^dt\d|^\d+d\d\d$/.test(t));
      highlightWords(doc, target, terms, wraps[target].firstChild, myRender);
      if (word) wraps[target].append(el('span', { class: 'hit-chip', text: `Treffer: ${word}` }));
    }
    requestAnimationFrame(() => { scroller.scrollLeft = target * scroller.clientWidth; });
    setTimeout(() => { scroller.scrollLeft = target * scroller.clientWidth; }, 60);
    // PDF gleich vorbereiten – das iPhone öffnet „Teilen“ nur direkt nach dem Antippen.
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
    if (myRender === renderId) scroller.replaceChildren(el('p', { class: 'error', text: 'Seiten konnten nicht geladen werden.' }));
  });

  // ---------- Bottom Sheet: Chips, Felder, Aktionen ----------
  const r = reminderOf(doc.meta);
  const chips = el('div', { class: 'sheet-chips' },
    folderChip(folderId),
    r ? el('span', { class: `f-chip ${r.done ? 'is-ok' : (daysUntilSafe(r.date) <= 3 ? 'is-danger' : 'is-warn')}`, text: r.done ? `${r.kind}: erledigt` : `${r.kind} bis ${formatDate(r.date).slice(0, 6)}` }) : null,
    doc.meta.source === 'import' && doc.meta.fileName && /\.pdf$/i.test(doc.meta.fileName) ? el('span', { class: 'f-chip', text: 'Original-PDF' }) : null
  );
  const amount = amountOf(doc);
  const field = (label, value) => el('div', { class: 'sheet-row' }, el('span', { class: 'f-row-label', text: label }), el('span', { class: 'f-row-value', text: value }));
  const fields = el('div', { class: 'sheet-fields' },
    doc.meta.sender ? field('Absender', doc.meta.sender) : null,
    field('Datum', formatDate(doc.meta.date)),
    amount !== null ? field('Betrag', `${amount.toFixed(2).replace('.', ',')} €`) : null,
    field('Seiten', String(count))
  );

  // Verschieben: native Ordnerauswahl über dem Knopf (gewohnte iPhone-Auswahl)
  const moveSelect = el('select', { 'aria-label': 'In anderen Ablageort verschieben' });
  fillFolderSelect(moveSelect, folderId);
  moveSelect.addEventListener('change', async () => {
    const to = moveSelect.value;
    if (to === folderId) return;
    doc.meta = await updateMeta(key, doc, { category: to });
    toast(`Verschoben nach ${folderById(to)?.name || 'Ablage'}`, 'ok', {
      label: 'Rückgängig',
      onClick: async () => { doc.meta = await updateMeta(ctx.getKey(), doc, { category: folderId }); render(); }
    });
    render();
  });

  const reminderBtn = el('button', { type: 'button', class: 'f-btn is-small', onclick: () => {
    if (r) { document.getElementById('due-slot')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    renderEdit(doc, { date: '', kind: 'Zahlung', amount: amount !== null ? `${amount.toFixed(2).replace('.', ',')} €` : null, lead: [1, 0] });
    document.getElementById('edit-slot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } }, icon('calendar2'), 'Erinnerung');

  const pageTextList = getPageTextsFor(doc.id);
  const withText = hasText(doc.id);
  const more = el('div', { class: 'f-card is-list doc-more' },
    el('button', { type: 'button', class: 'f-row', onclick: () => renderEdit(doc) }, el('span', { class: 'f-row-icon' }, icon('edit')), el('span', { class: 'f-grow f-row-title', text: 'Bearbeiten' }), icon('right', 'icon chevron-icon')),
    !withText && ctx.isOcrEnabled() ? el('button', { type: 'button', class: 'f-row', onclick: async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.querySelector('.f-row-title').textContent = 'Vorgemerkt – Text wird im Hintergrund erkannt';
      await ctx.enqueueOcr(doc.id, Array.from({ length: count }, (_, i) => i));
    } }, el('span', { class: 'f-row-icon' }, icon('text')), el('span', { class: 'f-grow f-row-title', text: 'Text erkennen (für die Suche)' })) : null,
    el('button', { type: 'button', class: 'f-row danger-row', onclick: () => remove(doc, back) }, el('span', { class: 'f-row-icon is-danger' }, icon('trash')), el('span', { class: 'f-grow f-row-title', text: 'In den Papierkorb' }))
  );

  const sheet = el('div', { class: 'f-sheet doc-sheet' },
    el('div', { class: 'f-sheet-handle', 'aria-hidden': 'true' }),
    chips,
    fields,
    el('div', { class: 'sheet-actions' },
      reminderBtn,
      el('label', { class: 'f-btn-secondary move-btn' }, icon('folder'), 'Verschieben', moveSelect)
    ),
    el('div', { id: 'due-slot' }, r ? dueBox(doc) : (doc.meta.reminderSuggestion ? reminderSuggestionBox(doc) : null)),
    doc.meta.note ? el('p', { class: 'doc-note', text: doc.meta.note }) : null,
    el('div', { id: 'edit-slot' }),
    more,
    withText
      ? el('details', { class: 'ocr-text' }, el('summary', { text: 'Erkannter Text' }),
        ...pageTextList.map((t, i) => el('div', {},
          pageTextList.length > 1 ? el('h4', { class: 'ocr-page', text: `Seite ${i + 1}` }) : null,
          el('pre', { text: t || '(noch kein Text)' }))))
      : null
  );

  show(el('div', { class: 'doc-view' }, head, scroller, count > 1 ? dots : null, sheet));
}

function daysUntilSafe(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(y, m - 1, d) - today) / 86400000);
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

// =====================================================================
// Bildschirm „Suche“ (05)
// =====================================================================
let searchState = { query: '', folder: '', period: '', amount: '' };
let searchUrls = [];

/** Betrag eines Dokuments (aus Angaben, Erinnerung oder erkanntem Text) */
function amountOf(doc) {
  const raw = doc.meta.amount || (reminderOf(doc.meta) || {}).amount || (doc.meta.fp && doc.meta.fp.keys && doc.meta.fp.keys.amount);
  if (!raw) return null;
  const n = parseFloat(String(raw).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function amountMatches(doc, range) {
  if (!range) return true;
  const a = amountOf(doc);
  if (a === null) return false;
  if (range === 'lt50') return a < 50;
  if (range === '50to100') return a >= 50 && a <= 100;
  if (range === 'gt100') return a > 100;
  return true;
}

function searchFilter() {
  const f = {};
  if (searchState.folder) f.folderIds = new Set(descendantIds(searchState.folder));
  const p = searchState.period;
  const iso = (d) => d.toISOString().slice(0, 10);
  if (p === '30' || p === '365') f.from = iso(new Date(Date.now() - Number(p) * 86400000));
  else if (p && p.startsWith('y')) { f.from = `${p.slice(1)}-01-01`; f.to = `${p.slice(1)}-12-31`; }
  else if (p === 'month') { const d = new Date(); f.from = iso(new Date(d.getFullYear(), d.getMonth(), 1)); f.to = iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
  return f;
}

function markText(text, terms) {
  const folded = fold(text);
  let best = -1;
  let len = 0;
  for (const t of terms) {
    const i = folded.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) { best = i; len = t.length; }
  }
  if (best === -1) return [text];
  return [text.slice(0, best), el('mark', { text: text.slice(best, best + len) }), text.slice(best + len)];
}

function releaseSearchUrls() {
  searchUrls.forEach((u) => URL.revokeObjectURL(u));
  searchUrls = [];
}

export function clearSearchScreen() {
  releaseSearchUrls();
  searchState = { query: '', folder: '', period: '', amount: '' };
  const box = document.getElementById('search-view');
  if (box) box.replaceChildren();
}

export function renderSearchScreen({ focus = false } = {}) {
  const box = document.getElementById('search-view');
  if (!box || !ctx.getKey()) return;
  const input = el('input', {
    type: 'search', class: 'search-pill-input', placeholder: 'Suchen …', 'aria-label': 'Dokumente durchsuchen',
    value: searchState.query, autocomplete: 'off', enterkeyhint: 'search'
  });
  const clear = el('button', { type: 'button', class: 'search-clear', 'aria-label': 'Suchbegriff löschen', onclick: () => { input.value = ''; update(); input.focus(); } }, icon('x'));
  const pill = el('label', { class: 'search-pill' }, icon('search'), input, clear);
  const cancel = el('button', { type: 'button', class: 'f-link search-cancel', text: 'Abbrechen', onclick: () => {
    searchState = { query: '', folder: '', period: '', amount: '' };
    renderSearchScreen();
  } });

  // Filter-Chips (native Auswahl, damit es auf dem iPhone die gewohnte Auswahlliste gibt)
  const year = new Date().getFullYear();
  const chipSelect = (label, key, options) => {
    const sel = el('select', { 'aria-label': label }, el('option', { value: '', text: label }), ...options.map(([v, t]) => el('option', { value: v, text: t, selected: v === searchState[key] })));
    sel.addEventListener('change', () => { searchState[key] = sel.value; update(); });
    const chosen = options.find(([v]) => v === searchState[key]);
    return el('label', { class: `f-filter${searchState[key] ? ' is-active' : ''}` }, chosen ? chosen[1] : label, icon('down'), sel);
  };
  const anyFilter = () => searchState.folder || searchState.period || searchState.amount;
  const filters = el('div', { class: 'filter-row' },
    el('button', { type: 'button', class: `f-filter${anyFilter() ? '' : ' is-active'}`, onclick: () => { Object.assign(searchState, { folder: '', period: '', amount: '' }); update(); } }, 'Alle'),
    chipSelect('Ablageort', 'folder', flatFolders().map((f) => [f.id, f.label.trim()])),
    chipSelect('Zeitraum', 'period', [['month', 'Dieser Monat'], ['30', 'Letzte 30 Tage'], ['365', 'Letzte 12 Monate'], [`y${year}`, String(year)], [`y${year - 1}`, String(year - 1)]]),
    chipSelect('Betrag', 'amount', [['lt50', 'unter 50 €'], ['50to100', '50–100 €'], ['gt100', 'über 100 €']])
  );
  const results = el('div', { class: 'search-results' });

  const update = () => {
    searchState.query = input.value;
    clear.hidden = !input.value;
    releaseSearchUrls();
    renderId++;
    const q = searchState.query.trim();
    let hits;
    if (q) {
      hits = runSearch(q, searchFilter()).filter((h) => amountMatches(h.doc, searchState.amount));
    } else if (anyFilter()) {
      const f = searchFilter();
      hits = docs.filter((d) => (!f.folderIds || f.folderIds.has(existingFolderId(d.meta.category)))
        && (!f.from || (d.meta.date || '') >= f.from) && (!f.to || (d.meta.date || '') <= f.to)
        && amountMatches(d, searchState.amount)).map((doc) => ({ doc, page: 0, snippet: null, terms: [] }));
    } else {
      results.replaceChildren(...suggestionsBlock(input, update));
      return;
    }
    results.replaceChildren(
      el('p', { class: 'search-meta', text: `${hits.length === 1 ? '1 Treffer' : `${hits.length} Treffer`} · offline durchsucht` }),
      ...(hits.length ? hits.slice(0, 60).map(searchCard) : [el('p', { class: 'hint center', text: 'Nichts gefunden. Tipp: weniger oder kürzere Wörter versuchen.' })])
    );
  };
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); rememberSearch(ctx.getKey(), input.value); } });
  input.addEventListener('change', () => rememberSearch(ctx.getKey(), input.value));

  box.replaceChildren(el('div', { class: 'search-top' }, pill, cancel), filters, results);
  // Filter-Chips nach Änderung neu zeichnen (aktiver Zustand)
  const rerenderFilters = () => renderSearchScreen();
  filters.querySelectorAll('select').forEach((sel) => sel.addEventListener('change', rerenderFilters));
  filters.querySelector('button').addEventListener('click', rerenderFilters);
  update();
  if (focus) setTimeout(() => input.focus(), 50);
}

/** Vorschläge – nur aus vorhandenen Daten */
function suggestionsBlock(input, update) {
  const out = [];
  const recent = recentSearches();
  if (recent.length) {
    out.push(el('h2', { class: 'f-overline', text: 'Zuletzt gesucht' }),
      el('div', { class: 'chip-row' }, recent.map((q) => el('button', { type: 'button', class: 'f-filter is-soft', text: q, onclick: () => { input.value = q; update(); } }))));
  }
  const year = new Date().getFullYear();
  const sugg = [];
  // Ordner mit den meisten Dokumenten in diesem Jahr
  const counts = new Map();
  for (const d of docs) if ((d.meta.date || '').startsWith(String(year))) {
    const top = folderPath(existingFolderId(d.meta.category))[0];
    if (top) counts.set(top.id, (counts.get(top.id) || 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) sugg.push({ text: `${folderById(best[0]).name} ${year}`, apply: () => Object.assign(searchState, { folder: best[0], period: `y${year}` }) });
  if (docs.some((d) => (amountOf(d) || 0) > 100)) sugg.push({ text: 'über 100 €', apply: () => Object.assign(searchState, { amount: 'gt100' }) });
  const month = new Date().toISOString().slice(0, 7);
  if (openDeadlines(docs).some((d) => reminderOf(d.meta).date.startsWith(month))) sugg.push({ text: 'Frist diesen Monat', apply: () => { ctx.openCollectionSoon(); } });
  if (sugg.length) {
    out.push(el('h2', { class: 'f-overline', text: 'Vorschläge' }),
      el('div', { class: 'chip-row' }, sugg.map((s) => el('button', { type: 'button', class: 'f-filter is-soft', text: s.text, onclick: () => { s.apply(); renderSearchScreen(); } }))));
  }
  if (!out.length) out.push(el('p', { class: 'hint center', text: 'Suche nach Titel, Absender, Betrag, Datum oder jedem Wort im Dokument.' }));
  return out;
}

/** Ein Treffer als Karte: Vorschau, Titel (markiert), Titel/Text-Kennzeichen, Ausschnitt */
function searchCard(hit) {
  const { doc, snippet, terms } = hit;
  const myRender = renderId;
  const img = el('img', { alt: '' });
  loadThumb(ctx.getKey(), doc).then((blob) => {
    if (myRender !== renderId) return;
    const url = URL.createObjectURL(blob);
    searchUrls.push(url);
    img.src = url;
  }).catch(() => {});
  const head = fold(`${doc.meta.title} ${doc.meta.sender || ''}`);
  const inTitle = terms.some((t) => head.includes(t));
  const sub = [doc.meta.sender, folderById(existingFolderId(doc.meta.category))?.name].filter(Boolean).join(' · ');
  return el('button', { type: 'button', class: 'search-card', onclick: () => {
    rememberSearch(ctx.getKey(), searchState.query);
    ctx.openDocFromSearch(doc.id, hit.page, terms);
  } },
    el('span', { class: 'search-thumb' }, img),
    el('span', { class: 'search-body' },
      el('span', { class: 'search-title-row' },
        el('span', { class: 'search-title' }, ...markText(doc.meta.title, terms)),
        terms.length ? el('span', { class: `f-chip ${inTitle ? 'is-blue' : ''}`, text: inTitle ? 'Titel' : 'Text' }) : null
      ),
      sub ? el('span', { class: 'search-sub', text: sub }) : null,
      snippet ? el('span', { class: 'search-snippet' }, snippet.before, el('mark', { text: snippet.hit }), snippet.after) : null,
      el('span', { class: 'search-foot', text: [doc.meta.pageCount > 1 ? `Seite ${hit.page + 1}` : null, formatDate(doc.meta.date)].filter(Boolean).join(' · ') })
    )
  );
}

/** Dokument aus der Suche öffnen (springt zur Seite, markiert das Wort). */
export function openDocFrom(id, page, terms) {
  go({ name: 'detail', id, back: { name: 'search' }, page, terms });
}

export function openCollection(id) {
  go({ name: 'collection', id });
}
