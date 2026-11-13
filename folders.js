// Ablageorte (Ordner) mit beliebig vielen Unterordnern.
// Die Ordnernamen sind privat (z. B. „Krankenakte“) und werden deshalb
// ebenfalls verschlüsselt gespeichert.

import { encryptJSON, decryptJSON } from './crypto.js';
import { getMeta, setMeta } from './db.js';

// Die fünf Start-Ordner. Ihre IDs sind fest, damit alte Dokumente passen.
const DEFAULT_FOLDERS = [
  { id: 'invoice',   name: 'Rechnungen',          singular: 'Rechnung',          parentId: null, color: '#e0803a' },
  { id: 'bank',      name: 'Bank',                singular: 'Bank',              parentId: null, color: '#2f8f5b' },
  { id: 'insurance', name: 'Versicherung',        singular: 'Versicherung',      parentId: null, color: '#3a7bd5' },
  { id: 'letter',    name: 'Briefe',              singular: 'Brief',             parentId: null, color: '#8a63c9' },
  { id: 'payslip',   name: 'Gehaltsabrechnungen', singular: 'Gehaltsabrechnung', parentId: null, color: '#c9a227' }
];

const PALETTE = ['#d0517a', '#1f9e9e', '#7a8a2e', '#b86b2a', '#5b6bd6', '#9c5bb8', '#4f8a8b', '#c4463a'];

let folders = [];
const listeners = new Set();

export const onFoldersChanged = (fn) => listeners.add(fn);
const notify = () => listeners.forEach((fn) => fn());

const byName = (a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });

export async function loadFolders(key) {
  const box = await getMeta('folders');
  folders = box ? await decryptJSON(key, box) : DEFAULT_FOLDERS.map((f) => ({ ...f }));
  notify();
}

async function save(key) {
  await setMeta('folders', await encryptJSON(key, folders));
  notify();
}

export function clearFolders() {
  folders = [];
  notify();
}

export const allFolders = () => folders;
export const folderById = (id) => folders.find((f) => f.id === id) || null;
export const childFolders = (parentId) => folders.filter((f) => f.parentId === parentId).sort(byName);

/** Pfad von oben bis zu diesem Ordner, z. B. [Krankenakte, Krankenhaus XY] */
export function folderPath(id) {
  const path = [];
  let current = folderById(id);
  while (current && path.length < 50) {
    path.unshift(current);
    current = current.parentId ? folderById(current.parentId) : null;
  }
  return path;
}

export const folderLabel = (id) => folderPath(id).map((f) => f.name).join(' › ') || 'Unbekannt';

/** Dieser Ordner und alle Unterordner (für Zählen und Suchen). */
export function descendantIds(id) {
  const ids = [id];
  for (let i = 0; i < ids.length; i++) {
    folders.filter((f) => f.parentId === ids[i]).forEach((f) => ids.push(f.id));
  }
  return ids;
}

/** Farbe kommt vom obersten Ordner. */
export function folderColor(id) {
  const path = folderPath(id);
  return path.length ? path[0].color : '#8a8f9c';
}

/** Wort für Titelvorschläge, z. B. „Rechnung“ – bei eigenen Ordnern der Name. */
export function folderSingular(id) {
  const folder = folderById(id);
  return folder ? (folder.singular || folder.name) : 'Dokument';
}

/** Ordner existiert nicht (mehr)? Dann in „Briefe“ bzw. den ersten Ordner. */
export function existingFolderId(id) {
  if (folderById(id)) return id;
  return folderById('letter') ? 'letter' : (folders[0] && folders[0].id);
}

/** Alle Ordner als eingerückte Liste für Auswahlfelder. */
export function folderOptions() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const folder of childFolders(parentId)) {
      out.push({ id: folder.id, label: `${' '.repeat(depth)}${depth ? '└ ' : ''}${folder.name}` });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function createFolder(key, name, parentId = null) {
  const clean = name.trim().slice(0, 60);
  if (!clean) throw new Error('Name fehlt');
  const roots = folders.filter((f) => !f.parentId).length;
  const folder = {
    id: crypto.randomUUID(),
    name: clean,
    parentId,
    color: parentId ? null : PALETTE[roots % PALETTE.length]
  };
  folders.push(folder);
  await save(key);
  return folder;
}

export async function renameFolder(key, id, name) {
  const folder = folderById(id);
  const clean = name.trim().slice(0, 60);
  if (!folder || !clean) return;
  folder.name = clean;
  delete folder.singular; // eigener Name gilt jetzt auch für Titelvorschläge
  await save(key);
}

export async function deleteFolder(key, id) {
  if (folders.some((f) => f.parentId === id)) throw new Error('Ordner hat Unterordner');
  folders = folders.filter((f) => f.id !== id);
  await save(key);
}

/**
 * Ordner samt Unterordnern und Dokumenten woanders einhängen.
 * newParentId = null → ganz oben in der Ablage. Die Dokumente behalten ihre
 * Ordner-ID, deshalb wandern sie automatisch mit.
 */
export async function moveFolder(key, id, newParentId) {
  const folder = folderById(id);
  if (!folder) return;
  if (newParentId && descendantIds(id).includes(newParentId)) throw new Error('Ein Ordner kann nicht in sich selbst verschoben werden');
  if (newParentId && !folderById(newParentId)) throw new Error('Zielordner fehlt');
  folder.parentId = newParentId || null;
  // Oberste Ordner brauchen eine eigene Farbe
  if (!folder.parentId && !folder.color) {
    const roots = folders.filter((f) => !f.parentId).length;
    folder.color = PALETTE[roots % PALETTE.length];
  }
  await save(key);
}

/** Beim Backup-Einlesen: fehlende Ordner ergänzen. */
export async function mergeFolders(key, incoming) {
  let added = 0;
  for (const folder of incoming || []) {
    if (folder && folder.id && !folderById(folder.id)) {
      folders.push({ ...folder });
      added++;
    }
  }
  // Ordner, deren Elternordner fehlt, nach oben holen
  for (const folder of folders) {
    if (folder.parentId && !folderById(folder.parentId)) folder.parentId = null;
    if (!folder.parentId && !folder.color) folder.color = PALETTE[0];
  }
  if (added) await save(key);
  return added;
}

/** Auswahlfeld mit allen Ordnern füllen. */
export function fillFolderSelect(select, selectedId, { allowNew = false } = {}) {
  const current = selectedId || select.value;
  select.replaceChildren();
  for (const option of folderOptions()) {
    const node = document.createElement('option');
    node.value = option.id;
    node.textContent = option.label;
    select.append(node);
  }
  if (allowNew) {
    const node = document.createElement('option');
    node.value = '__new';
    node.textContent = '+ Neuer Ablageort …';
    select.append(node);
  }
  if (current && folderById(current)) select.value = current;
}

/** Fragt nach einem Namen und legt einen Ordner an (oben oder als Unterordner). */
export async function askAndCreateFolder(key, suggestedParentId = null) {
  const name = prompt('Name des neuen Ablageorts (z. B. „Krankenakte“):');
  if (!name || !name.trim()) return null;
  let parentId = null;
  const parent = suggestedParentId && folderById(suggestedParentId);
  if (parent && confirm(`Als Unterordner von „${folderLabel(parent.id)}“ anlegen?\n\nOK = Unterordner · Abbrechen = eigener Ablageort`)) {
    parentId = parent.id;
  }
  return createFolder(key, name, parentId);
}
