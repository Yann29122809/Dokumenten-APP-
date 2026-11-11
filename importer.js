// Import bestehender Dokumente: PDF, JPG, PNG, HEIC, WebP – mehrere auf einmal.
//
// Ablauf:
//  1. Gewählte Dateien landen sofort verschlüsselt im „Eingang“ (übersteht
//     das Schließen der App).
//  2. Eine Datei nach der anderen wird gelesen: PDF-Seiten gerendert und die
//     Textebene ausgelesen, Bilder verkleinert (max. 2000 Pixel), bei Bedarf
//     Texterkennung. Daraus entstehen Vorschläge für Titel, Ordner und Datum.
//  3. Du bestätigst einzeln oder alle auf einmal. Erst dann wird gespeichert.
//
// PDFs werden unverändert (verschlüsselt) aufbewahrt. Ein PDF-Passwort wird
// nur im Arbeitsspeicher benutzt und nie gespeichert.

import * as db from './db.js';
import { encryptBytes, decryptBytes, encryptJSON, decryptJSON } from './crypto.js';
import { el, todayISO, formatBytes, toast } from './dom.js';
import { icon } from './icons.js';
import { prepareImage, makeThumb } from './images.js';
import { saveDocument } from './docs.js';
import { fillFolderSelect, existingFolderId, folderSingular, folderLabel, onFoldersChanged, allFolders } from './folders.js';
import { suggestFromText } from './suggest.js';
import { recognizePage } from './ocr.js';
import { openPdf, renderPdf, closePdf, PdfPasswordError } from './pdfimport.js';

const BIG_FILE = 20 * 1024 * 1024;
const $ = (id) => document.getElementById(id);

let ctx = null;
let items = new Map();  // id → { id, added, info, state, bytes, pages, password, thumbUrl, selected }
let working = false;

export function initImport(context) {
  ctx = context;
  const input = $('input-import');
  const open = () => { ctx.suspendAutoLock(); input.click(); };
  document.querySelectorAll('[data-action="import"]').forEach((b) => b.addEventListener('click', open));
  input.addEventListener('cancel', () => ctx.resumeAutoLock());
  input.addEventListener('change', async () => {
    ctx.resumeAutoLock();
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) await addFiles(files);
  });
  onFoldersChanged(() => { if (ctx.getKey()) render(); });
}

// ---------------------------------------------------------------------
// Dateien aufnehmen
// ---------------------------------------------------------------------
function kindOf(bytes, name, type) {
  const b = bytes.subarray(0, 16);
  const str = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (str(0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image';
  if (b[0] === 0x89 && str(1, 4) === 'PNG') return 'image';
  if (str(0, 4) === 'RIFF' && str(8, 12) === 'WEBP') return 'image';
  if (str(4, 8) === 'ftyp') return 'image'; // HEIC/HEIF
  if (/pdf/i.test(type) || /\.pdf$/i.test(name)) return 'pdf';
  if (/^image\//.test(type)) return 'image';
  return 'unknown';
}

async function persist(item) {
  const key = ctx.getKey();
  if (!key) return;
  await db.putInbox({ id: item.id, added: item.added, file: item.fileBox, info: await encryptJSON(key, item.info), state: await encryptJSON(key, item.state) });
}

async function addFiles(files) {
  const key = ctx.getKey();
  if (!key) return;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = { name: file.name || 'Datei', type: file.type || '', size: bytes.byteLength, lastModified: file.lastModified || Date.now() };
    const kind = kindOf(bytes, info.name, info.type);
    const item = {
      id: crypto.randomUUID(),
      added: Date.now() + items.size,
      info,
      bytes,
      fileBox: await encryptBytes(key, bytes),
      state: { status: kind === 'unknown' ? 'error' : 'waiting', kind, error: kind === 'unknown' ? 'Dateityp wird nicht unterstützt (nur PDF, JPG, PNG, HEIC, WebP).' : null, dirty: {} },
      pages: null,
      selected: true
    };
    items.set(item.id, item);
    await persist(item);
  }
  toast(files.length === 1 ? '1 Datei im Eingang' : `${files.length} Dateien im Eingang`);
  render();
  $('inbox-section').scrollIntoView({ block: 'start', behavior: 'smooth' });
  work();
}

/** Beim Entsperren: Eingang aus dem Speicher laden und weiterarbeiten. */
export async function loadInbox() {
  const key = ctx.getKey();
  items = new Map();
  for (const rec of await db.getAllInbox()) {
    try {
      const info = await decryptJSON(key, rec.info);
      const state = await decryptJSON(key, rec.state);
      // War gerade in Arbeit, als die App geschlossen wurde → neu beginnen (Ergebnisse bleiben)
      if (['reading', 'ocr'].includes(state.status)) state.status = 'waiting';
      if (state.status === 'ready') state.status = 'waiting'; // Seitenbilder neu erzeugen
      items.set(rec.id, { id: rec.id, added: rec.added, info, state, fileBox: rec.file, bytes: null, pages: null, selected: true });
    } catch (err) {
      console.error('Eingang: Eintrag unlesbar', err);
    }
  }
  render();
  work();
}

export function clearInbox() {
  for (const item of items.values()) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  items = new Map();
  working = false;
  const section = $('inbox-section');
  if (section) { section.hidden = true; $('inbox-list').replaceChildren(); }
}

export const inboxCount = () => items.size;

// ---------------------------------------------------------------------
// Verarbeiten – eine Datei nach der anderen
// ---------------------------------------------------------------------
async function work() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      if (!ctx.getKey()) break;
      const next = [...items.values()].sort((a, b) => a.added - b.added).find((i) => i.state.status === 'waiting');
      if (!next) break;
      await processItem(next);
    }
  } finally {
    working = false;
  }
}

function setStatus(item, status, extra = {}) {
  Object.assign(item.state, { status }, extra);
  renderCard(item);
}

async function processItem(item) {
  const key = ctx.getKey();
  try {
    if (!item.bytes) item.bytes = await decryptBytes(key, item.fileBox);
    setStatus(item, 'reading', { error: null, progress: null });
    item.state.big = item.info.size > BIG_FILE;

    // 1. Seiten erzeugen
    let textLayer = null;
    if (item.state.kind === 'pdf') {
      const pdf = await openPdf(item.bytes, item.password);
      try {
        const result = await renderPdf(pdf, (n, total) => setStatus(item, 'reading', { progress: `Seite ${n} von ${total}` }));
        item.pages = result.pages.map(({ blob, width, height }) => ({ blob, width, height }));
        if (result.hasText) textLayer = result.pages.map((p) => ({ text: p.text, words: p.words, w: p.width, h: p.height, source: 'pdf' }));
      } finally {
        await closePdf(pdf);
      }
    } else {
      const img = await prepareImage(new Blob([item.bytes], { type: item.info.type || 'image/jpeg' }));
      item.pages = [{ blob: img.blob, width: img.width, height: img.height }];
    }
    item.state.pageCount = item.pages.length;
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    item.thumbUrl = URL.createObjectURL(await makeThumb(item.pages[0].blob));

    // 2. Text: Textebene der PDF, sonst Texterkennung (falls eingeschaltet)
    if (textLayer) item.state.texts = textLayer;
    if (!item.state.texts && ctx.isOcrEnabled()) {
      const texts = [];
      for (const [i, page] of item.pages.entries()) {
        setStatus(item, 'ocr', { progress: `Text wird erkannt: Seite ${i + 1} von ${item.pages.length}` });
        const r = await recognizePage(page.blob);
        texts.push({ text: r.text, words: r.words, w: page.width, h: page.height, source: 'ocr' });
        if (!ctx.getKey()) return;
      }
      item.state.texts = texts;
    }

    // 3. Vorschläge (nur Felder, die du nicht selbst geändert hast)
    applySuggestions(item);
    setStatus(item, 'ready', { progress: null });
    await persist(item);
  } catch (err) {
    if (err instanceof PdfPasswordError) {
      setStatus(item, 'password', { error: err.message, wrongPassword: err.wrong });
    } else {
      console.error('Import fehlgeschlagen:', err);
      const heic = /heic|heif/i.test(item.info.type) || /\.(heic|heif)$/i.test(item.info.name);
      setStatus(item, 'error', { error: heic ? 'HEIC-Bild kann dieser Browser nicht lesen (auf dem iPhone in Safari geht es).' : 'Datei konnte nicht gelesen werden.' });
    }
    await persist(item).catch(() => {});
  }
}

function isoFromTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function applySuggestions(item) {
  const st = item.state;
  const text = (st.texts || []).map((t) => t.text).join('\n\n');
  const s = suggestFromText(text, ctx.getDocs()) || {};
  st.suggested = {};
  const set = (field, value) => {
    if (st.dirty[field] || value === undefined || value === null || value === '') return;
    st[field] = value;
    st.suggested[field] = true;
  };
  set('folder', s.folderId);
  set('date', s.date);
  set('title', s.title);
  set('note', s.note);
  st.sender = s.sender || null;
  st.reminderSuggestion = s.dueDate ? { date: s.dueDate, kind: s.dueKind || 'Zahlung', amount: s.amount || null } : null;
  if (!st.date) st.date = isoFromTime(item.info.lastModified); // Datum aus der Datei
  if (!st.folder) st.folder = existingFolderId('letter');
  if (!st.title) st.title = item.info.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || `${folderSingular(st.folder)} ${st.date}`;
}

// ---------------------------------------------------------------------
// Speichern (bestätigen) und verwerfen
// ---------------------------------------------------------------------
async function confirmItem(item, { silent = false } = {}) {
  const key = ctx.getKey();
  if (!key || item.state.status !== 'ready' || !item.pages) return false;
  const st = item.state;
  // Duplikatprüfung vor dem Speichern
  let check = { decision: 'save', extraMeta: {}, afterSave: () => {} };
  if (ctx.checkDuplicate) {
    check = await ctx.checkDuplicate({
      kind: st.kind, bytes: item.bytes, pages: item.pages, texts: st.texts || [],
      meta: { title: st.title, category: existingFolderId(st.folder), date: st.date, sender: st.sender, note: st.note, pageCount: item.pages.length },
      sizeBytes: item.info.size,
      // „Rückgängig“ nach „Duplikat“: Datei kommt zurück in den Eingang
      onUndoSkip: async () => { items.set(item.id, item); await persist(item); render(); }
    });
    if (check.decision === 'skip') { await discardItem(item, true); return false; }
    if (check.decision === 'later') return false;
  }

  setStatus(item, 'saving');
  try {
    const blobs = item.pages.map((p) => p.blob);
    const thumb = await makeThumb(blobs[0]);
    const texts = (st.texts || []).map((t) => (t && t.text !== undefined ? t : null));
    while (texts.length < blobs.length) texts.push(null);
    const meta = {
      title: (st.title || '').trim() || item.info.name,
      category: existingFolderId(st.folder),
      date: st.date || todayISO(),
      note: (st.note || '').trim(),
      sender: st.sender || null,
      source: 'import',
      fileName: item.info.name,
      reminderSuggestion: st.reminderSuggestion || null,
      ...check.extraMeta
    };
    const file = st.kind === 'pdf' ? { bytes: item.bytes, type: 'application/pdf', name: item.info.name } : null;
    const docId = await saveDocument(key, meta, blobs, thumb, { texts, file });
    await db.deleteInbox(item.id);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    items.delete(item.id);
    const missing = texts.map((t, i) => (t ? null : i)).filter((i) => i !== null);
    await ctx.onImported(docId, texts);
    if (missing.length && ctx.isOcrEnabled()) ctx.enqueueOcr(docId, missing);
    if (!silent) toast(`Gespeichert in ${folderLabel(meta.category)}`);
    await check.afterSave(docId); // zeigt ggf. „Beide behalten · Rückgängig“
    render();
    return true;
  } catch (err) {
    console.error(err);
    setStatus(item, 'ready', { error: 'Speichern fehlgeschlagen. Ist der Speicher voll?' });
    return false;
  }
}

async function discardItem(item, quiet = false) {
  await db.deleteInbox(item.id);
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  items.delete(item.id);
  if (!quiet) toast('Aus dem Eingang entfernt');
  render();
}

// ---------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------
function render() {
  const section = $('inbox-section');
  if (!section) return;
  const list = [...items.values()].sort((a, b) => a.added - b.added);
  section.hidden = list.length === 0;
  if (!list.length) { $('inbox-list').replaceChildren(); return; }
  const ready = list.filter((i) => i.state.status === 'ready');
  const busy = list.filter((i) => ['waiting', 'reading', 'ocr', 'saving'].includes(i.state.status)).length;
  $('inbox-count').textContent = `${list.length} ${list.length === 1 ? 'Datei' : 'Dateien'}${busy ? ` · ${busy} in Arbeit` : ''}`;

  const bulkFolder = el('select', { class: 'filter-select', 'aria-label': 'Ordner für die Auswahl' });
  fillFolderSelect(bulkFolder, 'letter');
  const selectedReady = () => ready.filter((i) => i.selected);
  $('inbox-bulk').replaceChildren(
    el('button', { type: 'button', class: 'btn-primary with-icon', disabled: !ready.length, onclick: async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      let n = 0;
      for (const item of selectedReady()) if (await confirmItem(item, { silent: true })) n++;
      toast(n === 1 ? '1 Dokument gespeichert' : `${n} Dokumente gespeichert`);
      render();
    } }, icon('check'), ready.length ? `Auswahl bestätigen (${selectedReady().length})` : 'Wird vorbereitet …'),
    el('div', { class: 'bulk-row' },
      bulkFolder,
      el('button', { type: 'button', class: 'btn-secondary', text: 'Ordner setzen', disabled: !ready.length, onclick: async () => {
        for (const item of selectedReady()) {
          item.state.folder = bulkFolder.value;
          item.state.dirty.folder = true;
          if (item.state.suggested) delete item.state.suggested.folder;
          await persist(item);
        }
        render();
        toast('Ordner übernommen');
      } })
    )
  );
  $('inbox-list').replaceChildren(...list.map((item) => {
    const card = el('div', { class: 'inbox-card', id: `inbox-${item.id}` });
    fillCard(card, item);
    return card;
  }));
}

function renderCard(item) {
  const card = document.getElementById(`inbox-${item.id}`);
  if (card) fillCard(card, item); else render();
  if (['ready', 'error', 'password'].includes(item.state.status)) render();
}

const STATUS_TEXT = {
  waiting: 'Wartet …',
  reading: 'Wird gelesen …',
  ocr: 'Text wird erkannt …',
  saving: 'Wird verschlüsselt gespeichert …',
  ready: 'Bereit – bitte prüfen',
  error: 'Fehler',
  password: 'Passwort nötig'
};

function fillCard(card, item) {
  const st = item.state;
  const head = el('div', { class: 'inbox-head' },
    el('span', { class: 'inbox-thumb' }, item.thumbUrl ? el('img', { src: item.thumbUrl, alt: '' }) : icon(st.kind === 'pdf' ? 'file' : 'photos')),
    el('span', { class: 'inbox-meta' },
      el('strong', { class: 'inbox-name', text: item.info.name }),
      el('span', { class: 'inbox-sub', text: [
        st.kind === 'pdf' ? 'PDF' : 'Bild', formatBytes(item.info.size),
        st.pageCount ? (st.pageCount === 1 ? '1 Seite' : `${st.pageCount} Seiten`) : null,
        st.texts && st.texts[0] && st.texts[0].source === 'pdf' ? 'Textebene' : null
      ].filter(Boolean).join(' · ') }),
      el('span', { class: `inbox-status is-${st.status}` },
        ['waiting', 'reading', 'ocr', 'saving'].includes(st.status) ? el('span', { class: 'spinner', 'aria-hidden': 'true' }) : null,
        st.progress || STATUS_TEXT[st.status])
    ),
    st.status === 'ready' ? el('input', { type: 'checkbox', class: 'inbox-check', checked: item.selected, 'aria-label': 'Für „Auswahl bestätigen“ auswählen', onchange: (e) => { item.selected = e.target.checked; render(); } }) : null
  );

  const parts = [head];
  if (st.big) parts.push(el('p', { class: 'inbox-warning', text: `Große Datei (${formatBytes(item.info.size)}) – das Lesen kann eine Weile dauern.` }));

  if (st.status === 'error') {
    parts.push(el('p', { class: 'error', text: st.error || 'Unbekannter Fehler' }),
      el('div', { class: 'inbox-actions' },
        st.kind !== 'unknown' ? el('button', { type: 'button', class: 'btn-secondary', text: 'Wiederholen', onclick: () => { setStatus(item, 'waiting'); work(); } }) : null,
        el('button', { type: 'button', class: 'btn-text danger', text: 'Entfernen', onclick: () => discardItem(item) })));
  }

  if (st.status === 'password') {
    const pw = el('input', { type: 'password', autocomplete: 'off', placeholder: 'PDF-Passwort', 'aria-label': 'PDF-Passwort' });
    const form = el('form', { class: 'inbox-password', novalidate: true },
      el('p', { class: st.wrongPassword ? 'error' : 'hint', text: st.wrongPassword ? 'Das Passwort ist falsch. Bitte erneut versuchen.' : 'Diese PDF ist geschützt. Das Passwort wird nur jetzt zum Öffnen benutzt und nicht gespeichert.' }),
      pw,
      el('div', { class: 'inbox-actions' },
        el('button', { type: 'submit', class: 'btn-secondary', text: 'Öffnen' }),
        el('button', { type: 'button', class: 'btn-text danger', text: 'Entfernen', onclick: () => discardItem(item) })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      item.password = pw.value; // nur im Arbeitsspeicher
      pw.value = '';
      setStatus(item, 'waiting');
      work();
    });
    parts.push(form);
  }

  if (st.status === 'ready') {
    const sug = st.suggested || {};
    const mark = (field) => (sug[field] ? 'suggested' : null);
    const title = el('input', { type: 'text', value: st.title || '', maxlength: '120' });
    const folder = el('select', {});
    fillFolderSelect(folder, existingFolderId(st.folder));
    const date = el('input', { type: 'date', value: st.date || '' });
    const save = async (field, value) => {
      st[field] = value;
      st.dirty[field] = true;
      if (st.suggested) delete st.suggested[field];
      await persist(item);
    };
    title.addEventListener('change', () => save('title', title.value));
    folder.addEventListener('change', () => save('folder', folder.value));
    date.addEventListener('change', () => save('date', date.value));
    parts.push(
      el('div', { class: 'inbox-fields' },
        el('label', { class: mark('title') }, 'Titel', title),
        el('label', { class: mark('folder') }, 'Ablageort', folder),
        el('label', { class: mark('date') }, 'Datum', date)
      ),
      st.error ? el('p', { class: 'error', text: st.error }) : null,
      el('div', { class: 'inbox-actions' },
        el('button', { type: 'button', class: 'btn-primary with-icon', onclick: () => confirmItem(item) }, icon('check'), 'Speichern'),
        el('button', { type: 'button', class: 'btn-text danger', text: 'Verwerfen', onclick: () => { if (confirm('Diese Datei aus dem Eingang entfernen?')) discardItem(item); } }))
    );
  }
  card.className = `inbox-card is-${st.status}`;
  card.replaceChildren(...parts.filter(Boolean));
}

// Für Tests und das Einlesen aus anderen Stellen
export { addFiles as importFiles };
export const _items = () => items;
export const hasFolders = () => allFolders().length > 0;
