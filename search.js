// Suche über alle Dokumente – mit MiniSearch (liegt im Projekt).
//
//  - Der Index entsteht beim Entsperren im Arbeitsspeicher und wird nie
//    gespeichert. Beim Sperren wird er verworfen.
//  - Durchsucht: Titel, Absender, Ordner, Notiz/erkannte Felder, Scan-Text.
//  - Mehrere Wörter = UND. Treffer in Titel und Absender stehen oben.
//  - Tolerant: Tippfehler (ab 5 Buchstaben), Wortanfänge, Teile deutscher
//    Zusammensetzungen („versicherung“ → „Haftpflichtversicherung“),
//    Groß/klein, Umlaute, ß und Akzente.
//  - Zahlen und Daten in mehreren Schreibweisen: 89,90 = 89.90,
//    11.11.2026 = 11.11.26 = 2026-11-11.

import MiniSearch from './minisearch.js';
import { getAllPageTexts, getMeta, setMeta } from './db.js';
import { decryptJSON, encryptJSON } from './crypto.js';
import { folderLabel, existingFolderId } from './folders.js';

let mini = null;
let pageTexts = new Map();   // docId → [Text je Seite]
let docsById = new Map();
let hayCache = new Map();    // docId → aufbereiteter Gesamttext (für Wortteile)
let history = [];

// ---------------------------------------------------------------------
// Normalisieren
// ---------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');

/** Daten und Beträge in eine einheitliche Schreibweise bringen. */
export function canonical(text) {
  return String(text || '')
    .replace(/(^|[^\d])(\d{1,2})\s?\.\s?(\d{1,2})\s?\.\s?(\d{4}|\d{2})(?!\d)/g, (m, pre, d, mo, y) => {
      const year = y.length === 2 ? `20${y}` : y;
      return `${pre} dt${year}${pad(mo)}${pad(d)} `;
    })
    .replace(/(^|[^\d])(\d{4})-(\d{2})-(\d{2})(?!\d)/g, (m, pre, y, mo, d) => `${pre} dt${y}${mo}${d} `)
    .replace(/(\d)[.\s'](?=\d{3}(?:[.,]\d{2})(?!\d))/g, '$1')       // 1.234,56 → 1234,56
    .replace(/(^|[^\d])(\d+)[.,](\d{2})(?!\d)/g, '$1$2d$3');          // 89,90 / 89.90 → 89d90
}

/** Kleinbuchstaben, ß → ss, Umlaute und Akzente entfernen. */
export const fold = (text) => String(text || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '');

// Häufige Wortteile in deutschen Dokumenten (ohne Umlaute geschrieben)
const PARTS = [
  'versicherungen', 'versicherung', 'abrechnung', 'rechnung', 'bescheinigung', 'bestatigung', 'bescheid', 'vertrag',
  'nummer', 'schein', 'police', 'beitrag', 'betrag', 'haftpflicht', 'hausrat', 'krankenkasse', 'krankenhaus', 'kranken',
  'kasse', 'steuer', 'einkommen', 'lohn', 'gehalt', 'entgelt', 'strom', 'wasser', 'miete', 'kosten', 'konto', 'auszug',
  'karte', 'kredit', 'brief', 'zahnarzt', 'arzt', 'termin', 'frist', 'zahlung', 'mahnung', 'gebuhren', 'gebuhr', 'leistung',
  'antrag', 'nachweis', 'kundigung', 'rente', 'pflege', 'unfall', 'leben', 'reise', 'rechtsschutz', 'gebaude', 'telefon',
  'internet', 'mobilfunk', 'energie', 'heizung', 'schule', 'kinder', 'geld', 'arbeitgeber', 'arbeit', 'zeugnis', 'klinik',
  'befund', 'labor', 'therapie', 'rezept', 'behandlung', 'tarif', 'kunden', 'abschlag', 'jahres', 'bericht', 'entlass'
].sort((a, b) => b.length - a.length);

/** Zusammengesetzte Wörter in Teile zerlegen: haftpflichtversicherung → haftpflicht, versicherung */
export function decompose(term, depth = 0) {
  if (term.length < 8 || depth > 3) return [];
  for (const part of PARTS) {
    if (term.endsWith(part) && term.length - part.length >= 3) {
      let rest = term.slice(0, -part.length);
      if (/[^s]s$/.test(rest) && rest.length >= 5) rest = rest.slice(0, -1); // Fugen-s: versicherungs|beitrag
      const out = [part];
      if (rest.length >= 3) out.push(rest, ...decompose(rest, depth + 1));
      return out;
    }
    if (term.startsWith(part) && term.length - part.length >= 4) {
      const rest = term.slice(part.length);
      return [part, rest, ...decompose(rest, depth + 1)];
    }
  }
  return [];
}

const tokenize = (text) => canonical(text).split(/[^\p{L}\p{N}]+/u);

function processTerm(term) {
  const t = fold(term);
  if (t.length < 2) return null;
  const parts = decompose(t).filter((p) => p.length >= 3);
  return parts.length ? [t, ...parts] : t;
}

// ---------------------------------------------------------------------
// Index aufbauen
// ---------------------------------------------------------------------
function docEntry(doc) {
  const m = doc.meta;
  const texts = pageTexts.get(doc.id) || (m.text ? [m.text] : []);
  return {
    id: doc.id,
    title: m.title || '',
    sender: m.sender || '',
    folder: folderLabel(existingFolderId(m.category)),
    extra: [m.note, m.date, m.dueDate, m.reminder && m.reminder.amount, m.amount, m.warrantyUntil, Array.isArray(m.tags) ? m.tags.join(' ') : null, (m.fields && Object.values(m.fields).join(' '))].filter(Boolean).join(' '),
    text: texts.join('\n')
  };
}

function newIndex() {
  return new MiniSearch({
    fields: ['title', 'sender', 'folder', 'extra', 'text'],
    idField: 'id',
    tokenize,
    processTerm,
    searchOptions: { tokenize, processTerm: (t) => fold(canonical(t)) }
  });
}

/** Beim Entsperren: alle Seiten-Texte entschlüsseln und Index bauen. */
export async function buildIndex(key, docs) {
  pageTexts = new Map();
  for (const { key: pk, box } of await getAllPageTexts()) {
    const [docId, nr] = String(pk).split('/');
    try {
      const { text } = await decryptJSON(key, box);
      if (!pageTexts.has(docId)) pageTexts.set(docId, []);
      pageTexts.get(docId)[Number(nr)] = text || '';
    } catch { /* unlesbar → überspringen */ }
  }
  for (const [id, arr] of pageTexts) pageTexts.set(id, Array.from(arr, (t) => t || ''));
  setDocs(docs);
  await loadHistory(key);
}

/** Dokumentliste neu setzen (nach Speichern, Ändern, Löschen). */
function hay(doc) {
  let h = hayCache.get(doc.id);
  if (h === undefined) {
    const e = docEntry(doc);
    h = fold(canonical([e.title, e.sender, e.folder, e.extra, e.text].join(' ')));
    hayCache.set(doc.id, h);
  }
  return h;
}

export function setDocs(docs) {
  docsById = new Map(docs.map((d) => [d.id, d]));
  hayCache = new Map();
  mini = newIndex();
  mini.addAll(docs.map(docEntry));
}

/** Text einer Seite ist fertig erkannt → Index für dieses Dokument erneuern. */
export function setPageText(docId, index, text) {
  if (!pageTexts.has(docId)) pageTexts.set(docId, []);
  const arr = pageTexts.get(docId);
  arr[index] = text || '';
  pageTexts.set(docId, Array.from(arr, (t) => t || ''));
  hayCache.delete(docId);
  const doc = docsById.get(docId);
  if (doc && mini) {
    if (mini.has(docId)) mini.replace(docEntry(doc)); else mini.add(docEntry(doc));
  }
}

export const getPageTextsFor = (docId) => pageTexts.get(docId) || [];
export const hasText = (docId) => (pageTexts.get(docId) || []).some((t) => t && t.trim());

export function clearSearch() {
  mini = null;
  pageTexts = new Map();
  docsById = new Map();
  hayCache = new Map();
  history = [];
}

// ---------------------------------------------------------------------
// Suchen
// ---------------------------------------------------------------------
function foldWithMap(text) {
  let folded = '';
  const map = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
  }
  return { folded, map };
}

function makeSnippet(text, terms) {
  const { folded, map } = foldWithMap(text);
  let best = -1;
  let hitLen = 0;
  for (const term of terms) {
    const pos = folded.indexOf(term);
    if (pos !== -1 && (best === -1 || pos < best)) { best = pos; hitLen = term.length; }
  }
  if (best === -1) return null;
  const start = map[best];
  const end = (map[best + hitLen - 1] ?? start) + 1;
  // an Wortgrenzen beginnen und enden
  let from = Math.max(0, start - 40);
  const space = text.indexOf(' ', from);
  if (from > 0 && space !== -1 && space < start) from = space + 1;
  let to = Math.min(text.length, end + 60);
  const endSpace = text.lastIndexOf(' ', to);
  if (to < text.length && endSpace > end) to = endSpace;
  const clean = (s) => s.replace(/\s+/g, ' ');
  return {
    before: (from > 0 ? '…' : '') + clean(text.slice(from, start)),
    hit: text.slice(start, end),
    after: clean(text.slice(end, to)) + (to < text.length ? '…' : '')
  };
}

/**
 * Suchen. filter: { folderIds: Set | null, from: 'JJJJ-MM-TT' | null, to: … }
 * Ergebnis: [{ doc, score, page, snippet, terms }]
 */
export function search(query, filter = {}) {
  if (!mini || !query.trim()) return [];
  const queryTerms = tokenize(query).map((t) => fold(t)).filter((t) => t.length >= 2);
  if (!queryTerms.length) return [];

  const searchable = (doc) => {
    const m = doc.meta;
    if (m.trashedAt) return false;
    if (filter.folderIds && !filter.folderIds.has(existingFolderId(m.category))) return false;
    if (filter.from && (m.date || '') < filter.from) return false;
    if (filter.to && (m.date || '') > filter.to) return false;
    return true;
  };

  // Pro Suchwort: Treffer aus dem Index (Wortanfang, Tippfehler, Wortteile) …
  let combined = null;
  for (const term of queryTerms) {
    const hits = new Map();
    const results = mini.search(term, {
      prefix: true,
      fuzzy: (t) => (t.length >= 5 && !/\d/.test(t) ? 0.2 : false),
      boost: { title: 4, sender: 3, folder: 2, extra: 1.5, text: 1 },
      combineWith: 'OR'
    });
    for (const r of results) hits.set(r.id, { score: r.score, terms: r.terms });
    // … plus Wortteile mitten im Wort (z. B. „pflicht“ in „Haftpflichtversicherung“)
    if (term.length >= 4) {
      for (const doc of docsById.values()) {
        if (hits.has(doc.id)) continue;
        if (hay(doc).includes(term)) hits.set(doc.id, { score: 0.5, terms: [term] });
      }
    }
    if (combined === null) {
      combined = hits;
    } else {
      for (const id of [...combined.keys()]) {
        if (!hits.has(id)) combined.delete(id);
        else {
          const a = combined.get(id);
          const b = hits.get(id);
          combined.set(id, { score: a.score + b.score, terms: [...a.terms, ...b.terms] });
        }
      }
    }
  }

  const out = [];
  for (const [id, { score, terms }] of combined || []) {
    const doc = docsById.get(id);
    if (!doc || !searchable(doc)) continue;
    const allTerms = [...new Set([...terms, ...queryTerms])].sort((a, b) => b.length - a.length);
    // Treffer in Titel oder Absender nach oben
    const head = fold(`${doc.meta.title} ${doc.meta.sender || ''}`);
    const bonus = queryTerms.every((t) => head.includes(t)) ? 100 : allTerms.some((t) => head.includes(t)) ? 20 : 0;
    out.push({ doc, score: score + bonus, page: 0, snippet: null, terms: allTerms });
  }
  out.sort((a, b) => b.score - a.score || (b.doc.meta.date || '').localeCompare(a.doc.meta.date || ''));
  // Seite und Textausschnitt nur für die angezeigten Treffer berechnen
  for (const hit of out.slice(0, filter.limit || 60)) {
    const texts = pageTexts.get(hit.doc.id) || (hit.doc.meta.text ? [hit.doc.meta.text] : []);
    for (let i = 0; i < texts.length && !hit.snippet; i++) {
      hit.snippet = makeSnippet(texts[i] || '', hit.terms);
      if (hit.snippet) hit.page = i;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Letzte Suchen (verschlüsselt gespeichert)
// ---------------------------------------------------------------------
async function loadHistory(key) {
  try {
    const box = await getMeta('searchHistory');
    history = box ? await decryptJSON(key, box) : [];
  } catch {
    history = [];
  }
}

export const recentSearches = () => history.slice(0, 5);

export async function rememberSearch(key, query) {
  const q = query.trim();
  if (q.length < 2 || !key) return;
  history = [q, ...history.filter((h) => h.toLowerCase() !== q.toLowerCase())].slice(0, 5);
  await setMeta('searchHistory', await encryptJSON(key, history));
}
